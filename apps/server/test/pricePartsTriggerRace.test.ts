// T4 standing-check proof, in-process half: two genuinely racing writers
// hitting the SAME (component_category, brand, part_number) for the first
// time never leave two cache rows, two duplicate background jobs, or a
// crash behind (Req 13).
//
// Unlike pricePartsTrigger.test.ts — which mocks the db/index.js barrel and
// therefore proves only the decision shape, with every "await" resolving
// instantly and no real interleaving — this suite runs the REAL
// jobs/pricePartsTrigger.ts against a REAL isolated DuckDB file and fires
// the racing calls through Promise.all, the same genuine-concurrency
// pattern concurrency.test.ts and identifyPartsConcurrency.test.ts use at
// the HTTP layer. The point is the interleaving: resolveCombo's cache read,
// insert, job check and enqueue are four separate statements, so two
// writers that enter it together can each observe the pre-race state and
// both act on it.
//
// The writers modelled here are the two Listing saves Req 13 names first.
// Req 13's other pair — a save landing on top of the daily refresh sweep —
// is deliberately NOT a test in this file: the save path only ever reaches
// its enqueue on a cache MISS, and the sweep only ever visits combos that
// are already IN the cache, so any test that sets both up far enough to run
// them together leaves the save short-circuiting at "the row already
// exists, research is someone else's" and never reaching the gate the test
// would claim to be guarding. One was written here, and a mutation that
// deleted the sweep's own dedup gate outright did not make it fail
// (SURVIVED) — it asserted nothing. The window in which that pair really
// can collide (the sweep's snapshot catching a row between a save's insert
// and that same save's enqueue) is the same unguarded check-then-act the
// two tests below already expose deterministically. The HTTP-level variant
// — two real concurrent POST /api/listings requests — lives in
// pricePartsConcurrency.test.ts.
import type * as ClientModule from '../src/db/client.js';
import type * as TriggerModule from '../src/jobs/pricePartsTrigger.js';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ExpectedPart } from '../src/db/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let getConnection: typeof ClientModule.getConnection;
let triggerPriceLookups: typeof TriggerModule.triggerPriceLookups;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-trigger-race-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import), same reason pricePartsJobs.test.ts
  // gives: client.ts resolves DUCKDB_DATA_DIR once at module-evaluation
  // time, so every module that transitively imports it has to be loaded
  // after the env var above is set — including the trigger, which reaches
  // the database through that same singleton.
  ({ getConnection } = (await import('../src/db/client.js')) as typeof ClientModule);
  await runMigrations(await getConnection());
  ({ triggerPriceLookups } = (await import('../src/jobs/pricePartsTrigger.js')) as typeof TriggerModule);
}, 60_000);

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

// Each test owns a distinct part number so one test's cache row and jobs
// can never be counted as another's — the counts below are the whole proof.
let partCounter = 0;
function uniquePartNumber(): string {
  partCounter += 1;
  return `RACE-${partCounter}`;
}

/** An Expected Part as the write paths hand it to the trigger; only category/brand/partNumber/estimatedResaleValue are read. */
function partFixture(partNumber: string, overrides: Partial<ExpectedPart> = {}): ExpectedPart {
  return {
    id: `part-${partNumber}`,
    listingId: `listing-${partNumber}`,
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber,
    description: 'Pulled from the tower',
    estimatedResaleValue: null,
    identityCandidates: [],
    aiConfidence: 'high',
    aiSource: 'text',
    priceSource: 'auto',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Raw row reads, deliberately not going through the query modules the code
// under test uses, so a bug in those can't hide itself from these counts.
async function cacheRows(partNumber: string): Promise<Record<string, unknown>[]> {
  const connection: DuckDBConnection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT id, estimated_resale_value FROM part_price_cache WHERE part_number = $part_number`,
    { part_number: partNumber },
  );
  return reader.getRowObjectsJson();
}

async function jobRows(partNumber: string): Promise<Record<string, unknown>[]> {
  const connection: DuckDBConnection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT id, stage FROM price_parts_jobs WHERE part_number = $part_number`,
    { part_number: partNumber },
  );
  return reader.getRowObjectsJson();
}

describe('triggerPriceLookups under genuine concurrency (Req 13)', () => {
  it('two racing first encounters of one combo leave exactly one cache row and one job', async () => {
    const partNumber = uniquePartNumber();

    // Promise.all, not two awaits in sequence: both calls are started before
    // either has finished its cache read, which is the only state in which
    // the duplicate this test rules out can be produced at all.
    await Promise.all([
      triggerPriceLookups([partFixture(partNumber, { id: 'save-a', listingId: 'listing-a' })]),
      triggerPriceLookups([partFixture(partNumber, { id: 'save-b', listingId: 'listing-b' })]),
    ]);

    expect(await cacheRows(partNumber)).toHaveLength(1);
    expect(await jobRows(partNumber)).toHaveLength(1);
  }, 30_000);

  it('eight racing first encounters of one combo still leave exactly one cache row and one job', async () => {
    const partNumber = uniquePartNumber();

    await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        triggerPriceLookups([partFixture(partNumber, { id: `save-${i}`, listingId: `listing-${i}` })]),
      ),
    );

    expect(await cacheRows(partNumber)).toHaveLength(1);
    expect(await jobRows(partNumber)).toHaveLength(1);
  }, 30_000);
});
