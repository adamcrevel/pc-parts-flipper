// T13 proof for assumption A23's cross-Listing claim (Req 6, 7, 14, 15):
// a user-owned ('manual') Expected Part with no price of its own still
// seeds and refreshes the *shared* part_price_cache entry for its combo —
// that work benefits every other Listing holding the same part — while
// `propagateCachedPriceToExpectedParts`'s `WHERE price_source = 'auto'`
// keeps the researched figure off the user's own row forever.
//
// A23's two halves are proven separately, because they can fail
// independently:
//   1. saving Listing A (one 'manual', unpriced row) leaves a cache row
//      *and* a queued research job behind for the combo — if
//      pricePartsTrigger's eligibility filter ever started skipping
//      'manual' rows, the combo would go unresearched for everyone;
//   2. once that combo has a price, Listing B's 'auto' row for the same
//      combo receives it on save while Listing A's 'manual' row stays null
//      — if the propagation's price_source clause ever went away, the
//      user's deliberate deletion would be silently undone.
//
// Runs against the real server (helpers.ts's spawn-based fixture, the same
// one priceSourceRoute.test.ts uses) so what is proven is the whole chain:
// request validation, the route's own 'auto'/'manual' decision, the
// trigger, the cache row, the job queue and the propagating UPDATE.
//
// IDENTIFY_PARTS_POOL_SIZE=0 and PRICE_PARTS_POOL_SIZE=0 keep both worker
// pools from claiming anything and invoking the real `omp` binary, so the
// job Listing A enqueues simply sits queued and the "research completed"
// step is simulated with raw SQL instead — a real AI call has no place in
// a deterministic test.
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Unique port so this suite can run alongside every other server-spawning
// suite (highest currently in use is pricePartsConcurrency.test.ts's
// 34_641) without a collision.
const TEST_PORT = 34_650;

// The single (category, brand, part number) combo both Listings share.
const SHARED_CATEGORY = 'GPU';
const SHARED_BRAND = 'EVGA';
const SHARED_PART = 'XLC-CROSS-LISTING';

interface SourceResponse {
  id: string;
}

function listingBody(sourceId: string, title: string, expectedParts: CreateListingInput['expectedParts']): CreateListingInput {
  return {
    sourceId,
    title,
    description: null,
    listingUrl: `https://example.com/listing/${encodeURIComponent(title)}`,
    askingPrice: 250,
    listingDate: '2026-03-01',
    acquisitionFees: 0,
    expectedParts,
  };
}

