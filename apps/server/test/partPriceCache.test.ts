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

  // pricing-comps feature (T2): comps are recorded regardless of whether a
  // confident price was found (Req 3) — proven for both the priced and
  // null-value branches, since comps is written on every call.
  it('writes comps alongside a priced value', async () => {
    await db.insertPriceCacheEntry('GPU', 'NVIDIA', 'RTX 3080');

    await db.updatePriceCacheEntryValue('GPU', 'NVIDIA', 'RTX 3080', 300, [
      { title: 'RTX 3080 sold', url: 'https://example.com/1', priceUsd: 300, condition: 'used', saleType: 'sold' },
    ]);

    const entry = await db.findPriceCacheEntry('GPU', 'NVIDIA', 'RTX 3080');
    expect(entry?.comps).toEqual([
      { title: 'RTX 3080 sold', url: 'https://example.com/1', priceUsd: 300, condition: 'used', saleType: 'sold' },
    ]);
  });

  it('writes comps even when no confident price was found', async () => {
    await db.insertPriceCacheEntry('Motherboard', 'ASUS', 'ROG STRIX Z790-E');

    await db.updatePriceCacheEntryValue('Motherboard', 'ASUS', 'ROG STRIX Z790-E', null, [
      {
        title: 'ROG STRIX Z790-E listing',
        url: 'https://example.com/2',
        priceUsd: null,
        condition: null,
        saleType: 'listed',
      },
    ]);

    const entry = await db.findPriceCacheEntry('Motherboard', 'ASUS', 'ROG STRIX Z790-E');
    expect(entry?.estimatedResaleValue).toBeNull();
    expect(entry?.comps).toEqual([
      {
        title: 'ROG STRIX Z790-E listing',
        url: 'https://example.com/2',
        priceUsd: null,
        condition: null,
        saleType: 'listed',
      },
    ]);
  });

  it('defaults comps to an empty array when the parameter is omitted', async () => {
    await db.insertPriceCacheEntry('RAM', 'Corsair', 'Vengeance 32GB');

    await db.updatePriceCacheEntryValue('RAM', 'Corsair', 'Vengeance 32GB', 100);

    const entry = await db.findPriceCacheEntry('RAM', 'Corsair', 'Vengeance 32GB');
    expect(entry?.comps).toEqual([]);
  });

  // Req 2: comps are "replaced wholesale on refresh", same lifecycle as
  // the cached price itself — never accumulated across calls. Proven by
  // writing two different single-element comps arrays back to back and
  // asserting the stored value is exactly the second array (length 1,
  // the second comp's own title/url), not a length-2 array containing
  // both. If production code appended instead of overwriting, this
  // would observe a 2-element array and fail.
  it('replaces the previous comps array wholesale on a second call, never appending', async () => {
    await db.insertPriceCacheEntry('Storage', 'WD', 'Black SN850X 1TB');

    await db.updatePriceCacheEntryValue('Storage', 'WD', 'Black SN850X 1TB', 90, [
      { title: 'First comp', url: 'https://example.com/first', priceUsd: 90, condition: 'used', saleType: 'sold' },
    ]);

    await db.updatePriceCacheEntryValue('Storage', 'WD', 'Black SN850X 1TB', 95, [
      { title: 'Second comp', url: 'https://example.com/second', priceUsd: 95, condition: 'new', saleType: 'listed' },
    ]);

    const entry = await db.findPriceCacheEntry('Storage', 'WD', 'Black SN850X 1TB');
    expect(entry?.comps).toEqual([
      { title: 'Second comp', url: 'https://example.com/second', priceUsd: 95, condition: 'new', saleType: 'listed' },
    ]);
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

  // MF-2 regression (Req 13/15's durability guarantee): a non-working
  // part's $1 auto-assignment must survive even when an UNRELATED working
  // Listing's real AI-researched price lands on the exact same
  // (category, brand, partNumber) combo and gets propagated. Before the
  // fix, the UPDATE's WHERE clause matched both rows (both price_source
  // 'auto'), silently overwriting the non-working part's $1 with the
  // working part's real price.
  it("does not overwrite a non-working part's $1 when a different working part on the same combo gets a real price propagated", async () => {
    const nonWorkingSource = await db.createSource({
      name: `Test Source ${Math.random()}`,
      platformType: 'other',
      url: null,
      notes: null,
    });
    const nonWorkingListing = await db.createListing({
      sourceId: nonWorkingSource.id,
      title: 'Non-working Listing',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: new Date().toISOString(),
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: null,
      externalItemId: null,
    });
    const nonWorkingPart = await db.createExpectedPart({
      listingId: nonWorkingListing.id,
      componentCategory: 'GPU',
      brand: 'AMD',
      partNumber: 'RX 6800 XT',
      description: 'Non-working GPU',
      estimatedResaleValue: 1,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
      priceSource: 'auto',
      workingStatus: 'non_working',
    });

    // An unrelated, working part on a DIFFERENT Listing sharing the exact
    // same combo -- the other half of MF-2's named scenario.
    const workingSource = await db.createSource({
      name: `Test Source ${Math.random()}`,
      platformType: 'other',
      url: null,
      notes: null,
    });
    const workingListing = await db.createListing({
      sourceId: workingSource.id,
      title: 'Working Listing',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: new Date().toISOString(),
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: null,
      externalItemId: null,
    });
    const workingPart = await db.createExpectedPart({
      listingId: workingListing.id,
      componentCategory: 'GPU',
      brand: 'AMD',
      partNumber: 'RX 6800 XT',
      description: 'Working GPU',
      estimatedResaleValue: 50,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
      priceSource: 'auto',
      workingStatus: 'working',
    });

    await db.propagateCachedPriceToExpectedParts('GPU', 'AMD', 'RX 6800 XT', 275);

    const nonWorkingAfter = await db.getExpectedPartById(nonWorkingPart.id);
    const workingAfter = await db.getExpectedPartById(workingPart.id);

    // The working part legitimately receives the real researched price...
    expect(workingAfter?.estimatedResaleValue).toBe(275);
    // ...but the non-working part's $1 override must survive untouched.
    expect(nonWorkingAfter?.estimatedResaleValue).toBe(1);
  });
});
