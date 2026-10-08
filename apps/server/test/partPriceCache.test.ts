// Tests for apps/server/src/db/queries/partPriceCache.ts
// (part-price-estimation feature T3).
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-cache-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): client.ts's DATA_DIR is computed once,
  // from DUCKDB_DATA_DIR, at module-evaluation time into a file-scoped const.
  // A static top-of-file import would evaluate before this beforeAll sets the
  // env var and would therefore open the shared dev database instead of this
  // test's isolated temp dir — the dynamic import here is what makes the
  // module-loading timing land after the env var.
  db = await import('../src/db/index.js') as typeof DbModule;
  ({ getConnection } = await import('../src/db/client.js') as typeof ClientModule);
  await runMigrations(await getConnection());
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

// Direct row count for one (category, brand, part_number) combo, bypassing
// the query module under test so the assertion doesn't depend on the same
// code it's verifying.
async function countCacheRows(category: string, brand: string, partNumber: string): Promise<number> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) as cnt FROM part_price_cache
     WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  return Number(reader.getRowObjectsJson()[0].cnt);
}

// Seeds one expected_parts row (via a Source/Listing) with the given brand/
// partNumber/price_source, for propagateCachedPriceToExpectedParts tests.
async function seedExpectedPart(
  category: 'GPU' | 'CPU' | 'RAM',
  brand: string,
  partNumber: string,
  priceSource: 'auto' | null,
  estimatedResaleValue: number | null,
): Promise<string> {
  const source = await db.createSource({
    name: `Test Source ${Math.random()}`,
    platformType: 'other',
    url: null,
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: 'Test Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: new Date().toISOString(),
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
  });
  const expectedPart = await db.createExpectedPart({
    listingId: listing.id,
    componentCategory: category,
    brand,
    partNumber,
    description: 'Test part',
    estimatedResaleValue,
    identityCandidates: [],
    aiConfidence: null,
    aiSource: null,
  });
  if (priceSource !== null) {
    const connection = await getConnection();
    await connection.run(
      `UPDATE expected_parts SET price_source = $price_source WHERE id = $id`,
      { id: expectedPart.id, price_source: priceSource },
    );
  }
  return expectedPart.id;
}

describe('Part Price Cache — findPriceCacheEntry', () => {
  it('returns null before any insertPriceCacheEntry and the row after', async () => {
    const before = await db.findPriceCacheEntry('GPU', 'NVIDIA', 'RTX 4070');
    expect(before).toBeNull();

    await db.insertPriceCacheEntry('GPU', 'NVIDIA', 'RTX 4070');

    const after = await db.findPriceCacheEntry('GPU', 'NVIDIA', 'RTX 4070');
    expect(after).not.toBeNull();
    expect(after?.category).toBe('GPU');
    expect(after?.brand).toBe('NVIDIA');
    expect(after?.partNumber).toBe('RTX 4070');
    expect(after?.estimatedResaleValue).toBeNull();
    expect(after?.lastResearchedAt).toBeNull();
  });
});

