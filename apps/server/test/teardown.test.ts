// T9 integration proof for the Req 6 teardown workflow (teardown.ts +
// teardownValidation.ts + db/queries/teardownResults.ts): boots the real
// server (helpers.ts, the same pattern as concurrency.test.ts) and drives
// the actual HTTP endpoints — no mocking of the db layer — so the proof
// covers the real reconciliation logic, not a stand-in for it.
//
// Two behaviors are proven:
//  1. A Purchase with a genuine mix of present_as_expected /
//     present_but_different / missing Expected Parts, plus one Additional
//     Part, moves to 'torn_down' and generates exactly one Part per
//     non-'missing' entry (expected + additional) — none for 'missing'.
//  2. Submitting teardown against a Purchase that isn't yet 'received' is
//     rejected (400) and leaves the Purchase's status untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListPartsResponse,
  ListingDetail,
  PurchaseDetail,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from every other suite's TEST_PORT (concurrency.test.ts: 34_591,
// parts.test.ts: 34_592 — NOT 34_592 despite that port's doc-comment claim
// elsewhere, it's actually taken — profit.test.ts/saleListings.test.ts:
// 34_593, sources.test.ts: 34_597, purchases.test.ts: 34_599, app-shell.
// test.ts: 34_601, listings.test.ts: 34_602, sales.test.ts: 34_612) so this
// suite can run concurrently with the rest without a port collision.
const TEST_PORT = 34_625;

interface SourceResponse {
  id: string;
}

describe('teardown workflow proof (T9)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  // Creates a Source, a Listing with three distinct Expected Parts (one per
  // non-additional TeardownResultType), and accepts it into a fresh
  // Purchase. Returns everything a teardown submission needs. Shared by
  // both tests below so each gets its own isolated Purchase.
  async function createPurchaseWithThreeExpectedParts(label: string): Promise<{ purchaseId: string; expectedPartIds: { cpu: string; gpu: string; ram: string } }> {
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: `Teardown Test Source ${label}`,
      platformType: 'ebay',
      url: `https://example.com/teardown-test-${label}`,
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);

    const listingBody: CreateListingInput = {
      sourceId: sourceRes.body.id,
      title: `Teardown Test Listing ${label}`,
      description: null,
      listingUrl: `https://example.com/listing-${label}`,
      askingPrice: 100,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      expectedParts: [
        { componentCategory: 'CPU', description: `Test CPU ${label}`, estimatedResaleValue: 50 },
        { componentCategory: 'GPU', description: `Test GPU ${label}`, estimatedResaleValue: 80 },
        { componentCategory: 'RAM', description: `Test RAM ${label}`, estimatedResaleValue: 20 },
      ],
    };
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody);
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    // Order of expectedParts in the response isn't guaranteed to match
    // submission order (DuckDB row order), so look each one up by its
    // distinguishing componentCategory rather than assuming array position.
    const cpu = listingRes.body.expectedParts.find((part) => part.componentCategory === 'CPU')!;
    const gpu = listingRes.body.expectedParts.find((part) => part.componentCategory === 'GPU')!;
    const ram = listingRes.body.expectedParts.find((part) => part.componentCategory === 'RAM')!;

    const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
    expect(acceptRes.status, `accept failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);

    return { purchaseId: acceptRes.body.purchaseId, expectedPartIds: { cpu: cpu.id, gpu: gpu.id, ram: ram.id } };
  }

  it('rejects a teardown submission when the Purchase is not yet received', async () => {
    const { purchaseId, expectedPartIds } = await createPurchaseWithThreeExpectedParts('reject-not-received');

    // Freshly-accepted Purchase starts 'ordered' (Req 5), not 'received' —
    // submitting teardown here must be rejected rather than silently
    // accepted.
    const res = await postJson<{ message?: string }>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [
        { expectedPartId: expectedPartIds.cpu, result: 'present_as_expected', note: null },
        { expectedPartId: expectedPartIds.gpu, result: 'present_as_expected', note: null },
        { expectedPartId: expectedPartIds.ram, result: 'present_as_expected', note: null },
      ],
      additionalParts: [],
    });
    expect(res.status, `expected 400 for teardown of a non-received purchase, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);

    // Status must be untouched by the rejected submission.
    const after = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(after.body.status).toBe('ordered');
  });

  it('reconciles a mix of present/different/missing + an additional find into the right Part records', async () => {
    const { purchaseId, expectedPartIds } = await createPurchaseWithThreeExpectedParts('reconcile-mix');

    // Advance ordered -> shipped -> received (Req 5's forward-only
    // lifecycle) so teardown is actually legal for this Purchase.
    const shipped = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    const received = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    expect(received.status, JSON.stringify(received.body)).toBe(200);

    const submitRes = await postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [
        { expectedPartId: expectedPartIds.cpu, result: 'present_as_expected', note: null },
        { expectedPartId: expectedPartIds.gpu, result: 'present_but_different', note: 'Different GPU model than listed' },
        { expectedPartId: expectedPartIds.ram, result: 'missing', note: 'RAM never arrived' },
      ],
      additionalParts: [{ category: 'Storage', description: 'Bonus SSD found inside', note: 'Not on the listing' }],
    });
    expect(submitRes.status, `teardown submission failed: ${JSON.stringify(submitRes.body)}`).toBe(200);

    // The Purchase itself must have advanced to torn_down.
    expect(submitRes.body.purchaseStatus).toBe('torn_down');

    // Four reconciliation lines recorded: one per Expected Part plus the
    // one Additional Part.
    expect(submitRes.body.teardownResults).toHaveLength(4);

    // Exactly three Part records: CPU (present_as_expected) + GPU
    // (present_but_different) + the additional SSD. Zero for the missing
    // RAM — this is the count this test exists to pin down.
    expect(submitRes.body.createdParts, `expected exactly 3 created Parts (none for the missing RAM), got: ${JSON.stringify(submitRes.body.createdParts)}`).toHaveLength(3);
    const createdCategories = submitRes.body.createdParts.map((part) => part.category).sort();
    expect(createdCategories).toEqual(['CPU', 'GPU', 'Storage']);
    // Confirms the missing RAM specifically produced no Part, not just that
    // the total count happens to match.
    expect(createdCategories).not.toContain('RAM');

    // Reconcile against the real GET endpoint too, not just the POST
    // response — proves the Parts actually persisted, not just echoed back.
    const partsList = await getJson<ListPartsResponse>(`${server.baseUrl}/api/parts?purchaseId=${purchaseId}&limit=20`);
    expect(partsList.body.total).toBe(3);
    expect(partsList.body.parts.map((part) => part.category).sort()).toEqual(['CPU', 'GPU', 'Storage']);

    // Purchase status change also persisted, not just echoed.
    const purchaseAfter = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(purchaseAfter.body.status).toBe('torn_down');
  });
});
