// T4 proof: `price_source` threaded end to end through the Listing write
// paths (part-price-estimation feature, Req 14-15), updated by T13 for the
// three-state field (assumption A22, correcting A8): null = undecided,
// 'auto' = the background pipeline owns the price, 'manual' = the user
// does. Runs against the real server (helpers.ts's spawn-based fixture,
// same as listings.test.ts) so what is proven is the whole chain — request
// validation, the route's own 'auto' decision, the INSERT, and the column
// coming back out on GET — rather than any one layer's in-memory behaviour.
//
// IDENTIFY_PARTS_POOL_SIZE=0 and PRICE_PARTS_POOL_SIZE=0 keep both worker
// pools from claiming anything and invoking the real `omp` binary (same
// reason identifyPartsRoute.test.ts sets the first), so every job these
// writes enqueue simply sits queued — exactly what these assertions want.
import type { DuckDBConnection } from '@duckdb/node-api';
import type { CreateListingInput, ExpectedPart, ListingDetail } from '@pc-parts-flipper/shared';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { getJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Unique port so this suite can run alongside every other server-spawning
// suite (highest currently in use is 34_635) without a collision.
const TEST_PORT = 34_640;

// The combo the "user clears an auto-priced value" regression owns. Its
// cache row is seeded with a researched value before the server boots, so
// the only thing that can ever put that number on an Expected Part is the
// cache propagation — never this suite's own request bodies.
const CLEARED_AUTO_PART = 'PS-CLEARED-AUTO';
const CLEARED_AUTO_CACHED_VALUE = 275;

interface SourceResponse {
  id: string;
}

interface ErrorResponse {
  error: { message: string; statusCode: number };
}

// PUTs `body` as JSON to `url`. helpers.ts has no PUT wrapper (see
// listings.test.ts's identical local copy and its note on why).
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

function listingBody(sourceId: string, expectedParts: CreateListingInput['expectedParts']): CreateListingInput {
  return {
    sourceId,
    title: 'Price source threading rig',
    description: null,
    listingUrl: 'https://example.com/listing/price-source',
    askingPrice: 200,
    listingDate: '2026-02-01',
    acquisitionFees: 0,
    expectedParts,
  };
}

// Named part numbers per test keep the price-cache/job rows these writes
// create from one test being read by another.
let partCounter = 0;
function uniquePartNumber(): string {
  partCounter += 1;
  return `PS-TEST-${partCounter}`;
}

describe('price_source threading through the Listing write paths (T4)', () => {
  let server: TestServer;
  let sourceId: string;
  // The suite owns its DuckDB directory (rather than letting the helper
  // create and delete one) because the last test below reads the file
  // directly after shutting the server down — see its own comment.
  let dataDir: string;
  let serverStopped = false;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-source-'));
    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): client.ts resolves DUCKDB_DATA_DIR
    // once at module-evaluation time, so it has to be loaded after the env
    // var points at this suite's directory — the same reason
    // pricePartsConcurrency.test.ts imports it this way.
    const { getConnection, closeConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
    const seedConnection = await getConnection();
    await runMigrations(seedConnection);
    // Written with raw SQL rather than through partPriceCache.ts so this
    // fixture does not depend on the code the assertions judge.
    await seedConnection.run(
      `INSERT INTO part_price_cache (id, component_category, brand, part_number, estimated_resale_value, last_researched_at)
       VALUES (gen_random_uuid(), 'GPU', 'NVIDIA', $part_number, $value, current_timestamp)`,
      { part_number: CLEARED_AUTO_PART, value: CLEARED_AUTO_CACHED_VALUE },
    );
    // Single-writer rule (client.ts's own module doc): this connection must
    // be closed before the server process opens the same file.
    await closeConnection();

    server = await startTestServer(TEST_PORT, { IDENTIFY_PARTS_POOL_SIZE: '0', PRICE_PARTS_POOL_SIZE: '0', DUCKDB_DATA_DIR: dataDir });
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Price Source Test Source',
      platformType: 'ebay',
      url: 'https://example.com/price-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 95_000);

  afterAll(async () => {
    if (!serverStopped) {
      await server.stop();
    }
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('claims a fully-identified, unpriced part for the pipeline (priceSource auto) and persists it', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'GPU', brand: 'NVIDIA', partNumber, description: 'Card', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].priceSource).toBe('auto');

    // Re-fetched, not just echoed: proves the column was actually written.
    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.expectedParts[0].priceSource).toBe('auto');
  });

  // Req 14: a figure the user typed is theirs. Claiming it for the pipeline
  // would let a later cache refresh overwrite it.
  it('leaves a part the user already priced unclaimed (priceSource null)', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'GPU', brand: 'NVIDIA', partNumber, description: 'Card', estimatedResaleValue: 310, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].priceSource).toBeNull();
  });

  it('leaves a half-identified part unclaimed, since it can never be researched', async () => {
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'Storage', brand: 'Samsung', partNumber: null, description: '512GB NVMe', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null },
        { componentCategory: 'RAM', brand: null, partNumber: 'DDR4-3200', description: '16GB', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );

    expect(created.status).toBe(201);
    expect(created.body.expectedParts.every((part) => part.priceSource === null)).toBe(true);
  });

  // Req 14 across a resave. The editor sends back whatever priceSource the
  // row currently holds unless the user edited it, so an auto row that has
  // since been given its researched value must stay auto — recomputing from
  // "has a price now" alone would silently hand it back to the user and
  // stop every future refresh from reaching it.
  it('keeps priceSource auto on a resave of an auto row that has since been priced', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'CPU', brand: 'Intel', partNumber, description: 'Chip', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );
    expect(created.body.expectedParts[0].priceSource).toBe('auto');

    const resaved = await putJson<ListingDetail>(
      `${server.baseUrl}/api/listings/${created.body.id}`,
      listingBody(sourceId, [
        { componentCategory: 'CPU', brand: 'Intel', partNumber, description: 'Chip', estimatedResaleValue: 180, identityCandidates: [], aiConfidence: null, aiSource: null, priceSource: 'auto' },
      ]),
    );

    expect(resaved.status, `update failed: ${JSON.stringify(resaved.body)}`).toBe(200);
    expect(resaved.body.expectedParts[0].priceSource).toBe('auto');
    expect(resaved.body.expectedParts[0].estimatedResaleValue).toBe(180);
  });

  // Req 15: the editor clears priceSource the moment the user touches a
  // row, and the server must take that clearing at face value.
  it('keeps priceSource null on a resave of a row the user has claimed', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'CPU', brand: 'Intel', partNumber, description: 'Chip', estimatedResaleValue: 95, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );

    const resaved = await putJson<ListingDetail>(
      `${server.baseUrl}/api/listings/${created.body.id}`,
      listingBody(sourceId, [
        { componentCategory: 'CPU', brand: 'Intel', partNumber, description: 'Chip, lid scuffed', estimatedResaleValue: 95, identityCandidates: [], aiConfidence: null, aiSource: null, priceSource: null },
      ]),
    );

    expect(resaved.status).toBe(200);
    expect(resaved.body.expectedParts[0].priceSource).toBeNull();
  });

  // THE regression this three-state field exists for (Req 14/15, assumption
  // A22). A row the pipeline auto-priced from the shared cache, whose value
  // the user then deletes, comes back from the editor as brand + partNumber
  // present, estimatedResaleValue null, priceSource 'manual'. On the old
  // two-value field that was indistinguishable from a never-claimed row: the
  // route re-claimed it as 'auto', and triggerPriceLookups then wrote the
  // still-cached value straight back onto it inside the same request,
  // silently undoing the deletion the user had just made.
  it('never re-populates a cleared auto-priced value from the cache (Req 14/15)', async () => {
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'GPU', brand: 'NVIDIA', partNumber: CLEARED_AUTO_PART, description: 'Card', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].priceSource).toBe('auto');

    // The pre-seeded cache value lands on the row during that same save, so
    // what follows is a genuinely auto-priced row, not a hypothetical one.
    const priced = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(priced.body.expectedParts[0].estimatedResaleValue).toBe(CLEARED_AUTO_CACHED_VALUE);
    expect(priced.body.expectedParts[0].priceSource).toBe('auto');

    // The user deletes that price. The editor hands ownership over with it.
    const cleared = await putJson<ListingDetail>(
      `${server.baseUrl}/api/listings/${created.body.id}`,
      listingBody(sourceId, [
        { componentCategory: 'GPU', brand: 'NVIDIA', partNumber: CLEARED_AUTO_PART, description: 'Card', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null, priceSource: 'manual' },
      ]),
    );
    expect(cleared.status, `update failed: ${JSON.stringify(cleared.body)}`).toBe(200);
    expect(cleared.body.expectedParts[0].priceSource).toBe('manual');
    expect(cleared.body.expectedParts[0].estimatedResaleValue).toBeNull();

    // Re-fetched, not echoed: the response body is built from the rows as
    // inserted, while the cache propagation runs afterwards in the same
    // request, so only a fresh read can prove it left this row alone.
    const refetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(refetched.body.expectedParts[0].priceSource).toBe('manual');
    expect(refetched.body.expectedParts[0].estimatedResaleValue).toBeNull();
  });

  // The same claim made on a combo the server has never seen: 'manual' is
  // stored verbatim, so the row is never auto-claimed in the first place.
  it('stores an incoming manual claim verbatim on a fully-identified, unpriced row', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'GPU', brand: 'ASUS', partNumber, description: 'Card', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null, priceSource: 'manual' },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].priceSource).toBe('manual');

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.expectedParts[0].priceSource).toBe('manual');
  });

  it('rejects an unrecognized priceSource value with a field-named 400', async () => {
    const res = await postJson<ErrorResponse>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        // Exactly three states exist (assumption A22): 'auto', 'manual' and
        // null. Anything else is a client bug, not a fourth meaning.
        { componentCategory: 'CPU', brand: 'Intel', partNumber: uniquePartNumber(), description: 'Chip', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null, priceSource: 'cached' } as unknown as ExpectedPart,
      ] as unknown as CreateListingInput['expectedParts']),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('expectedParts[0].priceSource');
  });

  /**
   * Req 4 + Req 5, end to end: the save itself must leave a *queued*
   * background job behind for the newly-claimed part — queued, not already
   * researched, because the research never runs inside the request.
   *
   * Proven by reading the server's own DuckDB file, which means stopping
   * the server first: DuckDB takes an exclusive lock on the file while the
   * server holds it open, so a second connection from this process cannot
   * be opened alongside it. Runs last for that reason, and sets
   * `serverStopped` so afterAll doesn't wait forever on an exit event that
   * already fired.
   */
  it('leaves a queued background price job behind, and no synchronous research (Req 4, 5)', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        { componentCategory: 'PSU', brand: 'Seasonic', partNumber, description: 'Focus 750W', estimatedResaleValue: null, identityCandidates: [], aiConfidence: null, aiSource: null },
      ]),
    );
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);

    await server.stop();
    serverStopped = true;

    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): client.ts computes its DATA_DIR once
    // at module-evaluation time from DUCKDB_DATA_DIR, so it has to be
    // imported after that env var points at this suite's directory — the
    // same reason every direct-DB suite in this folder imports it this way.
    const { getConnection } = await import('../src/db/client.js');
    const connection: DuckDBConnection = await getConnection();

    const jobs = await connection.runAndReadAll(
      `SELECT stage FROM price_parts_jobs WHERE brand = $brand AND part_number = $part_number`,
      { brand: 'Seasonic', part_number: partNumber },
    );
    const jobRows = jobs.getRowObjectsJson();
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].stage).toBe('queued');

    // Req 9: the cache row is inserted straight away, still unpriced, so the
    // daily refresh finds the combo even if this job never completes.
    const cache = await connection.runAndReadAll(
      `SELECT estimated_resale_value FROM part_price_cache WHERE brand = $brand AND part_number = $part_number`,
      { brand: 'Seasonic', part_number: partNumber },
    );
    const cacheRows = cache.getRowObjectsJson();
    expect(cacheRows).toHaveLength(1);
    expect(cacheRows[0].estimated_resale_value).toBeNull();

    delete process.env.DUCKDB_DATA_DIR;
  }, 30_000);
});
