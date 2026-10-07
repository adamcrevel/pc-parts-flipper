// T3 Requirement 13 concurrency proof: "Concurrent enqueueing of identify-parts
// jobs via genuine parallel POST requests to the same Listing atomically
// creates exactly one queued job: the first request returns 201 with the job id,
// all others return 409 Conflict, and they all resolve to the same single job
// when polled."
//
// This suite boots the real server and fires 10 concurrent POST requests to the
// same identify-parts endpoint via Promise.all, then verifies that exactly one
// succeeded with 201 (created new job), the other 9 failed with 409 (job already
// active), and all 10 converge on the same single job id when fetched via the
// latest-job GET endpoint.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

interface SourceResponse {
  id: string;
}
// Arbitrary high port distinct from every other suite's TEST_PORT; chosen to
// avoid collisions with other tests (see comments in e.g. concurrency.test.ts).
const TEST_PORT = 34_630;

// Helper to build a valid Listing creation payload for testing
function listingBody(): CreateListingInput {
  return {
    sourceId: '', // will be populated with actual source id in test
    title: 'Test Listing for Identify-Parts Concurrency',
    description: null,
    listingUrl: 'https://example.com/identify-parts-test',
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    expectedParts: [
      { componentCategory: 'CPU', brand: 'Intel', partNumber: 'i5-test', description: 'Test CPU', estimatedResaleValue: 50 },
    ],
  };
}

describe('identify-parts queue concurrency proof (T3, Req 13)', () => {
  let server: TestServer;
  let sourceId: string;
  let listingId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    // Create a test Source
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Identify-Parts Concurrency Test Source',
      platformType: 'ebay',
      url: 'https://example.com/identify-parts-concurrency-test',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;

    // Create a test Listing
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, {
      ...listingBody(),
      sourceId,
    });
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    listingId = listingRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('enqueues identify-parts job with 10 concurrent requests: 1x 201, 9x 409, all same job', async () => {
    // Fire 10 genuinely concurrent POST requests to enqueue an identify-parts job
    // for the same Listing. Only the first one should succeed with 201; the other
    // 9 should fail with 409 because a job is already active.
    interface IdentifyPartsJobResponse {
      id: string;
      listingId: string;
      stage: string;
      parts: unknown;
      notes: unknown;
      errorMessage: unknown;
      delivered: boolean;
      createdAt: string;
      startedAt: unknown;
      completedAt: unknown;
    }

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => postJson<IdentifyPartsJobResponse>(`${server.baseUrl}/api/listings/${listingId}/identify-parts`, {})),
    );

    // Verify exactly one succeeded with 201
    const createdResponses = responses.filter((r) => r.status === 201);
    expect(createdResponses, `expected exactly 1 response with 201 Created`).toHaveLength(1);

    // Verify exactly nine failed with 409
    const conflictResponses = responses.filter((r) => r.status === 409);
    expect(conflictResponses, `expected exactly 9 responses with 409 Conflict`).toHaveLength(9);

    // Verify the 201 response contains a valid job
    const createdJob = createdResponses[0].body;
    expect(createdJob.id, 'created job must have an id').toBeTruthy();
    expect(createdJob.listingId, 'created job must reference the listing').toBe(listingId);
    expect(createdJob.stage, 'newly created job must be in queued stage').toBe('queued');

    // Now fetch the latest job for this Listing via GET endpoint
    interface LatestJobResponse {
      id: string;
      listingId: string;
      stage: string;
    }
    const latestRes = await getJson<LatestJobResponse>(`${server.baseUrl}/api/listings/${listingId}/identify-parts-jobs/latest`);
    expect(latestRes.status, `GET latest job failed: ${JSON.stringify(latestRes.body)}`).toBe(200);

    // Verify all 10 concurrent requests converged on the same single job
    expect(latestRes.body.id, 'latest job must match the 201-response job').toBe(createdJob.id);
    expect(latestRes.body.listingId, 'latest job must reference the same listing').toBe(listingId);
  }, 30_000);
});
