// T8 proof: Purchase lifecycle status transitions (Req 5) and the
// price-paid/purchase-date edit (Req 5, 13) against the real /api/purchases
// routes. Boots the real server as a child process (helpers.ts), the same
// pattern T14's concurrency.test.ts uses, on its own port and isolated
// DuckDB data dir so this suite never collides with concurrency.test.ts or
// a developer's `npm run dev` instance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcceptListingResponse, CreateListingInput, ListingDetail, PurchaseDetail } from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// PUTs `body` as JSON to `url` and returns the parsed response status/body.
// Not added to the shared helpers.ts (other testers run against that file
// concurrently in this batch, per listings.test.ts's precedent); kept
// local to this file instead.
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

// Distinct from every other suite's TEST_PORT (concurrency.test.ts:
// 34_591, parts.test.ts/teardown.test.ts: 34_592, profit.test.ts/
// saleListings.test.ts: 34_593, sources.test.ts: 34_597, app-shell.test.ts:
// 34_601, listings.test.ts: 34_602, sales.test.ts: 34_612) so every suite
// can run concurrently without a port collision.
const TEST_PORT = 34_599;

interface SourceResponse {
  id: string;
}

// Builds a distinct create-Listing request body, mirroring
// concurrency.test.ts's listingBody helper (same shape, this suite's own
// fixture values).
function listingBody(sourceId: string, askingPrice: number): CreateListingInput {
  return {
    sourceId,
    title: 'Purchase Lifecycle Test Listing',
    description: null,
    listingUrl: 'https://example.com/purchase-lifecycle-listing',
    askingPrice,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    expectedParts: [{ componentCategory: 'CPU', description: 'Test CPU', estimatedResaleValue: 50 }],
  };
}

describe('Purchases API: status lifecycle and price-paid edit (T8)', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Purchase Lifecycle Test Source',
      platformType: 'ebay',
      url: 'https://example.com/purchase-lifecycle-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  // Creates a fresh Listing + accepted Purchase (status 'ordered') for a
  // test to work against, isolated per-test so one test's status advances
  // never leak into another's assertions. Returns the real asking price
  // the accept endpoint pre-filled pricePaid from (Req 4), so the
  // price-paid-differs-from-asking-price test has a concrete baseline to
  // diverge from.
  async function createOrderedPurchase(askingPrice: number): Promise<{ purchaseId: string; askingPrice: number }> {
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId, askingPrice));
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
    expect(acceptRes.status, `accept failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);
    return { purchaseId: acceptRes.body.purchaseId, askingPrice };
  }

  it('accepts a valid one-step-forward status transition (ordered -> shipped)', async () => {
    const { purchaseId } = await createOrderedPurchase(200);
    const res = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    expect(res.status, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.status).toBe('shipped');

    // Reconcile against GET /api/purchases/:id — the write actually
    // persisted, not just an in-memory echo of the request.
    const fetched = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(fetched.body.status).toBe('shipped');
  }, 15_000);

  it('rejects a transition that skips a step (ordered -> received, skipping shipped)', async () => {
    const { purchaseId } = await createOrderedPurchase(200);
    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(res.status, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);
    // Names the specific invalid transition (current 'ordered', requested
    // 'received') rather than a generic validation message, so this
    // assertion can't pass for an unrelated 400 (e.g. a malformed body).
    expect(res.body.error.message).toMatch(/ordered/);
    expect(res.body.error.message).toMatch(/received/);

    // The rejected transition must not have been applied.
    const fetched = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(fetched.body.status).toBe('ordered');
  }, 15_000);

  it('rejects a backward transition (shipped -> ordered)', async () => {
    const { purchaseId } = await createOrderedPurchase(200);
    const advance = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    expect(advance.status).toBe(200);

    const res = await patchJson<{ error: { message: string } }>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'ordered' });
    expect(res.status, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);
    expect(res.body.error.message).toMatch(/shipped/);
    expect(res.body.error.message).toMatch(/ordered/);

    const fetched = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(fetched.body.status).toBe('shipped');
  }, 15_000);

  it('lets price paid diverge from the Listing asking price it was pre-filled from (Req 5, 13)', async () => {
    const { purchaseId, askingPrice } = await createOrderedPurchase(200);

    // Confirm the pre-fill baseline first: accept pre-fills pricePaid from
    // askingPrice (Req 4), so this test's premise — that the edit below
    // actually diverges from it — is grounded in a real observed value,
    // not assumed.
    const before = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(before.body.pricePaid).toBe(askingPrice);

    const edited = await putJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`, {
      pricePaid: 150,
      purchaseDate: '2026-01-05',
    });
    expect(edited.status, `expected 200, got ${edited.status}: ${JSON.stringify(edited.body)}`).toBe(200);
    expect(edited.body.pricePaid).toBe(150);
    expect(edited.body.pricePaid).not.toBe(askingPrice);
    expect(edited.body.purchaseDate.slice(0, 10)).toBe('2026-01-05');

    const fetched = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(fetched.body.pricePaid).toBe(150);
  }, 15_000);

  it('rejects a negative price paid on the edit endpoint with an inline-error-worthy 400 (Req 13)', async () => {
    const { purchaseId } = await createOrderedPurchase(200);
    const res = await putJson<{ error: string }>(`${server.baseUrl}/api/purchases/${purchaseId}`, {
      pricePaid: -5,
      purchaseDate: '2026-01-05',
    });
    expect(res.status, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);

    // The rejected edit must not have been applied — pricePaid still the
    // pre-filled asking price.
    const fetched = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(fetched.body.pricePaid).toBe(200);
  }, 15_000);
});
