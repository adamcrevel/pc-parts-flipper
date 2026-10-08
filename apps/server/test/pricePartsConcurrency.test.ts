// T4 standing-check proof, HTTP half: the price pipeline's triggering
// behaviour through the REAL Listing write paths, against a REAL server and
// a REAL isolated DuckDB file (helpers.ts's spawn-based fixture, the same
// one concurrency.test.ts and identifyPartsConcurrency.test.ts use).
//
// What this suite adds over priceSourceRoute.test.ts — which proves the
// `price_source` column threads through those same routes — is the pipeline
// state each save leaves behind in part_price_cache and price_parts_jobs,
// and what happens when two saves land on the same combination at once:
//
//   * Req 13: two (and then a PUT plus a POST) genuinely racing first
//     encounters of the same (component_category, brand, part_number) must
//     leave exactly one cache row and exactly one non-terminal job. Fired
//     through Promise.all — both requests are in flight before either has
//     read the cache, which is the only state that can produce the
//     duplicate at all. Two sequential saves would prove nothing here.
//   * Req 4 + Req 5: a save enqueues research rather than performing it —
//     the request returns 201/200 while the job it left behind is still
//     `queued` and the cache row it created is still unpriced.
//   * Req 3: a part missing brand or part number leaves no cache row and no
//     job at all, not merely a null `price_source`.
//   * Req 6 + Req 7 + Req 14: a combo already carrying a cached value (seeded
//     into the database before the server boots, so it demonstrably belongs
//     to no Listing in this suite) is applied to a new Listing's auto row
//     immediately with no job enqueued, while a row the user priced himself
//     in that same request keeps his figure.
//   * Req 14 across a resave: resaving an auto row that is still waiting for
//     its price neither duplicates the job nor disturbs the cache row.
//
// Every HTTP call runs in beforeAll and the resulting rows are read
// afterwards, in one pass, because DuckDB holds an exclusive lock on the
// database file while the server process owns it — a second connection
// cannot be opened alongside the running server (see
// priceSourceRoute.test.ts's own note on the same constraint). The `it`
// blocks below are therefore assertions over that captured state.
//
// IDENTIFY_PARTS_POOL_SIZE=0 and PRICE_PARTS_POOL_SIZE=0 keep both worker
// pools from claiming anything, so the real `omp` binary is never invoked
// (this project's standing rule that the suite stays network- and
// credential-independent) and every job this suite enqueues stays exactly
// as the write path left it.
import type { DuckDBConnection } from '@duckdb/node-api';
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { getJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Arbitrary high port distinct from every other suite's TEST_PORT (highest
// currently in use is priceSourceRoute.test.ts's 34_640).
const TEST_PORT = 34_641;

interface SourceResponse {
  id: string;
}

type PartInput = CreateListingInput['expectedParts'][number];

// PUTs `body` as JSON to `url`. helpers.ts has no PUT wrapper (see
// listings.test.ts and priceSourceRoute.test.ts's identical local copies).
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** One Expected Part request row; every caller below overrides only what its scenario is about. */
function part(overrides: Partial<PartInput> & Pick<PartInput, 'componentCategory'>): PartInput {
  return {
    brand: null,
    partNumber: null,
    description: 'Pulled from the tower',
    estimatedResaleValue: null,
    identityCandidates: [],
    aiConfidence: null,
    aiSource: null,
    ...overrides,
  } as PartInput;
}

function listingBody(sourceId: string, title: string, expectedParts: PartInput[]): CreateListingInput {
  return {
    sourceId,
    title,
    description: null,
    listingUrl: 'https://example.com/listing/price-concurrency',
    askingPrice: 200,
    listingDate: '2026-03-01',
    acquisitionFees: 0,
    expectedParts,
  };
}

// The combos each scenario owns. Distinct part numbers mean the row counts
// below can only be explained by the scenario that produced them.
const RACE_TWO_SAVES = 'HTTP-RACE-A';
const RACE_PUT_VS_POST = 'HTTP-RACE-B';
const PUT_ONLY = 'HTTP-PUT-ONLY';
const RESAVE_AUTO = 'HTTP-RESAVE-D';
const USER_PRICED = 'HTTP-USEREDIT-E';
const HALF_IDENTIFIED = 'HTTP-HALF-F';
const PRE_CACHED = 'HTTP-CACHED-G';
// Seeded before boot, so the only way a Listing in this suite can show it is
// the cache. Written as a literal here and asserted as a literal below.
const PRE_CACHED_VALUE = 250;
// What the user types on his own row of that same pre-cached combo.
const USER_TYPED_VALUE = 95;

let dataDir: string;
let server: TestServer;
let serverStopped = false;

// Captured HTTP results.
let raceTwoSaves: JsonResponse<ListingDetail>[];
let racePutVsPost: JsonResponse<ListingDetail>[];
let editOnlySaved: JsonResponse<ListingDetail>;
let resaveCreated: JsonResponse<ListingDetail>;
let resaveUpdated: JsonResponse<ListingDetail>;
let userPricedCreated: JsonResponse<ListingDetail>;
let userPricedUpdated: JsonResponse<ListingDetail>;
let halfIdentified: JsonResponse<ListingDetail>;
let cacheHitListing: JsonResponse<ListingDetail>;

let connection: DuckDBConnection;

/** Raw cache rows for one part number, read without going through the query module under test. */
async function cacheRows(partNumber: string): Promise<Record<string, unknown>[]> {
  const reader = await connection.runAndReadAll(
    `SELECT component_category, brand, estimated_resale_value, last_researched_at
     FROM part_price_cache WHERE part_number = $part_number`,
    { part_number: partNumber },
  );
  return reader.getRowObjectsJson();
}

/** Raw job rows for one part number, likewise read directly. */
async function jobRows(partNumber: string): Promise<Record<string, unknown>[]> {
  const reader = await connection.runAndReadAll(
    `SELECT id, stage FROM price_parts_jobs WHERE part_number = $part_number`,
    { part_number: partNumber },
  );
  return reader.getRowObjectsJson();
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-concurrency-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import), same reason identifyPartsJobsRoute.
  // test.ts gives: client.ts resolves DUCKDB_DATA_DIR once at module-
  // evaluation time, so it has to be loaded after the env var is set.
  const { getConnection, closeConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
  const seedConnection = await getConnection();
  await runMigrations(seedConnection);
  // A cache entry that already holds a researched value, belonging to no
  // Listing — the "another Listing already paid for this research" state
  // Req 6/7 are about. Seeded with raw SQL rather than through
  // partPriceCache.ts so this fixture does not depend on the code the
  // assertions judge.
  await seedConnection.run(
    `INSERT INTO part_price_cache (id, component_category, brand, part_number, estimated_resale_value, last_researched_at)
     VALUES (gen_random_uuid(), 'GPU', 'AMD', $part_number, 250, current_timestamp)`,
    { part_number: PRE_CACHED },
  );
  // Single-writer rule (client.ts's own module doc): this connection must be
  // closed before the server process opens the same file.
  await closeConnection();

  server = await startTestServer(TEST_PORT, {
    DUCKDB_DATA_DIR: dataDir,
    IDENTIFY_PARTS_POOL_SIZE: '0',
    PRICE_PARTS_POOL_SIZE: '0',
  });
  const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
    name: 'Price Concurrency Source',
    platformType: 'ebay',
    url: 'https://example.com/price-concurrency',
    notes: null,
  });
  expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
  const sourceId = sourceRes.body.id;

  // --- Req 13: two Listing saves racing on one brand-new combo ----------
  // Promise.all, not two awaits: both POSTs are in flight together.
  raceTwoSaves = await Promise.all([
    postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, 'Race save A', [part({ componentCategory: 'GPU', brand: 'NVIDIA', partNumber: RACE_TWO_SAVES })]),
    ),
    postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, 'Race save B', [part({ componentCategory: 'GPU', brand: 'NVIDIA', partNumber: RACE_TWO_SAVES })]),
    ),
  ]);

  // --- Req 13: an edit racing a create on one brand-new combo -----------
  // The Listing the PUT edits starts with a part the pipeline ignores, so
  // the combo under test is genuinely first encountered during the race.
  const editTarget = await postJson<ListingDetail>(
    `${server.baseUrl}/api/listings`,
    listingBody(sourceId, 'Edit race target', [part({ componentCategory: 'Other', description: 'unidentified' })]),
  );
  expect(editTarget.status, `edit-race seed failed: ${JSON.stringify(editTarget.body)}`).toBe(201);
  racePutVsPost = await Promise.all([
    putJson<ListingDetail>(
      `${server.baseUrl}/api/listings/${editTarget.body.id}`,
      listingBody(sourceId, 'Edit race target', [part({ componentCategory: 'CPU', brand: 'Intel', partNumber: RACE_PUT_VS_POST })]),
    ),
    postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, 'Create racing the edit', [part({ componentCategory: 'CPU', brand: 'Intel', partNumber: RACE_PUT_VS_POST })]),
    ),
  ]);

  // --- Req 4, the edit half on its own ----------------------------------
  // The race above cannot show that a PUT triggers anything: the POST it
  // races would account for the single cache row and job by itself. This
  // scenario gives the edit path a combo nothing else ever touches.
  const editOnlyTarget = await postJson<ListingDetail>(
    `${server.baseUrl}/api/listings`,
    listingBody(sourceId, 'Edit-only target', [part({ componentCategory: 'Other', description: 'unidentified' })]),
  );
  expect(editOnlyTarget.status, `edit-only seed failed: ${JSON.stringify(editOnlyTarget.body)}`).toBe(201);
  editOnlySaved = await putJson<ListingDetail>(
    `${server.baseUrl}/api/listings/${editOnlyTarget.body.id}`,
    listingBody(sourceId, 'Edit-only target', [part({ componentCategory: 'PSU', brand: 'Seasonic', partNumber: PUT_ONLY })]),
  );

  // --- Req 14: resaving an auto row that is still waiting for its price --
  resaveCreated = await postJson<ListingDetail>(
    `${server.baseUrl}/api/listings`,
    listingBody(sourceId, 'Resave of an auto row', [part({ componentCategory: 'RAM', brand: 'Corsair', partNumber: RESAVE_AUTO })]),
  );
  expect(resaveCreated.status, `resave seed failed: ${JSON.stringify(resaveCreated.body)}`).toBe(201);
  // The editor round-trips the row's own priceSource when the user has not
  // touched it, and the price has not arrived yet, so the value is still null.
  resaveUpdated = await putJson<ListingDetail>(
    `${server.baseUrl}/api/listings/${resaveCreated.body.id}`,
    listingBody(sourceId, 'Resave of an auto row', [
      part({ componentCategory: 'RAM', brand: 'Corsair', partNumber: RESAVE_AUTO, priceSource: 'auto' }),
    ]),
  );

  // --- Req 14/15: a row the user priced himself, created then resaved ----
  userPricedCreated = await postJson<ListingDetail>(
    `${server.baseUrl}/api/listings`,
    listingBody(sourceId, 'User-priced row', [
      part({ componentCategory: 'Storage', brand: 'Samsung', partNumber: USER_PRICED, estimatedResaleValue: 410 }),
    ]),
  );
  expect(userPricedCreated.status, `user-priced seed failed: ${JSON.stringify(userPricedCreated.body)}`).toBe(201);
  userPricedUpdated = await putJson<ListingDetail>(
    `${server.baseUrl}/api/listings/${userPricedCreated.body.id}`,
    listingBody(sourceId, 'User-priced row', [
      part({
        componentCategory: 'Storage',
        brand: 'Samsung',
        partNumber: USER_PRICED,
        description: 'Pulled from the tower, lid scuffed',
        estimatedResaleValue: 410,
        priceSource: null,
      }),
    ]),
  );

  // --- Req 3: half-identified parts ------------------------------------
  halfIdentified = await postJson<ListingDetail>(
    `${server.baseUrl}/api/listings`,
    listingBody(sourceId, 'Half-identified parts', [
      part({ componentCategory: 'PSU', brand: 'Corsair', partNumber: null, description: 'unknown model' }),
      part({ componentCategory: 'RAM', brand: null, partNumber: HALF_IDENTIFIED, description: 'unknown brand' }),
    ]),
  );

  // --- Req 6/7/14: a save landing on an already-researched combo --------
  // Two rows of the same combo in one request: one the pipeline may own,
  // one the user priced himself.
  cacheHitListing = await postJson<ListingDetail>(
    `${server.baseUrl}/api/listings`,
    listingBody(sourceId, 'Cache hit', [
      part({ componentCategory: 'GPU', brand: 'AMD', partNumber: PRE_CACHED, description: 'pipeline row' }),
      part({
        componentCategory: 'GPU',
        brand: 'AMD',
        partNumber: PRE_CACHED,
        description: 'user-priced row',
        estimatedResaleValue: USER_TYPED_VALUE,
      }),
    ]),
  );
  // Re-fetched rather than trusted from the create response, so what is
  // asserted is the stored state after the trigger ran.
  cacheHitListing = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${cacheHitListing.body.id}`);

  await server.stop();
  serverStopped = true;
  connection = await getConnection();
}, 180_000);

afterAll(async () => {
  if (!serverStopped) {
    await server.stop();
  }
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
}, 30_000);

describe('two Listing saves racing on one brand-new combo (Req 13)', () => {
  it('both saves succeed and both rows are claimed for the pipeline', () => {
    for (const res of raceTwoSaves) {
      expect(res.status, `save failed: ${JSON.stringify(res.body)}`).toBe(201);
      expect(res.body.expectedParts[0].priceSource).toBe('auto');
    }
  });

  it('leaves exactly one cache row, still unpriced (Req 9)', async () => {
    const rows = await cacheRows(RACE_TWO_SAVES);
    // Rows dumped verbatim on failure: a duplicate's own column values are
    // the evidence for which writer produced it (same reason
    // concurrency.test.ts prints failing bodies rather than a count).
    expect(rows, `cache rows: ${JSON.stringify(rows)}`).toHaveLength(1);
    expect(rows[0].estimated_resale_value).toBeNull();
  });

  it('leaves exactly one research job, and no duplicate of it', async () => {
    const rows = await jobRows(RACE_TWO_SAVES);
    const nonTerminal = rows.filter((row) => row.stage === 'queued' || row.stage === 'pricing');
    expect(nonTerminal, `job rows: ${JSON.stringify(rows)}`).toHaveLength(1);
    expect(rows, `job rows: ${JSON.stringify(rows)}`).toHaveLength(1);
  });

  // Req 5: the research itself never happens inside the request. Both
  // requests returned, yet the job is untouched at `queued` and the cache
  // row is unpriced — the save enqueued the work and left.
  it('returns from the request with the research still merely queued (Req 4, 5)', async () => {
    const rows = await jobRows(RACE_TWO_SAVES);
    expect(rows[0].stage).toBe('queued');
  });
});

describe('an edit racing a create on one brand-new combo (Req 13)', () => {
  it('both requests succeed', () => {
    expect(racePutVsPost[0].status, `PUT failed: ${JSON.stringify(racePutVsPost[0].body)}`).toBe(200);
    expect(racePutVsPost[1].status, `POST failed: ${JSON.stringify(racePutVsPost[1].body)}`).toBe(201);
  });

  it('leaves exactly one cache row and one research job', async () => {
    expect(await cacheRows(RACE_PUT_VS_POST)).toHaveLength(1);
    expect(await jobRows(RACE_PUT_VS_POST)).toHaveLength(1);
  });
});

describe('an edit that newly identifies a part (Req 4, 5)', () => {
  it('claims the row for the pipeline on the edit path', () => {
    expect(editOnlySaved.status, `edit failed: ${JSON.stringify(editOnlySaved.body)}`).toBe(200);
    expect(editOnlySaved.body.expectedParts[0].priceSource).toBe('auto');
  });

  it('inserts the cache row and enqueues the research the edit alone triggered', async () => {
    const cache = await cacheRows(PUT_ONLY);
    expect(cache, `cache rows: ${JSON.stringify(cache)}`).toHaveLength(1);
    expect(cache[0].estimated_resale_value).toBeNull();
    const jobs = await jobRows(PUT_ONLY);
    expect(jobs, `job rows: ${JSON.stringify(jobs)}`).toHaveLength(1);
    // Still queued after the request returned: the edit enqueued the
    // research rather than performing it (Req 5).
    expect(jobs[0].stage).toBe('queued');
  });
});

describe('resaving an auto row that is still waiting for its price (Req 14)', () => {
  it('keeps the row claimed by the pipeline across the resave', () => {
    expect(resaveCreated.body.expectedParts[0].priceSource).toBe('auto');
    expect(resaveUpdated.status, `resave failed: ${JSON.stringify(resaveUpdated.body)}`).toBe(200);
    expect(resaveUpdated.body.expectedParts[0].priceSource).toBe('auto');
  });

  it('does not enqueue a second job for the combo', async () => {
    expect(await jobRows(RESAVE_AUTO)).toHaveLength(1);
  });

  it('does not disturb the cache row the first save inserted', async () => {
    const rows = await cacheRows(RESAVE_AUTO);
    expect(rows).toHaveLength(1);
    expect(rows[0].estimated_resale_value).toBeNull();
    expect(rows[0].last_researched_at).toBeNull();
  });
});

describe('a row the user priced himself (Req 14, 15)', () => {
  it('is never claimed by the pipeline, on create or on resave', () => {
    expect(userPricedCreated.body.expectedParts[0].priceSource).toBeNull();
    expect(userPricedUpdated.status, `resave failed: ${JSON.stringify(userPricedUpdated.body)}`).toBe(200);
    expect(userPricedUpdated.body.expectedParts[0].priceSource).toBeNull();
    expect(userPricedUpdated.body.expectedParts[0].estimatedResaleValue).toBe(410);
  });

  it('never enters the cache and never enqueues research', async () => {
    expect(await cacheRows(USER_PRICED)).toHaveLength(0);
    expect(await jobRows(USER_PRICED)).toHaveLength(0);
  });
});

describe('a half-identified part (Req 3)', () => {
  it('is saved but never claimed for the pipeline', () => {
    expect(halfIdentified.status, `save failed: ${JSON.stringify(halfIdentified.body)}`).toBe(201);
    expect(halfIdentified.body.expectedParts.map((p) => p.priceSource)).toEqual([null, null]);
  });

  it('leaves no cache row and no research job for the missing-part-number half', async () => {
    const reader = await connection.runAndReadAll(
      `SELECT (SELECT count(*) FROM part_price_cache WHERE brand = 'Corsair' AND part_number IS NULL) AS cache_count,
              (SELECT count(*) FROM price_parts_jobs WHERE brand = 'Corsair' AND part_number IS NULL) AS job_count`,
    );
    const counts = reader.getRowObjectsJson()[0];
    expect(Number(counts.cache_count)).toBe(0);
    expect(Number(counts.job_count)).toBe(0);
  });

  it('leaves no cache row and no research job for the missing-brand half', async () => {
    expect(await cacheRows(HALF_IDENTIFIED)).toHaveLength(0);
    expect(await jobRows(HALF_IDENTIFIED)).toHaveLength(0);
  });
});

describe('a save landing on a combo another Listing already researched (Req 6, 7, 14)', () => {
  it('applies the cached value to the pipeline-owned row immediately', () => {
    expect(cacheHitListing.status, `fetch failed: ${JSON.stringify(cacheHitListing.body)}`).toBe(200);
    const pipelineRow = cacheHitListing.body.expectedParts.find((p) => p.description === 'pipeline row');
    expect(pipelineRow?.priceSource).toBe('auto');
    expect(pipelineRow?.estimatedResaleValue).toBe(PRE_CACHED_VALUE);
  });

  // Req 14: the cache propagation matches on price_source = 'auto', so the
  // figure the user typed on his own row of the very same combo survives a
  // propagation that lands in the same request.
  it('leaves the user-priced row of that same combo at the user figure', () => {
    const userRow = cacheHitListing.body.expectedParts.find((p) => p.description === 'user-priced row');
    expect(userRow?.priceSource).toBeNull();
    expect(userRow?.estimatedResaleValue).toBe(USER_TYPED_VALUE);
  });

  // Req 7: a cache hit assigns, it does not research. No job was enqueued
  // for this combo by anyone, so a job row here could only have come from
  // this save falling through to the miss path.
  it('enqueues no research job at all for the combo', async () => {
    expect(await jobRows(PRE_CACHED)).toHaveLength(0);
  });

  it('leaves the single cache row and its value untouched', async () => {
    const rows = await cacheRows(PRE_CACHED);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].estimated_resale_value)).toBe(PRE_CACHED_VALUE);
  });
});
