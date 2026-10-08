// TE12 proof: `triggerPriceLookups` (apps/server/src/jobs/pricePartsTrigger.ts)
// driven against a REAL, unmocked DuckDB file — unlike pricePartsTrigger.test.ts,
// which mocks the db/index.js barrel to isolate the decision logic, this suite
// exists specifically to prove the real SQL in
// propagateCachedPriceToExpectedParts (apps/server/src/db/queries/partPriceCache.ts)
// actually enforces the `price_source = 'auto'` guard end to end, through the
// trigger's own public entry point rather than by calling that query function
// directly.
//
// Scenario (R12's own finding, and A22/A23's three-state price_source model):
// two Expected Parts on two DIFFERENT Listings share one
// (category, brand, partNumber) combo. One row (`price_source: 'manual'`) is
// a user who explicitly cleared a previously auto-priced value — per A22
// this is a permanent, distinct claim, not the same as null's "undecided".
// The other row (`price_source: 'auto'`) is still pipeline-owned. Both rows
// have a null estimatedResaleValue, so both pass triggerPriceLookups' own
// node-B eligibility filter (brand + partNumber present, value still null —
// that filter does not itself look at price_source at all) and both resolve
// to the same combo. A cached, non-null price for that combo must propagate
// onto the 'auto' row and must never reach the 'manual' row — proving the
// manual row's protection survives even after re-entering the trigger.
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as TriggerModule from '../src/jobs/pricePartsTrigger.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const CATEGORY = 'GPU';
const BRAND = 'NVIDIA';
const PART_NUMBER = 'RTX 4090 Cross-Listing';
const CACHED_VALUE = 777;

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;
let triggerPriceLookups: typeof TriggerModule.triggerPriceLookups;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-cross-listing-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): same timing constraint as
  // partPriceCache.test.ts's own beforeAll — client.ts's DATA_DIR constant
  // is computed once, from DUCKDB_DATA_DIR, at module-evaluation time, for
  // every module in this chain (db/index.js, db/client.js, and
  // jobs/pricePartsTrigger.js, which imports db/index.js itself). A
  // static top-of-file import of any of the three would evaluate before
  // this beforeAll sets the env var and would open the shared dev database
  // instead of this test's isolated temp dir.
  db = (await import('../src/db/index.js')) as typeof DbModule;
  ({ getConnection } = (await import('../src/db/client.js')) as typeof ClientModule);
  ({ triggerPriceLookups } = (await import('../src/jobs/pricePartsTrigger.js')) as typeof TriggerModule);
  await runMigrations(await getConnection());
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

/** Creates one Source + Listing + Expected Part, with the given price_source set directly on insert (the three-state field now accepts it as a first-class CreateExpectedPartInput value — no post-insert UPDATE needed). */
async function seedPart(priceSource: 'auto' | 'manual' | null): Promise<string> {
  const source = await db.createSource({
    name: `Cross-listing source ${Math.random()}`,
    platformType: 'other',
    url: null,
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: `Cross-listing test (${priceSource ?? 'undecided'})`,
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: new Date().toISOString(),
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
  });
  const part = await db.createExpectedPart({
    listingId: listing.id,
    componentCategory: CATEGORY,
    brand: BRAND,
    partNumber: PART_NUMBER,
    description: 'Cross-listing test part',
    estimatedResaleValue: null,
    identityCandidates: [],
    aiConfidence: null,
    aiSource: null,
    priceSource,
  });
  return part.id;
}

describe('triggerPriceLookups — a cache hit never overwrites a manual row on another Listing (A22, R12)', () => {
  let manualPartId: string;
  let autoPartId: string;

  beforeAll(async () => {
    manualPartId = await seedPart('manual');
    autoPartId = await seedPart('auto');

    // Seed part_price_cache directly with a non-null value, driving node D
    // (cache hit with a value present) the next time this combo is
    // resolved — no worker pool or AI call involved.
    const connection = await getConnection();
    await connection.run(
      `INSERT INTO part_price_cache (id, component_category, brand, part_number, estimated_resale_value, last_researched_at)
       VALUES (gen_random_uuid(), $category, $brand, $part_number, $value, current_timestamp)`,
      { category: CATEGORY, brand: BRAND, part_number: PART_NUMBER, value: CACHED_VALUE },
    );

    const manualPart = await db.getExpectedPartById(manualPartId);
    const autoPart = await db.getExpectedPartById(autoPartId);
    if (manualPart === null || autoPart === null) {
      throw new Error('seeded Expected Parts not found');
    }

    // Drive both rows through the real, unmocked trigger in one call — both
    // are eligible (brand+partNumber present, value still null) and
    // de-duplicate to the same combo.
    await triggerPriceLookups([manualPart, autoPart]);
  });

  it("never writes the cached value onto the user-cleared 'manual' row", async () => {
    const manualPart = await db.getExpectedPartById(manualPartId);
    expect(manualPart?.estimatedResaleValue).toBeNull();
  });

  it("writes the cached value onto the 'auto' row on the other Listing", async () => {
    const autoPart = await db.getExpectedPartById(autoPartId);
    expect(autoPart?.estimatedResaleValue).toBe(CACHED_VALUE);
  });
});
