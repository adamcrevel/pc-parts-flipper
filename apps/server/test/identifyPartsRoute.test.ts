// Proof for apps/server/src/routes/identifyParts.ts's three routes:
// POST /api/listings/:id/identify-parts (enqueue-or-409),
// POST /api/listings/identify-parts/bulk (per-listing enqueue-or-skip across
// a batch), and GET /api/listings/:id/identify-parts-jobs/latest (poll for
// the most recent job).
//
// Rewritten for the async identify-parts-queue feature (T3): the route no
// longer runs AI identification synchronously and returns a full
// IdentifyPartsResponse (200) or a model-parse failure (502) — it enqueues a
// `queued` job row and returns 201, or 409 if the Listing already has one
// active. The 10-way *concurrent* race proof for that 201-vs-409 split lives
// in identifyPartsConcurrency.test.ts (Req 13); this file covers the
// simpler, sequential behaviors that test doesn't exercise: a 404 for a
// nonexistent Listing on both routes, a 409 on a second *sequential*
// enqueue attempt, and the bulk route's per-id outcome reporting (queued /
// already_active / not_found all in one response, in input order, plus the
// empty-array edge case).
//
// Uses the same real-spawned-server pattern as identifyPartsConcurrency.test.ts
// (helpers.ts's startTestServer) rather than the in-process Fastify instance
// this file used before: the route now does nothing AI-related itself
// (identifyListingParts runs entirely inside the background worker, T2's
// identifyPartsWorkerPool.ts), so there's no ompRunner seam left for this
// route's own test to install an override into, in-process or otherwise. The
// worker pool is disabled via IDENTIFY_PARTS_POOL_SIZE=0 so the queued jobs
// these tests create are never claimed and the real `omp` binary is never
// invoked (this project's standing rule that the suite stays
// network/credential-independent — see ompRunner.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

interface SourceResponse {
  id: string;
}

interface ErrorResponse {
  error: { message: string; statusCode: number };
}

interface IdentifyPartsJobResponse {
  id: string;
  listingId: string;
  stage: string;
}

interface BulkResultResponse {
  listingId: string;
  outcome: string;
}

interface BulkResponse {
  results: BulkResultResponse[];
}

// Arbitrary high port distinct from every other suite's TEST_PORT (see the
// roster in e.g. identifyPartsConcurrency.test.ts's comment: 34_591-34_633).
// Also retires the pre-existing 34_613 collision this file previously shared
// with gracefulShutdown.test.ts.
const TEST_PORT = 34_635;

function listingBody(title: string, sourceId: string): CreateListingInput {
  return {
    sourceId,
    title,
    description: null,
    listingUrl: 'https://example.com/identify-parts-route-test',
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    expectedParts: [],
  };
}