describe('cross-Listing price sharing with a user-owned row (A23, Req 6/7/14/15)', () => {
  let server: TestServer;
  let sourceId: string;
  // The suite owns its DuckDB directory (rather than letting the helper
  // create and delete one) because the middle test below reads and writes
  // the file directly, which means stopping the server first: DuckDB holds
  // an exclusive lock on the file while the server process has it open.
  let dataDir: string;
  let serverRunning = false;
  let listingAId: string;

  // Boots the server against this suite's own data directory and
  // (re-)creates the Source every Listing below hangs off. Called once up
  // front and again after the middle test's direct DB access, which has to
  // close the server to take the file lock.
  async function startServer(): Promise<void> {
    server = await startTestServer(TEST_PORT, { IDENTIFY_PARTS_POOL_SIZE: '0', PRICE_PARTS_POOL_SIZE: '0', DUCKDB_DATA_DIR: dataDir });
    serverRunning = true;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-cross-listing-'));
    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): client.ts resolves DUCKDB_DATA_DIR
    // once at module-evaluation time, so it has to be loaded after the env
    // var points at this suite's directory — the same reason
    // priceSourceRoute.test.ts imports it this way.
    const { getConnection, closeConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
    await runMigrations(await getConnection());
    // Single-writer rule (client.ts's own module doc): this connection must
    // be closed before the server process opens the same file.
    await closeConnection();

    await startServer();
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Cross-listing price sharing source',
      platformType: 'ebay',
      url: 'https://example.com/cross-listing',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 120_000);

  afterAll(async () => {
    if (serverRunning) {
      await server.stop();
    }
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  // A23, half 1 (the write): the only row this Listing holds for the combo
  // is user-owned and unpriced — the state a user lands in by deleting an
  // auto-filled price. The row itself must stay 'manual' with no value.
  it('stores Listing A\'s user-owned row verbatim: manual, no price', async () => {
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, 'Cross-listing A (user-owned price)', [
        {
          componentCategory: SHARED_CATEGORY,
          brand: SHARED_BRAND,
          partNumber: SHARED_PART,
          description: 'Card, price deleted by the user',
          estimatedResaleValue: null,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
          priceSource: 'manual',
        },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    listingAId = created.body.id;
    expect(created.body.expectedParts[0].priceSource).toBe('manual');
    expect(created.body.expectedParts[0].estimatedResaleValue).toBeNull();

    // Re-fetched, not echoed: the response body is built from the rows as
    // inserted, while triggerPriceLookups runs afterwards inside the same
    // request, so only a fresh read proves the trigger left this row alone.
    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingAId}`);
    expect(fetched.body.expectedParts[0].priceSource).toBe('manual');
    expect(fetched.body.expectedParts[0].estimatedResaleValue).toBeNull();
  });

  /**
   * A23, half 1 (the shared effect), and the reason pricePartsTrigger's
   * eligibility filter deliberately ignores `price_source`: Listing A's
   * save must still have seeded the shared cache row (Req 6, 9) and queued
   * the research job (Req 5) for the combo, even though the only row that
   * triggered it belongs to the user and will never receive the result.
   * That research is for every *other* Listing holding this part.
   *
   * Proven by reading the server's own DuckDB file, which means stopping
   * the server first (exclusive file lock). The same connection then
   * simulates the research completing — the worker pool is disabled here,
   * and a real `omp` call has no place in a deterministic test — before the
   * server is restarted for the final test.
   */
  it('still seeds the shared cache row and queues research for the combo (A23, Req 5/6/9)', async () => {
    await server.stop();
    serverRunning = false;

    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): same module-evaluation-time reason
    // as beforeAll above.
    const { getConnection, closeConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
    const connection = await getConnection();

    const cache = await connection.runAndReadAll(
      `SELECT estimated_resale_value FROM part_price_cache
       WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
      { category: SHARED_CATEGORY, brand: SHARED_BRAND, part_number: SHARED_PART },
    );
    const cacheRows = cache.getRowObjectsJson();
    expect(cacheRows, 'Listing A\'s save should have seeded exactly one shared cache row').toHaveLength(1);
    expect(cacheRows[0].estimated_resale_value, 'the seeded row is unpriced until research runs').toBeNull();

    const jobs = await connection.runAndReadAll(
      `SELECT stage FROM price_parts_jobs
       WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
      { category: SHARED_CATEGORY, brand: SHARED_BRAND, part_number: SHARED_PART },
    );
    const jobRows = jobs.getRowObjectsJson();
    expect(jobRows, 'Listing A\'s save should have queued exactly one research job').toHaveLength(1);
    expect(jobRows[0].stage, 'research is queued, never run inside the request (Req 5)').toBe('queued');

    // Research completes, the way the price worker pool would finish it:
    // the cache entry gains a value, the job reaches a terminal stage. 412
    // appears in no request body this suite sends, so it can only ever
    // reach an Expected Part via the cache propagation.
    await connection.run(
      `UPDATE part_price_cache SET estimated_resale_value = 412, last_researched_at = current_timestamp
       WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
      { category: SHARED_CATEGORY, brand: SHARED_BRAND, part_number: SHARED_PART },
    );
    await connection.run(
      `UPDATE price_parts_jobs SET stage = 'completed'
       WHERE component_category = $category AND brand = $brand AND part_number = $part_number`,
      { category: SHARED_CATEGORY, brand: SHARED_BRAND, part_number: SHARED_PART },
    );
    await closeConnection();

    await startServer();
  }, 150_000);

  // A23, half 2: the payoff and its limit, in one save. Listing B's row for
  // the same combo is undecided on the wire, so the route claims it for the
  // pipeline and the cached price lands on it immediately (Req 7) — while
  // Listing A's 'manual' row for that same combo, which the very same
  // propagating UPDATE passes over, keeps the empty value the user chose
  // (Req 14/15).
  it('gives the cached price to Listing B\'s auto row and never to Listing A\'s manual one', async () => {
    const createdB = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, 'Cross-listing B (pipeline-owned price)', [
        {
          componentCategory: SHARED_CATEGORY,
          brand: SHARED_BRAND,
          partNumber: SHARED_PART,
          description: 'Same card, untouched by the user',
          estimatedResaleValue: null,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
        },
      ]),
    );

    expect(createdB.status, `create failed: ${JSON.stringify(createdB.body)}`).toBe(201);
    expect(createdB.body.expectedParts[0].priceSource).toBe('auto');

    // Re-fetched: the propagation runs after the response body is built.
    const fetchedB = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${createdB.body.id}`);
    expect(fetchedB.body.expectedParts[0].estimatedResaleValue, 'Listing B should have received the cached price').toBe(412);
    expect(fetchedB.body.expectedParts[0].priceSource).toBe('auto');

    const fetchedA = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingAId}`);
    expect(fetchedA.body.expectedParts[0].estimatedResaleValue, 'Listing A\'s user-owned row must stay empty').toBeNull();
    expect(fetchedA.body.expectedParts[0].priceSource).toBe('manual');
  }, 30_000);
});
