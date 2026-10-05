// T10 proof: Part status transitions (Req 7) and the unsellable-reason
// requirement (Req 7, 13), exercised against the real /api/parts routes —
// not the validator function in isolation — the same real-server-via-
// child-process pattern T14's concurrency.test.ts established (see
// helpers.ts). Each Part under test is produced by the real Source ->
// Listing -> accept -> Purchase (shipped/received) -> teardown chain, so
// these tests also incidentally prove that chain still yields a
// 'ready_to_list' Part, without re-asserting Req 6's own teardown behavior.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListingDetail,
  ListPartsResponse,
  PartSummary,
  PurchaseDetail,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from concurrency.test.ts's 34_591 so the two suites can run as
// separate vitest worker processes without a port collision.
const TEST_PORT = 34_592;

interface SourceResponse {
  id: string;
}

// Builds a distinct create-Listing request body for index `i`, mirroring
// concurrency.test.ts's listingBody so this file's seed data follows the
// same convention.
function listingBody(i: number, sourceId: string): CreateListingInput {
  return {
    sourceId,
    title: `Parts Test Listing ${i}`,
    description: null,
    listingUrl: `https://example.com/parts-test-listing-${i}`,
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    expectedParts: [{ componentCategory: 'CPU', brand: 'Intel', partNumber: `i5-${i}`, description: `Test CPU ${i}`, estimatedResaleValue: 50 }],
  };
}

describe('Part status transitions (T10)', () => {
  let server: TestServer;
  let sourceId: string;
  // Monotonic counter so every Listing/Purchase created across the suite's
  // tests gets a unique URL/title, avoiding any accidental cross-test state
  // bleed through a shared value.
  let seedIndex = 0;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Parts Test Source',
      platformType: 'ebay',
      url: 'https://example.com/parts-test',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  // Drives one full Listing -> accept -> Purchase (shipped, received) ->
  // teardown chain through the real HTTP routes and returns the id of the
  // single resulting Part, which teardown leaves in status 'ready_to_list'.
  // Each call uses a fresh Listing/Purchase so the Parts created by
  // different `it` blocks never share mutable state.
  async function createReadyToListPart(): Promise<string> {
    const i = seedIndex++;
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(i, sourceId));
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    const expectedPartId = listingRes.body.expectedParts[0].id;

    const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
    expect(acceptRes.status, `accept failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);
    const purchaseId = acceptRes.body.purchaseId;

    const shipped = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    expect(shipped.status, `advance to shipped failed: ${JSON.stringify(shipped.body)}`).toBe(200);
    const received = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(received.status, `advance to received failed: ${JSON.stringify(received.body)}`).toBe(200);

    const teardownRes = await postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [{ expectedPartId, result: 'present_as_expected', note: null }],
      additionalParts: [],
    });
    expect(teardownRes.status, `teardown failed: ${JSON.stringify(teardownRes.body)}`).toBe(200);
    expect(teardownRes.body.createdParts, 'teardown should create exactly one Part').toHaveLength(1);
    const part = teardownRes.body.createdParts[0];
    expect(part.status, 'a freshly torn-down Part must start ready_to_list').toBe('ready_to_list');
    return part.id;
  }

  it('advances a Part ready_to_list -> listed -> sold one step at a time', async () => {
    const partId = await createReadyToListPart();

    const toListed = await patchJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'listed' });
    expect(toListed.status, JSON.stringify(toListed.body)).toBe(200);
    expect(toListed.body.status).toBe('listed');

    const toSold = await patchJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'sold' });
    expect(toSold.status, JSON.stringify(toSold.body)).toBe(200);
    expect(toSold.body.status).toBe('sold');
  }, 30_000);

  it('rejects skipping a step (ready_to_list -> sold directly)', async () => {
    const partId = await createReadyToListPart();

    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'sold' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("the only valid next status is 'listed'");

    // The rejected request must not have mutated the Part: it should still
    // be sitting at ready_to_list, reachable only by GET, never trusting
    // the (already-asserted-failed) PATCH response body for this.
    const get = await getJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}`);
    expect(get.body.status, 'a rejected transition must leave status unchanged').toBe('ready_to_list');
  }, 30_000);

  it('rejects a reversal from a terminal status (sold -> listed)', async () => {
    const partId = await createReadyToListPart();
    await patchJson(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'listed' });
    await patchJson(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'sold' });

    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'listed' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('already at a final status');
  }, 30_000);

  it('rejects marking unsellable without a reason note (Req 7/13)', async () => {
    const partId = await createReadyToListPart();

    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'unsellable' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('A reason note is required');

    const get = await getJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}`);
    expect(get.body.status, 'a rejected unsellable request must leave status unchanged').toBe('ready_to_list');
    expect(get.body.unsellableReason).toBeNull();
  }, 30_000);

  it('rejects marking unsellable with a blank/whitespace-only reason note', async () => {
    const partId = await createReadyToListPart();

    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${partId}/status`, {
      status: 'unsellable',
      reason: '   ',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('A reason note is required');
  }, 30_000);

  it('accepts marking unsellable with a non-blank reason note', async () => {
    const partId = await createReadyToListPart();

    const res = await patchJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}/status`, {
      status: 'unsellable',
      reason: 'Cracked heatsink, not resellable',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('unsellable');
    expect(res.body.unsellableReason).toBe('Cracked heatsink, not resellable');
  }, 30_000);

  it('rejects marking unsellable from a non-ready_to_list status', async () => {
    const partId = await createReadyToListPart();
    await patchJson(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'listed' });

    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${partId}/status`, {
      status: 'unsellable',
      reason: 'should not be allowed',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("only 'ready_to_list' parts can be marked unsellable");
  }, 30_000);

  it('GET /api/parts?status= filters to only Parts in that status', async () => {
    const soldPartId = await createReadyToListPart();
    await patchJson(`${server.baseUrl}/api/parts/${soldPartId}/status`, { status: 'listed' });
    await patchJson(`${server.baseUrl}/api/parts/${soldPartId}/status`, { status: 'sold' });
    const readyPartId = await createReadyToListPart();

    const res = await getJson<ListPartsResponse>(`${server.baseUrl}/api/parts?status=sold&limit=100`);
    expect(res.status).toBe(200);
    const ids = res.body.parts.map((p) => p.id);
    expect(ids, 'the just-sold Part must appear in the sold filter').toContain(soldPartId);
    expect(ids, 'a ready_to_list Part must not appear in the sold filter').not.toContain(readyPartId);
    expect(res.body.parts.every((p) => p.status === 'sold'), 'every row returned under status=sold must actually be sold').toBe(true);
  }, 30_000);

  it('carries the Part brand/partNumber on the detail GET and the status PATCH response', async () => {
    // Both of those responses come from getPartWithContextById, which selects
    // an explicit column list rather than `SELECT *` — a column missing from
    // that list would surface here and in no other test, since the list
    // endpoint uses a different (separately-enumerated) statement.
    const partId = await createReadyToListPart();

    const get = await getJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}`);
    expect(get.status).toBe(200);
    // The seed fixture (listingBody above) sets Intel / i5-<n> on the single
    // Expected Part, and teardown carries it onto the Part.
    expect(get.body.brand).toBe('Intel');
    expect(get.body.partNumber).toMatch(/^i5-\d+$/);

    const patched = await patchJson<PartSummary>(`${server.baseUrl}/api/parts/${partId}/status`, { status: 'listed' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.brand).toBe('Intel');
    expect(patched.body.partNumber).toBe(get.body.partNumber);
  }, 30_000);
});
