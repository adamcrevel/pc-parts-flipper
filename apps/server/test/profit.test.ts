// T13 proof: the Profit dashboard aggregation endpoint (Req 10, 11, 15) —
// GET /api/purchases/profit. Boots the real server (helpers.ts, the same
// child-process-via-tsx pattern T14's concurrency.test.ts uses) and drives
// it through the full Source -> Listing -> accept -> Purchase lifecycle ->
// teardown -> Sale Listing -> Sale flow via real HTTP requests, then asserts
// the aggregated net-profit figure and the partial-vs-final flag the
// endpoint reports against hand-computed expected values — never against a
// value recomputed with the same formula the production code uses, which
// would just prove the code agrees with itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListingDetail,
  ListProfitResponse,
  MarkSaleListingListedResponse,
  PurchaseDetail,
  RecordSaleResponse,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from concurrency.test.ts's 34_591 so the two suites' spawned
// servers never fight over the same port if vitest runs files in parallel
// worker processes.
const TEST_PORT = 34_593;

interface SourceResponse {
  id: string;
}

// Builds a 2-Expected-Part Listing request body linked to `sourceId`, so
// its resulting Purchase tears down into exactly two Parts — enough to
// exercise both a "partial" Purchase (one Part resolved, one not) and a
// "final" one (every Part resolved) off the same shape.
function twoPartListingBody(title: string, sourceId: string, askingPrice: number): CreateListingInput {
  return {
    sourceId,
    title,
    description: null,
    listingUrl: `https://example.com/${title.replace(/\s+/g, '-').toLowerCase()}`,
    askingPrice,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    expectedParts: [
      { componentCategory: 'CPU', description: 'Part A', estimatedResaleValue: 50 },
      { componentCategory: 'GPU', description: 'Part B', estimatedResaleValue: 80 },
    ],
  };
}

