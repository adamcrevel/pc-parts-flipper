// T6 proof: Listing CRUD (POST/GET/PUT /api/listings) with nested Expected
// Parts, the Req 3 comparison calculation, and Req 13 validation (blank
// required field / negative monetary field rejected with inline error).
// Boots the real server via helpers.ts's startTestServer, the same pattern
// T14's concurrency.test.ts uses, so these assertions exercise the actual
// HTTP routes/validation/db-query code rather than a mock. Deliberately
// never touches POST /api/listings/:id/accept or /reject — those belong to
// T7's tester.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreateListingInput, ListingDetail, ListListingsResponse } from '@pc-parts-flipper/shared';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as ReferencePhotosModule from '../src/db/queries/referencePhotos.js';
import type * as LoggerModule from '../src/logger.js';
import { getJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Mocks only the leaf module backing promoteReferencePhotos (re-exported from
// the db barrel, db/index.ts), wrapping the real implementation in a vi.fn so
// every test below gets genuine promotion behavior by default — only the one
// test that calls mockImplementationOnce actually overrides it, to prove the
// catch/log-Error path (standing check) without faking a real DB failure.
// Scoped to this file's own module graph; the spawned child-process server
// the describe block above uses runs in a separate OS process and is
// entirely unaffected by this.
vi.mock('../src/db/queries/referencePhotos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReferencePhotosModule>();
  return { ...actual, promoteReferencePhotos: vi.fn(actual.promoteReferencePhotos) };
});

// Arbitrary high port distinct from concurrency.test.ts's 34_591 so this
// suite can run standalone or alongside it without a port collision.
const TEST_PORT = 34_602;

interface SourceResponse {
  id: string;
}

// PUTs `body` as JSON to `url` and returns the parsed response status/body.
// Not added to the shared helpers.ts (other testers run against that file
// concurrently in this batch); kept local to this file instead.
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

// Builds a valid create-Listing request body; callers override individual
// fields per test via the spread.
function listingBody(sourceId: string, overrides: Partial<CreateListingInput> = {}): CreateListingInput {
  return {
    sourceId,
    title: 'Dell Optiplex 7080 bundle',
    description: 'Untested, seller says it powers on',
    listingUrl: 'https://example.com/listing/7080',
    askingPrice: 100,
    listingDate: '2026-01-15',
    acquisitionFees: 25,
    expectedParts: [
      { componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-10700', description: 'Pulled from a working machine', estimatedResaleValue: 60 },
      { componentCategory: 'RAM', brand: null, partNumber: null, description: '16GB DDR4', estimatedResaleValue: 30 },
      { componentCategory: 'Storage', brand: 'Samsung', partNumber: null, description: '512GB NVMe', estimatedResaleValue: 20 },
    ],
    ...overrides,
  };
}

describe('Listing CRUD + Expected Parts + Req-3 comparison (T6)', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'T6 Test Source',
      platformType: 'ebay',
      url: 'https://example.com/t6-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('creates a Listing with nested Expected Parts and round-trips them via GET', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.title).toBe('Dell Optiplex 7080 bundle');
    expect(created.body.status).toBe('open');
    expect(created.body.expectedParts).toHaveLength(3);
    // Every Expected Part row must carry a generated id distinct from its
    // siblings (proves the nested rows were actually persisted, not just
    // echoed back from the request body).
    const partIds = new Set(created.body.expectedParts.map((p) => p.id));
    expect(partIds.size).toBe(3);
    expect(new Set(created.body.expectedParts.map((p) => p.listingId))).toEqual(new Set([created.body.id]));

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.title).toBe(created.body.title);
    // The round-trip set must match exactly on the fields the client
    // submitted, not merely have the same length.
    const fetchedSorted = [...fetched.body.expectedParts].sort((a, b) => a.description.localeCompare(b.description));
    expect(fetchedSorted.map((p) => ({ componentCategory: p.componentCategory, brand: p.brand, partNumber: p.partNumber, description: p.description, estimatedResaleValue: p.estimatedResaleValue }))).toEqual([
      { componentCategory: 'Storage', brand: 'Samsung', partNumber: null, description: '512GB NVMe', estimatedResaleValue: 20 },
      { componentCategory: 'RAM', brand: null, partNumber: null, description: '16GB DDR4', estimatedResaleValue: 30 },
      { componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-10700', description: 'Pulled from a working machine', estimatedResaleValue: 60 },
    ].sort((a, b) => a.description.localeCompare(b.description)));
  });

  it('accepts an Expected Part with brand/partNumber omitted entirely, normalizing both to null', async () => {
    // The optional half of the contract: a component the user could not
    // identify is submitted without these keys at all and must come back as
    // null — never as an empty string, and never rejected as a missing
    // required field.
    // Deliberately built as an untyped object rather than through
    // listingBody: the point of this test is a wire body that genuinely
    // lacks the keys, which the typed CreateListingInput cannot express.
    const body = {
      ...listingBody(sourceId),
      expectedParts: [{ componentCategory: 'PSU', description: '650W, no label visible', estimatedResaleValue: 25 }],
    };
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, body);

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].brand).toBeNull();
    expect(created.body.expectedParts[0].partNumber).toBeNull();
  });

  it('normalizes a blank/whitespace brand and partNumber to null, and trims a real one', async () => {
    // Whitespace-only input is the realistic failure mode of a form field the
    // user tabbed through: it must be stored as "not identified", not as text
    // that would later render as a leading space in a sale listing title.
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId, {
      expectedParts: [
        { componentCategory: 'GPU', brand: '   ', partNumber: '', description: 'Unidentified card', estimatedResaleValue: 150 },
        { componentCategory: 'CPU', brand: '  AMD  ', partNumber: '  Ryzen 5 5600X ', description: 'Boxed', estimatedResaleValue: 90 },
      ],
    }));

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    const gpu = created.body.expectedParts.find((p) => p.componentCategory === 'GPU');
    expect(gpu?.brand).toBeNull();
    expect(gpu?.partNumber).toBeNull();
    const cpu = created.body.expectedParts.find((p) => p.componentCategory === 'CPU');
    expect(cpu?.brand).toBe('AMD');
    expect(cpu?.partNumber).toBe('Ryzen 5 5600X');
  });

  it('computes the Req-3 comparison correctly for a known input, on both GET detail and GET list', async () => {
    // Known input: expected resale 60+30+20=110; cost 100 asking + 25 fees =
    // 125; difference 110-125=-15 (expected loss on paper). Every number
    // here is hand-computed from the spec, not derived from the code under
    // test.
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status).toBe(201);
    expect(created.body.comparison).toEqual({ totalExpectedResaleValue: 110, totalCost: 125, difference: -15 });

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.comparison).toEqual({ totalExpectedResaleValue: 110, totalCost: 125, difference: -15 });

    // Req 12: the Listings queue list rows carry the same comparison value.
    const list = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=200`);
    const row = list.body.listings.find((l) => l.id === created.body.id);
    expect(row, 'created Listing must appear in GET /api/listings').toBeDefined();
    expect(row?.comparison).toEqual({ totalExpectedResaleValue: 110, totalCost: 125, difference: -15 });
  });

  it('rejects a blank required field (title) with 400 and an inline-usable error naming the field, never silently accepting', async () => {
    const res = await postJson<{ error?: { message?: string; statusCode?: number } }>(`${server.baseUrl}/api/listings`, listingBody(sourceId, { title: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.statusCode).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "title", got ${JSON.stringify(res.body)}`).toMatch(/title/i);

    // Must not have been persisted: list total is unaffected by the
    // rejected attempt.
    const before = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    const res2 = await postJson<{ error?: { message?: string } }>(`${server.baseUrl}/api/listings`, listingBody(sourceId, { title: '' }));
    expect(res2.status).toBe(400);
    const after = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    expect(after.body.total, 'a rejected create must not change the stored Listing count').toBe(before.body.total);
  });

  it('rejects a negative monetary field (askingPrice) with 400 naming the field, never silently accepting', async () => {
    const res = await postJson<{ error?: { message?: string } }>(`${server.baseUrl}/api/listings`, listingBody(sourceId, { askingPrice: -5 }));
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "askingPrice", got ${JSON.stringify(res.body)}`).toMatch(/askingPrice/i);
  });

  it('rejects a negative Expected Part estimatedResaleValue with 400 naming the field, never silently accepting', async () => {
    const res = await postJson<{ error?: { message?: string } }>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, { expectedParts: [{ componentCategory: 'CPU', description: 'i7', estimatedResaleValue: -1 }] }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "estimatedResaleValue", got ${JSON.stringify(res.body)}`).toMatch(/estimatedResaleValue/i);
  });

  it('rejects an out-of-enum Expected Part workingStatus value with 400 naming the field, the same way an invalid priceSource is rejected', async () => {
    const res = await postJson<{ error?: { message?: string } }>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, {
        // Exactly two states exist ('working'/'non_working', VALID_WORKING_STATUSES
        // in listingValidation.ts); anything else is a client bug, not a third
        // meaning — mirrors priceSourceRoute.test.ts's "rejects an unrecognized
        // priceSource value" case for the sibling three-state field.
        expectedParts: [{ componentCategory: 'CPU', description: 'i7', estimatedResaleValue: null, workingStatus: 'broken' } as unknown as CreateListingInput['expectedParts'][number]],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "workingStatus", got ${JSON.stringify(res.body)}`).toMatch(/workingStatus/i);
  });

  it('persists a non-empty expectedParts[].identityCandidates array and round-trips it via GET (Req 6)', async () => {
    const candidates = [
      { brand: 'NVIDIA', partNumber: 'RTX 3070' },
      { brand: 'NVIDIA', partNumber: 'RTX 3070 Ti' },
    ];
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId, {
      expectedParts: [
        { componentCategory: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3070', description: 'Pulled, no box', estimatedResaleValue: 200, identityCandidates: candidates },
      ],
    }));
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].identityCandidates).toEqual(candidates);

    // Must survive a real fetch, not just an echo of the request body —
    // the save-time persistence Req 6 actually guards (the candidate list
    // is never dropped even though the user never picked one).
    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.expectedParts[0].identityCandidates).toEqual(candidates);
  });

  it('defaults identityCandidates to [] when the field is absent from the request body (backward compatible)', async () => {
    // Deliberately built as an untyped object, like the brand/partNumber-
    // omitted test above: the point is a wire body genuinely lacking the
    // key, as a pre-Req-6 client would send.
    const body = {
      ...listingBody(sourceId),
      expectedParts: [{ componentCategory: 'PSU', description: 'No candidates sent', estimatedResaleValue: 25 }],
    };
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, body);
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].identityCandidates).toEqual([]);
  });

  it('rejects a non-array identityCandidates with 400, never silently coercing it', async () => {
    const before = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    const body = {
      ...listingBody(sourceId),
      expectedParts: [{ componentCategory: 'PSU', description: 'Bad candidates shape', estimatedResaleValue: 25, identityCandidates: 'NVIDIA' }],
    };
    const res = await postJson<{ error?: { message?: string } }>(`${server.baseUrl}/api/listings`, body);
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error naming "identityCandidates", got ${JSON.stringify(res.body)}`).toMatch(/identityCandidates/i);

    const after = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    expect(after.body.total, 'a rejected create must not change the stored Listing count').toBe(before.body.total);
  });

  it('rejects an identityCandidates entry with a wrong-typed brand with 400, never silently coercing it', async () => {
    const before = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    const body = {
      ...listingBody(sourceId),
      expectedParts: [
        { componentCategory: 'GPU', description: 'Malformed candidate entry', estimatedResaleValue: 25, identityCandidates: [{ brand: 42, partNumber: 'RTX 3070' }] },
      ],
    };
    const res = await postJson<{ error?: { message?: string } }>(`${server.baseUrl}/api/listings`, body);
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error naming "identityCandidates", got ${JSON.stringify(res.body)}`).toMatch(/identityCandidates/i);

    const after = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    expect(after.body.total, 'a rejected create must not change the stored Listing count').toBe(before.body.total);
  });

  it('PUT fully replaces a Listing\'s Expected Parts set (old rows gone, new rows present)', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status).toBe(201);
    const oldPartIds = new Set(created.body.expectedParts.map((p) => p.id));

    const updated = await putJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`, {
      ...listingBody(sourceId),
      title: 'Dell Optiplex 7080 bundle (revised)',
      askingPrice: 80,
      expectedParts: [{ componentCategory: 'GPU', description: 'GTX 1660', estimatedResaleValue: 90 }],
    });
    expect(updated.status, `update failed: ${JSON.stringify(updated.body)}`).toBe(200);
    expect(updated.body.title).toBe('Dell Optiplex 7080 bundle (revised)');
    expect(updated.body.expectedParts).toHaveLength(1);
    expect(updated.body.expectedParts[0].componentCategory).toBe('GPU');
    // None of the replaced rows' ids survive the full-replace.
    for (const part of updated.body.expectedParts) {
      expect(oldPartIds.has(part.id)).toBe(false);
    }

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.expectedParts).toHaveLength(1);
    expect(fetched.body.expectedParts[0].description).toBe('GTX 1660');
  });
});