describe('identify-parts queue routes (T3)', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT, { IDENTIFY_PARTS_POOL_SIZE: '0' });
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Identify-Parts Route Test Source',
      platformType: 'ebay',
      url: 'https://example.com/identify-parts-route-test',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('POST enqueues a queued job and returns 201 referencing the Listing', async () => {
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody('First Enqueue Listing', sourceId));
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    const listingId = listingRes.body.id;

    const res = await postJson<IdentifyPartsJobResponse>(`${server.baseUrl}/api/listings/${listingId}/identify-parts`, {});

    expect(res.status).toBe(201);
    expect(res.body.listingId).toBe(listingId);
    expect(res.body.stage).toBe('queued');
    expect(res.body.id).toBeTruthy();
  });

  it('POST returns 404 for a Listing that does not exist', async () => {
    // UUID-shaped but unused id, matching scan.test.ts's nonexistent-id
    // convention: the id column is a DuckDB UUID, so a non-UUID string fails
    // conversion before the row lookup could report "not found".
    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/listings/00000000-0000-0000-0000-000000000000/identify-parts`, {});

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('not found');
  });

  it('POST returns 409 when the Listing already has an active job', async () => {
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody('Second Enqueue Listing', sourceId));
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    const listingId = listingRes.body.id;

    const firstRes = await postJson<IdentifyPartsJobResponse>(`${server.baseUrl}/api/listings/${listingId}/identify-parts`, {});
    expect(firstRes.status, `first enqueue failed: ${JSON.stringify(firstRes.body)}`).toBe(201);

    const secondRes = await postJson<ErrorResponse>(`${server.baseUrl}/api/listings/${listingId}/identify-parts`, {});

    expect(secondRes.status).toBe(409);
    expect(secondRes.body.error.message).toContain('already has an active identify-parts job');
  });

  it('GET latest returns 404 when the Listing has never had a job', async () => {
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody('Never Enqueued Listing', sourceId));
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    const listingId = listingRes.body.id;

    const res = await getJson<ErrorResponse>(`${server.baseUrl}/api/listings/${listingId}/identify-parts-jobs/latest`);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('No identify-parts job');
  });

  it('POST /bulk reports queued/already_active/not_found for a mixed batch, one result per input id in input order', async () => {
    const freshListingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody('Bulk Fresh Listing', sourceId));
    expect(freshListingRes.status, `seed Listing creation failed: ${JSON.stringify(freshListingRes.body)}`).toBe(201);
    const freshListingId = freshListingRes.body.id;

    const activeListingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody('Bulk Active Listing', sourceId));
    expect(activeListingRes.status, `seed Listing creation failed: ${JSON.stringify(activeListingRes.body)}`).toBe(201);
    const activeListingId = activeListingRes.body.id;

    const preEnqueueRes = await postJson<IdentifyPartsJobResponse>(`${server.baseUrl}/api/listings/${activeListingId}/identify-parts`, {});
    expect(preEnqueueRes.status, `pre-enqueue failed: ${JSON.stringify(preEnqueueRes.body)}`).toBe(201);
    const existingJobId = preEnqueueRes.body.id;

    const nonexistentId = '22222222-2222-2222-2222-222222222222';

    const bulkRes = await postJson<BulkResponse>(`${server.baseUrl}/api/listings/identify-parts/bulk`, {
      listingIds: [freshListingId, activeListingId, nonexistentId],
    });

    expect(bulkRes.status).toBe(200);
    expect(bulkRes.body.results).toHaveLength(3);
    expect(bulkRes.body.results[0]).toEqual({ listingId: freshListingId, outcome: 'queued' });
    expect(bulkRes.body.results[1]).toEqual({ listingId: activeListingId, outcome: 'already_active' });
    expect(bulkRes.body.results[2]).toEqual({ listingId: nonexistentId, outcome: 'not_found' });

    // The already-active Listing must not have gained a second job row: its
    // latest job is still the exact one created by the pre-enqueue call
    // above (same id, still in the `queued` stage it started in), not a
    // newly inserted row sitting on top of it.
    const latestForActiveRes = await getJson<IdentifyPartsJobResponse>(`${server.baseUrl}/api/listings/${activeListingId}/identify-parts-jobs/latest`);
    expect(latestForActiveRes.status).toBe(200);
    expect(latestForActiveRes.body.id).toBe(existingJobId);
    expect(latestForActiveRes.body.stage).toBe('queued');

    // The fresh Listing really did get a new job enqueued, not just a
    // 'queued' label with no row behind it.
    const latestForFreshRes = await getJson<IdentifyPartsJobResponse>(`${server.baseUrl}/api/listings/${freshListingId}/identify-parts-jobs/latest`);
    expect(latestForFreshRes.status).toBe(200);
    expect(latestForFreshRes.body.listingId).toBe(freshListingId);
    expect(latestForFreshRes.body.stage).toBe('queued');
  });

  it('POST /bulk with an empty listingIds array returns an empty results list without erroring', async () => {
    const res = await postJson<BulkResponse>(`${server.baseUrl}/api/listings/identify-parts/bulk`, { listingIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});