// Drives one Listing through accept -> ordered/shipped/received ->
// teardown (both Expected Parts present_as_expected), returning the new
// Purchase id and the two generated Part ids in Expected-Part order. Shared
// by both scenarios below so neither duplicates the lifecycle plumbing.
async function createTornDownPurchase(baseUrl: string, listing: ListingDetail): Promise<{ purchaseId: string; partIds: string[] }> {
  const accept = await postJson<AcceptListingResponse>(`${baseUrl}/api/listings/${listing.id}/accept`, {});
  expect(accept.status, `accept failed: ${JSON.stringify(accept.body)}`).toBe(201);
  const purchaseId = accept.body.purchaseId;

  const shipped = await patchJson<PurchaseDetail>(`${baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
  const received = await patchJson<PurchaseDetail>(`${baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
  expect(shipped.status, `ship transition failed: ${JSON.stringify(shipped.body)}`).toBe(200);
  expect(received.status, `receive transition failed: ${JSON.stringify(received.body)}`).toBe(200);

  const teardown = await postJson<SubmitTeardownResponse>(`${baseUrl}/api/purchases/${purchaseId}/teardown`, {
    results: listing.expectedParts.map((ep) => ({ expectedPartId: ep.id, result: 'present_as_expected', note: null })),
    additionalParts: [],
  });
  expect(teardown.status, `teardown failed: ${JSON.stringify(teardown.body)}`).toBe(200);
  expect(teardown.body.createdParts, 'two present_as_expected results must create two Parts').toHaveLength(2);

  return { purchaseId, partIds: teardown.body.createdParts.map((p) => p.id) };
}

// Drives one ready_to_list Part through draft Sale Listing -> mark-listed
// -> record Sale, so its Purchase's profit rollup includes a realized sale.
async function sellPart(baseUrl: string, partId: string, soldPrice: number, platformFee: number, shippingCost: number): Promise<void> {
  const draft = await postJson<{ id: string }>(`${baseUrl}/api/parts/${partId}/sale-listings`, { askingPrice: soldPrice });
  expect(draft.status, `sale listing draft failed: ${JSON.stringify(draft.body)}`).toBe(201);
  const markListed = await postJson<MarkSaleListingListedResponse>(`${baseUrl}/api/sale-listings/${draft.body.id}/mark-listed`, {});
  expect(markListed.status, `mark-listed failed: ${JSON.stringify(markListed.body)}`).toBe(200);
  const sale = await postJson<RecordSaleResponse>(`${baseUrl}/api/parts/${partId}/sale`, {
    soldPrice,
    soldDate: '2026-01-15',
    platformFee,
    shippingCost,
  });
  expect(sale.status, `record sale failed: ${JSON.stringify(sale.body)}`).toBe(201);
}

describe('GET /api/purchases/profit aggregation (T13)', () => {
  let server: TestServer;
  let sourceId: string;
  // Purchase A: price paid 100, one of its two Parts sold (80, fee 5, ship
  // 3), the other left ready_to_list — a "partial"/running Purchase.
  // Hand-computed expectation: netProfit = 80 - (5 + 3) - 100 = -28;
  // isFinal = false (1 of 2 Parts resolved).
  let partialPurchaseId: string;
  // Purchase B: price paid 50, both Parts sold (40/fee2/ship1 and
  // 60/fee3/ship2) — a "final"/complete Purchase.
  // Hand-computed expectation: saleRevenue = 40 + 60 = 100,
  // feesAndShipping = (2 + 1) + (3 + 2) = 8, netProfit = 100 - 8 - 50 = 42;
  // isFinal = true (2 of 2 Parts resolved).
  let finalPurchaseId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Profit Test Source',
      platformType: 'ebay',
      url: 'https://example.com/profit-test',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;

    // --- Purchase A: partial ---
    const listingA = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, twoPartListingBody('Profit Partial Listing', sourceId, 100));
    expect(listingA.status).toBe(201);
    const { purchaseId: purchaseAId, partIds: partsA } = await createTornDownPurchase(server.baseUrl, listingA.body);
    partialPurchaseId = purchaseAId;
    // Only the first Part sells; the second stays ready_to_list (unresolved).
    await sellPart(server.baseUrl, partsA[0], 80, 5, 3);

    // --- Purchase B: final ---
    const listingB = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, twoPartListingBody('Profit Final Listing', sourceId, 50));
    expect(listingB.status).toBe(201);
    const { purchaseId: purchaseBId, partIds: partsB } = await createTornDownPurchase(server.baseUrl, listingB.body);
    finalPurchaseId = purchaseBId;
    // Both Parts sell, resolving the Purchase completely.
    await sellPart(server.baseUrl, partsB[0], 40, 2, 1);
    await sellPart(server.baseUrl, partsB[1], 60, 3, 2);
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('reports a partial Purchase with netProfit = realized sale revenue - fees/shipping - price paid, isFinal false', async () => {
    const res = await getJson<ListProfitResponse>(`${server.baseUrl}/api/purchases/profit?limit=50`);
    expect(res.status, `GET profit failed: ${JSON.stringify(res.body)}`).toBe(200);
    const row = res.body.purchases.find((p) => p.purchaseId === partialPurchaseId);
    expect(row, 'partial Purchase must appear in the profit rollup').toBeDefined();
    expect(row?.pricePaid).toBe(100);
    expect(row?.saleRevenue).toBe(80);
    expect(row?.feesAndShipping).toBe(8);
    // Hand-computed, not re-derived from saleRevenue/feesAndShipping above,
    // so a bug that corrupts the aggregation formula itself still gets
    // caught even if it corrupts saleRevenue/feesAndShipping consistently.
    expect(row?.netProfit).toBe(-28);
    expect(row?.totalParts).toBe(2);
    expect(row?.partsResolved).toBe(1);
    expect(row?.isFinal).toBe(false);
  });

  it('reports a fully-resolved Purchase with netProfit = total realized revenue - fees/shipping - price paid, isFinal true', async () => {
    const res = await getJson<ListProfitResponse>(`${server.baseUrl}/api/purchases/profit?limit=50`);
    expect(res.status, `GET profit failed: ${JSON.stringify(res.body)}`).toBe(200);
    const row = res.body.purchases.find((p) => p.purchaseId === finalPurchaseId);
    expect(row, 'final Purchase must appear in the profit rollup').toBeDefined();
    expect(row?.pricePaid).toBe(50);
    expect(row?.saleRevenue).toBe(100);
    expect(row?.feesAndShipping).toBe(8);
    expect(row?.netProfit).toBe(42);
    expect(row?.totalParts).toBe(2);
    expect(row?.partsResolved).toBe(2);
    expect(row?.isFinal).toBe(true);
  });

  it('filters by partial=true/false consistently with each row\'s own isFinal flag', async () => {
    const partialOnly = await getJson<ListProfitResponse>(`${server.baseUrl}/api/purchases/profit?partial=true&limit=50`);
    const finalOnly = await getJson<ListProfitResponse>(`${server.baseUrl}/api/purchases/profit?partial=false&limit=50`);
    expect(partialOnly.body.purchases.map((p) => p.purchaseId)).toContain(partialPurchaseId);
    expect(partialOnly.body.purchases.map((p) => p.purchaseId)).not.toContain(finalPurchaseId);
    expect(finalOnly.body.purchases.map((p) => p.purchaseId)).toContain(finalPurchaseId);
    expect(finalOnly.body.purchases.map((p) => p.purchaseId)).not.toContain(partialPurchaseId);
  });
});