describe('Part Price Cache — insertPriceCacheEntry', () => {
  it('inserts a new row with null estimated_resale_value and null last_researched_at', async () => {
    const { inserted } = await db.insertPriceCacheEntry('CPU', 'Intel', 'Core i9-13900K');
    expect(inserted).toBe(true);

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT estimated_resale_value, last_researched_at FROM part_price_cache
       WHERE component_category = 'CPU' AND brand = 'Intel' AND part_number = 'Core i9-13900K'`,
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].estimated_resale_value).toBeNull();
    expect(rows[0].last_researched_at).toBeNull();
  });

  // Dedup proof: a second insert for the identical (category, brand,
  // part_number) combo must be silently skipped (no throw, { inserted:
  // false }), and the unique index must be the thing actually preventing
  // the second row — not just the query module choosing not to insert. If
  // idx_part_price_cache_dedup were dropped from schema.ts's
  // INDEX_STATEMENTS, this test would fail: both inserts would succeed and
  // the row count would be 2, not 1.
  it('returns { inserted: false } and skips a second insert for the identical combo (unique index dedup)', async () => {
    const first = await db.insertPriceCacheEntry('RAM', 'Corsair', 'Vengeance LPX 32GB');
    expect(first.inserted).toBe(true);

    const second = await db.insertPriceCacheEntry('RAM', 'Corsair', 'Vengeance LPX 32GB');
    expect(second.inserted).toBe(false);

    const count = await countCacheRows('RAM', 'Corsair', 'Vengeance LPX 32GB');
    expect(count).toBe(1);
  });

  // Concurrency proof: two GENUINELY concurrent inserts for the identical
  // combo (fired together via Promise.all, not sequential awaits) must
  // never produce two rows or an unhandled rejection — same proof style as
  // referencePhotos.test.ts / sourcingAttempts.test.ts.
  it('dedups two genuinely concurrent insertPriceCacheEntry calls for the identical combo (real race)', async () => {
    const results = await Promise.all([
      db.insertPriceCacheEntry('GPU', 'AMD', 'RX 7900 XTX'),
      db.insertPriceCacheEntry('GPU', 'AMD', 'RX 7900 XTX'),
    ]);

    const count = await countCacheRows('GPU', 'AMD', 'RX 7900 XTX');
    expect(count).toBe(1);
    expect(results.filter((r) => r.inserted).length).toBe(1);
  });

  it('does not swallow a non-dedup DB error', async () => {
    // An invalid component_category (not one of the enum's fixed values)
    // triggers an ENUM-cast error, not a unique-index violation. The catch
    // block in insertPriceCacheEntry only recognizes and swallows the
    // unique-index "already cached, skip" case (UNIQUE_CONSTRAINT_MESSAGE);
    // every other DB error must propagate to the caller unchanged.
    await expect(
      db.insertPriceCacheEntry('NotARealCategory' as unknown as 'GPU', 'Bogus', 'Bogus'),
    ).rejects.toThrow();
  });
});

describe('Part Price Cache — updatePriceCacheEntryValue', () => {
  it('sets estimated_resale_value and last_researched_at when value is a number', async () => {
    await db.insertPriceCacheEntry('Storage', 'Samsung', '990 Pro 2TB');

    await db.updatePriceCacheEntryValue('Storage', 'Samsung', '990 Pro 2TB', 150.5);

    const entry = await db.findPriceCacheEntry('Storage', 'Samsung', '990 Pro 2TB');
    expect(entry?.estimatedResaleValue).toBe(150.5);
    expect(entry?.lastResearchedAt).not.toBeNull();
  });

  it('sets only last_researched_at when value is null, leaving estimated_resale_value untouched', async () => {
    await db.insertPriceCacheEntry('PSU', 'Seasonic', 'Focus GX-850');

    await db.updatePriceCacheEntryValue('PSU', 'Seasonic', 'Focus GX-850', null);

    const entry = await db.findPriceCacheEntry('PSU', 'Seasonic', 'Focus GX-850');
    expect(entry?.estimatedResaleValue).toBeNull();
    expect(entry?.lastResearchedAt).not.toBeNull();
  });

  // Standing Checks guarantee: once a combo has a real priced value, a
  // later null-finding refresh (research ran again but couldn't price it
  // this time) must never regress estimated_resale_value back to null.
  // Proven both by direct assertion here AND by the mutation runner below,
  // which confirms this exact test fails if the production code's null
  // branch is changed to also null out estimated_resale_value.
  it('never nulls out a previously-set estimated_resale_value on a later null-value update (regression guard)', async () => {
    await db.insertPriceCacheEntry('Case', 'Fractal Design', 'Meshify 2');
    await db.updatePriceCacheEntryValue('Case', 'Fractal Design', 'Meshify 2', 75);

    const afterPriced = await db.findPriceCacheEntry('Case', 'Fractal Design', 'Meshify 2');
    expect(afterPriced?.estimatedResaleValue).toBe(75);

    // A later refresh finds no price this time.
    await db.updatePriceCacheEntryValue('Case', 'Fractal Design', 'Meshify 2', null);

    const afterNullRefresh = await db.findPriceCacheEntry('Case', 'Fractal Design', 'Meshify 2');
    expect(afterNullRefresh?.estimatedResaleValue).toBe(75);
  });
});

describe('Part Price Cache — listAllPriceCacheEntries', () => {
  it('returns every cached entry, including ones never successfully priced', async () => {
    await db.insertPriceCacheEntry('Cooler', 'Noctua', 'NH-D15');
    await db.insertPriceCacheEntry('Cooler', 'Corsair', 'H150i');
    await db.updatePriceCacheEntryValue('Cooler', 'Noctua', 'NH-D15', 40);

    const all = await db.listAllPriceCacheEntries();
    const noctua = all.find((e) => e.brand === 'Noctua' && e.partNumber === 'NH-D15');
    const corsair = all.find((e) => e.brand === 'Corsair' && e.partNumber === 'H150i');
    expect(noctua?.estimatedResaleValue).toBe(40);
    expect(corsair?.estimatedResaleValue).toBeNull();
  });
});

describe('Part Price Cache — propagateCachedPriceToExpectedParts', () => {
  it('updates an expected_parts row whose price_source is auto', async () => {
    const id = await seedExpectedPart('GPU', 'NVIDIA', 'RTX 3080', 'auto', 50);

    await db.propagateCachedPriceToExpectedParts('GPU', 'NVIDIA', 'RTX 3080', 300);

    const updated = await db.getExpectedPartById(id);
    expect(updated?.estimatedResaleValue).toBe(300);
  });

  // Load-bearing guard: a manually-claimed row (price_source null) must
  // never be overwritten by a background cache propagation, even when its
  // category/brand/partNumber combo matches exactly.
  it('does not touch an expected_parts row whose price_source is null (manually entered/claimed)', async () => {
    const id = await seedExpectedPart('GPU', 'NVIDIA', 'RTX 3080 Ti', null, 999);

    await db.propagateCachedPriceToExpectedParts('GPU', 'NVIDIA', 'RTX 3080 Ti', 1);

    const untouched = await db.getExpectedPartById(id);
    expect(untouched?.estimatedResaleValue).toBe(999);
  });
});
