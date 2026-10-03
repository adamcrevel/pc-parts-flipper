// T12 proof: the Sale-recording route (Req 9: record sale price/fees/
// shipping/date against a listed Part, moving it to 'sold') and Req 13's
// "rejects save on ... negative monetary field, with inline error — never
// silently accepts" as implemented by apps/server/src/routes/sales.ts +
// salesValidation.ts + apps/server/src/db/queries/sales.ts.
//
// Follows the same real-server-via-child-process pattern as T14's
// concurrency.test.ts (apps/server/test/helpers.ts's startTestServer): boots
// the actual Fastify app against an isolated temp DuckDB file and drives the
// real HTTP routes end to end, rather than importing handler functions
// directly. Getting a Part to 'listed' (the only status a sale can be
// recorded against) requires walking the full upstream pipeline for real
// through its own HTTP routes: Source -> Listing -> accept -> Purchase
// shipped/received -> teardown (creates the Part) -> draft Sale Listing ->
// mark-listed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListingDetail,
  ListSalesResponse,
  PurchaseDetail,
  RecordSaleResponse,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from concurrency.test.ts's 34_591 and sources.test.ts's 34_597 so
// every suite can run concurrently (e.g. `vitest run` executing all test
// files in parallel workers) without a port collision.
const TEST_PORT = 34_612;

interface SourceResponse {
  id: string;
}

// Shape of a draft Sale Listing as returned by POST /api/parts/:partId/sale-listings.
interface SaleListingResponse {
  id: string;
}

// Shape of the centralized error-handler body (error-handler.ts) that every
// AppError-driven 400 response returns.
interface ErrorResponse {
  error: { message: string; statusCode: number };
}