// T2 proof (promotion hooks wired into listings.ts, Requirements 2 & 4, plus
// the thrown-promotion-failure standing check): the describe block above
// exercises these same routes against the real HTTP contract via a spawned
// child-process server (helpers.ts), which has no way to directly inspect
// part_reference_photos — DuckDB only allows one process to hold this file
// open at a time. This block instead boots registerListingsRoutes in-process
// (Fastify() + registerErrorHandler, the same pattern as scan.test.ts /
// identifyPartsRoute.test.ts), specifically so it can (a) run raw SQL against
// the exact connection the routes use to verify real row state, and (b)
// force promoteReferencePhotos to throw via vi.mock, to prove the
// catch/log-Error path without faking an actual DB failure.
describe('Reference photo promotion hook — DB-verified (T2)', () => {
  const HOOK_PORT = 34_631;
  const HOOK_BASE_URL = `http://127.0.0.1:${HOOK_PORT}`;
  let hookDataDir: string;
  let hookDb: typeof DbModule;
  let hookGetConnection: typeof ClientModule.getConnection;
  let referencePhotosModule: typeof ReferencePhotosModule;
  let hookLogger: typeof LoggerModule.logger;
  let hookApp: FastifyInstance;
  let hookSourceId: string;

  beforeAll(async () => {
    hookDataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-listings-hook-test-'));
    process.env.DUCKDB_DATA_DIR = hookDataDir;
    // Dynamic import (same exception as db.test.ts/scan.test.ts): client.ts's
    // DATA_DIR is computed once, at module-evaluation time, from
    // DUCKDB_DATA_DIR — a static top-of-file import would evaluate before
    // this beforeAll sets the env var.
    hookDb = await import('../src/db/index.js');
    ({ getConnection: hookGetConnection } = await import('../src/db/client.js'));
    referencePhotosModule = await import('../src/db/queries/referencePhotos.js');
    ({ logger: hookLogger } = await import('../src/logger.js'));
    const { registerListingsRoutes: registerHookRoutes } = await import('../src/routes/listings.js');
    const { registerErrorHandler } = await import('../src/error-handler.js');
    const Fastify = (await import('fastify')).default;
    hookApp = Fastify();
    registerErrorHandler(hookApp);
    await registerHookRoutes(hookApp);
    await hookApp.listen({ port: HOOK_PORT, host: '127.0.0.1' });
    const source = await hookDb.createSource({ name: 'T2 Hook Source', platformType: 'ebay', url: null, notes: null, connectorConfig: null });
    hookSourceId = source.id;
  }, 30_000);

  afterAll(async () => {
    await hookApp.close();
    delete process.env.DUCKDB_DATA_DIR;
    await rm(hookDataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Creates a Listing with zero Expected Parts via the real HTTP route, then
  // injects `photoPaths` directly via db.updateListing — bypassing the
  // separate photo-upload route (already covered by listingPhotos.test.ts) —
  // so the Listing has real, non-empty photos for a subsequent PUT to
  // promote.
  async function createListingWithPhotos(photoPaths: string[]): Promise<ListingDetail> {
    const created = await postJson<ListingDetail>(`${HOOK_BASE_URL}/api/listings`, listingBody(hookSourceId, { expectedParts: [] }));
    expect(created.status, `listing creation failed: ${JSON.stringify(created.body)}`).toBe(201);
    await hookDb.updateListing(created.body.id, { photoPaths });
    return { ...created.body, photoPaths };
  }

  // Counts real rows in part_reference_photos for one Listing, via the exact
  // connection the routes themselves use — proof the hook's effect actually
  // landed in the database, not just that the HTTP response looked right.
  async function countReferencePhotoRows(listingId: string): Promise<number> {
    const connection = await hookGetConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE listing_id = $listing_id`,
      { listing_id: listingId },
    );
    return Number(reader.getRowObjectsJson()[0].cnt);
  }

  it('PUT with a non-null-brand Expected Part promotes every one of the Listing\'s photos (Req 2)', async () => {
    const listing = await createListingWithPhotos(['photos/hook-promote-1.jpg', 'photos/hook-promote-2.jpg']);

    const updated = await putJson<ListingDetail>(
      `${HOOK_BASE_URL}/api/listings/${listing.id}`,
      listingBody(hookSourceId, {
        expectedParts: [{ componentCategory: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 4080', description: 'Reference card', estimatedResaleValue: 300 }],
      }),
    );
    expect(updated.status, `PUT failed: ${JSON.stringify(updated.body)}`).toBe(200);

    const connection = await hookGetConnection();
    const reader = await connection.runAndReadAll(
      `SELECT photo_path, category, brand, part_number, source FROM part_reference_photos WHERE listing_id = $listing_id ORDER BY photo_path`,
      { listing_id: listing.id },
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(2);
    expect(rows[0].photo_path).toBe('photos/hook-promote-1.jpg');
    expect(rows[1].photo_path).toBe('photos/hook-promote-2.jpg');
    for (const row of rows) {
      expect(row.category).toBe('GPU');
      expect(row.brand).toBe('NVIDIA');
      expect(row.part_number).toBe('RTX 4080');
      expect(row.source).toBe('confirmed_listing');
    }
  });

  it('re-saving the same Listing with the same Expected Part never duplicates the reference-photo row (Req 4)', async () => {
    const listing = await createListingWithPhotos(['photos/hook-dedup-1.jpg']);
    const body = listingBody(hookSourceId, {
      expectedParts: [{ componentCategory: 'Storage', brand: 'Samsung', partNumber: '980 Pro', description: 'NVMe', estimatedResaleValue: 80 }],
    });

    const firstPut = await putJson<ListingDetail>(`${HOOK_BASE_URL}/api/listings/${listing.id}`, body);
    expect(firstPut.status, `first PUT failed: ${JSON.stringify(firstPut.body)}`).toBe(200);
    expect(await countReferencePhotoRows(listing.id)).toBe(1);

    // Re-save: full-replace deletes and recreates the Expected Part with the
    // SAME brand/category/partNumber, calling promoteReferencePhotos a second
    // time for the SAME photo/category/brand/partNumber combination.
    const secondPut = await putJson<ListingDetail>(`${HOOK_BASE_URL}/api/listings/${listing.id}`, body);
    expect(secondPut.status, `second PUT failed: ${JSON.stringify(secondPut.body)}`).toBe(200);
    expect(await countReferencePhotoRows(listing.id)).toBe(1);
  });

  it('a thrown promotion failure during PUT is logged at Error and never fails the request (standing check)', async () => {
    const listing = await createListingWithPhotos(['photos/hook-throws-1.jpg']);
    const errorSpy = vi.spyOn(hookLogger, 'error');
    vi.mocked(referencePhotosModule.promoteReferencePhotos).mockImplementationOnce(() => {
      throw new Error('Simulated promotion failure');
    });

    const updated = await putJson<ListingDetail>(
      `${HOOK_BASE_URL}/api/listings/${listing.id}`,
      listingBody(hookSourceId, {
        expectedParts: [{ componentCategory: 'CPU', brand: 'Intel', partNumber: 'i9-14900K', description: 'Boxed', estimatedResaleValue: 200 }],
      }),
    );
    expect(updated.status, `PUT unexpectedly failed: ${JSON.stringify(updated.body)}`).toBe(200);
    expect(updated.body.expectedParts[0].brand).toBe('Intel');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'Simulated promotion failure' }) }),
      'Failed to promote reference photos for Expected Part',
    );
  });
});