describe('Sale recording route (T12)', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Sales Test Source',
      platformType: 'ebay',
      url: 'https://example.com/sales-test',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  // Walks a brand-new Listing all the way through accept -> Purchase
  // shipped/received -> teardown -> draft Sale Listing -> mark-listed, and
  // returns the id of the resulting 'listed' Part — the only precondition
  // POST /api/parts/:partId/sale will accept a sale against (Req 9).
  async function createListedPart(titleSuffix: string): Promise<string> {
    const listingBody: CreateListingInput = {
      sourceId,
      title: `Sales Test Listing ${titleSuffix}`,
      description: null,
      listingUrl: `https://example.com/sales-listing-${titleSuffix}`,
      askingPrice: 100,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      expectedParts: [{ componentCategory: 'CPU', description: `Sales Test CPU ${titleSuffix}`, estimatedResaleValue: 50 }],
    };
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody);
    expect(listingRes.status, `Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    const expectedPartId = listingRes.body.expectedParts[0].id;

    const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
    expect(acceptRes.status, `accept failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);
    const purchaseId = acceptRes.body.purchaseId;

    const shippedRes = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    expect(shippedRes.status, `shipped transition failed: ${JSON.stringify(shippedRes.body)}`).toBe(200);
    const receivedRes = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(receivedRes.status, `received transition failed: ${JSON.stringify(receivedRes.body)}`).toBe(200);

    const teardownRes = await postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [{ expectedPartId, result: 'present_as_expected', note: null }],
      additionalParts: [],
    });
    expect(teardownRes.status, `teardown failed: ${JSON.stringify(teardownRes.body)}`).toBe(200);
    const partId = teardownRes.body.createdParts[0].id;

    const draftRes = await postJson<SaleListingResponse>(`${server.baseUrl}/api/parts/${partId}/sale-listings`, {});
    expect(draftRes.status, `draft Sale Listing failed: ${JSON.stringify(draftRes.body)}`).toBe(201);

    const markListedRes = await postJson(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}/mark-listed`, {});
    expect(markListedRes.status, `mark-listed failed: ${JSON.stringify(markListedRes.body)}`).toBe(200);

    return partId;
  }

  it('rejects a negative soldPrice, platformFee, or shippingCost with 400 and an inline error, leaving the Part listed', async () => {
    const partId = await createListedPart('negative');
    const validBody = { soldPrice: 100, soldDate: '2026-02-01', platformFee: 5, shippingCost: 10, buyerNote: null };

    const negativePrice = await postJson<ErrorResponse>(`${server.baseUrl}/api/parts/${partId}/sale`, { ...validBody, soldPrice: -1 });
    expect(negativePrice.status).toBe(400);
    expect(negativePrice.body.error.message).toMatch(/sold price/i);

    const negativeFee = await postJson<ErrorResponse>(`${server.baseUrl}/api/parts/${partId}/sale`, { ...validBody, platformFee: -5 });
    expect(negativeFee.status).toBe(400);
    expect(negativeFee.body.error.message).toMatch(/platform fee/i);

    const negativeShipping = await postJson<ErrorResponse>(`${server.baseUrl}/api/parts/${partId}/sale`, { ...validBody, shippingCost: -10 });
    expect(negativeShipping.status).toBe(400);
    expect(negativeShipping.body.error.message).toMatch(/shipping cost/i);

    // None of the three rejected requests may have mutated the Part's
    // status — it must still be exactly 'listed', not advanced to 'sold'.
    const partRes = await getJson<{ status: string }>(`${server.baseUrl}/api/parts/${partId}`);
    expect(partRes.body.status).toBe('listed');
  }, 30_000);

  it('records a valid sale, moves the Part to sold, and the Sale is retrievable', async () => {
    const partId = await createListedPart('valid');

    const saleRes = await postJson<RecordSaleResponse>(`${server.baseUrl}/api/parts/${partId}/sale`, {
      soldPrice: 125.5,
      soldDate: '2026-02-15',
      platformFee: 12.25,
      shippingCost: 8.75,
      buyerNote: 'Shipped via UPS',
    });
    expect(saleRes.status, `sale recording failed: ${JSON.stringify(saleRes.body)}`).toBe(201);
    expect(saleRes.body.sale.partId).toBe(partId);
    expect(saleRes.body.sale.soldPrice).toBe(125.5);
    expect(saleRes.body.sale.platformFee).toBe(12.25);
    expect(saleRes.body.sale.shippingCost).toBe(8.75);
    expect(saleRes.body.sale.buyerNote).toBe('Shipped via UPS');
    // The documented Req 7/9 side effect: the Part moves listed -> sold.
    expect(saleRes.body.part.status).toBe('sold');

    // Persisted and independently retrievable via GET /api/parts/:id...
    const partRes = await getJson<{ status: string }>(`${server.baseUrl}/api/parts/${partId}`);
    expect(partRes.body.status).toBe('sold');

    // ...and via GET /api/sales/:id...
    const saleId = saleRes.body.sale.id;
    const saleByIdRes = await getJson<{ id: string; soldPrice: number }>(`${server.baseUrl}/api/sales/${saleId}`);
    expect(saleByIdRes.status).toBe(200);
    expect(saleByIdRes.body.id).toBe(saleId);
    expect(saleByIdRes.body.soldPrice).toBe(125.5);

    // ...and via GET /api/sales?partId=.
    const listRes = await getJson<ListSalesResponse>(`${server.baseUrl}/api/sales?partId=${partId}`);
    expect(listRes.body.total).toBe(1);
    expect(listRes.body.sales.map((s) => s.id)).toContain(saleId);

    // A second sale attempt against the now-'sold' Part must be rejected
    // (Req 9: only a 'listed' Part accepts a sale).
    const secondSale = await postJson<ErrorResponse>(`${server.baseUrl}/api/parts/${partId}/sale`, {
      soldPrice: 50,
      soldDate: '2026-02-16',
      platformFee: 0,
      shippingCost: 0,
      buyerNote: null,
    });
    expect(secondSale.status).toBe(400);
  }, 30_000);
});
