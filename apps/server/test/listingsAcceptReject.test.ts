// T7 proof: POST /api/listings/:id/accept and /reject (Req 4, 12, 15).
// Boots the real server via helpers.ts's startTestServer, the same pattern
// T6's listings.test.ts and T14's concurrency.test.ts use, so these
// assertions exercise the actual HTTP routes/db-query code rather than a
// mock. Deliberately never touches POST/GET/PUT /api/listings (T6's CRUD
// scope) — only the accept/reject handlers and the status/sourceId filters
// on GET /api/listings that the Listings queue screen (Req 12, 15) relies
// on to narrow the accept/reject-eligible set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AcceptListingResponse, CreateListingInput, ListingDetail, ListListingsResponse, PurchaseDetail } from '@pc-parts-flipper/shared';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from every other suite's TEST_PORT (concurrency.test.ts:
// 34_591, parts.test.ts/teardown.test.ts: 34_592, profit.test.ts/
// saleListings.test.ts: 34_593, sources.test.ts: 34_597, purchases.test.ts:
// 34_599, app-shell.test.ts: 34_601, listings.test.ts: 34_602,
// sales.test.ts: 34_612, teardown.test.ts: 34_625) so this suite can run
// alongside every other without a port collision.
const TEST_PORT = 34_603;

interface SourceResponse {
  id: string;
}

// Builds a valid create-Listing request body; callers override individual
// fields per test via the spread, mirroring listings.test.ts's precedent.
function listingBody(sourceId: string, overrides: Partial<CreateListingInput> = {}): CreateListingInput {
  return {
    sourceId,
    title: 'Lenovo ThinkCentre M920 bundle',
    description: 'Untested, seller says it powers on',
    listingUrl: 'https://example.com/listing/m920',
    askingPrice: 150,
    listingDate: '2026-01-20',
    acquisitionFees: 10,
    expectedParts: [{ componentCategory: 'CPU', brand: 'Intel', partNumber: 'i5-9500', description: 'Pulled, tested', estimatedResaleValue: 80 }],
    ...overrides,
  };
}

describe('Listings accept/reject + queue filters (T7)', () => {
  let server: TestServer;
  let sourceIdA: string;
  let sourceIdB: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceResA = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'T7 Test Source A',
      platformType: 'ebay',
      url: 'https://example.com/t7-source-a',
      notes: null,
    });
    expect(sourceResA.status, `seed Source A creation failed: ${JSON.stringify(sourceResA.body)}`).toBe(201);
    sourceIdA = sourceResA.body.id;

    const sourceResB = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'T7 Test Source B',
      platformType: 'facebook_marketplace',
      url: 'https://example.com/t7-source-b',
      notes: null,
    });
    expect(sourceResB.status, `seed Source B creation failed: ${JSON.stringify(sourceResB.body)}`).toBe(201);
    sourceIdB = sourceResB.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it("accept creates a linked Purchase pre-filled with the Listing's price (Req 4)", async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceIdA, { askingPrice: 222 }));
    expect(created.status, `seed Listing creation failed: ${JSON.stringify(created.body)}`).toBe(201);
    const listingId = created.body.id;

    const accepted = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingId}/accept`, {});
    expect(accepted.status, `accept failed: ${JSON.stringify(accepted.body)}`).toBe(201);
    expect(accepted.body.listing.status).toBe('accepted');
    expect(accepted.body.listing.id).toBe(listingId);
    expect(accepted.body.purchaseId).toBeTypeOf('string');

    // Reconcile against the real Purchase row (not just the accept
    // response) so a Purchase that was never actually persisted, or
    // persisted with the wrong link/price, is caught.
    const purchase = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${accepted.body.purchaseId}`);
    expect(purchase.status, `GET purchase failed: ${JSON.stringify(purchase.body)}`).toBe(200);
    expect(purchase.body.listingId).toBe(listingId);
    expect(purchase.body.pricePaid, "Purchase pricePaid must be pre-filled from the Listing's askingPrice").toBe(222);
  }, 30_000);

  it('rejects a second accept against an already-accepted Listing, and a reject against an already-accepted Listing, both with 400', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceIdA));
    expect(created.status).toBe(201);
    const listingId = created.body.id;

    const firstAccept = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingId}/accept`, {});
    expect(firstAccept.status, `first accept failed: ${JSON.stringify(firstAccept.body)}`).toBe(201);

    const secondAccept = await postJson<{ error: string }>(`${server.baseUrl}/api/listings/${listingId}/accept`, {});
    expect(secondAccept.status, 'a second accept against an already-decided Listing must be rejected').toBe(400);

    const rejectAfterAccept = await postJson<{ error: string }>(`${server.baseUrl}/api/listings/${listingId}/reject`, {});
    expect(rejectAfterAccept.status, 'reject against an already-accepted Listing must be rejected').toBe(400);

    // The Listing must still read back as 'accepted' — neither rejected
    // call may have silently re-applied a different status.
    const final = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingId}`);
    expect(final.body.status).toBe('accepted');
  }, 30_000);

  it('rejects a second reject against an already-rejected Listing with 400, and leaves it rejected', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceIdA));
    expect(created.status).toBe(201);
    const listingId = created.body.id;

    const firstReject = await postJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingId}/reject`, {});
    expect(firstReject.status, `first reject failed: ${JSON.stringify(firstReject.body)}`).toBe(200);
    expect(firstReject.body.status).toBe('rejected');

    const secondReject = await postJson<{ error: string }>(`${server.baseUrl}/api/listings/${listingId}/reject`, {});
    expect(secondReject.status, 'a second reject against an already-decided Listing must be rejected').toBe(400);

    const final = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingId}`);
    expect(final.body.status).toBe('rejected');
  }, 30_000);

  it("narrows the queue by statuses and sourceIds independently, and combined (Req 12, 15)", async () => {
    // Fresh Source-B listing, left open, so this test's status/source
    // counts are unaffected by the open Listings the earlier tests left on
    // Source A.
    const openOnB = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceIdB, { title: 'Source-B open listing' }));
    expect(openOnB.status).toBe(201);

    const acceptedOnA = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceIdA, { title: 'Source-A soon-accepted listing' }));
    expect(acceptedOnA.status).toBe(201);
    const acceptResult = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${acceptedOnA.body.id}/accept`, {});
    expect(acceptResult.status).toBe(201);

    // statuses filter alone: every row returned must actually carry that
    // status (not just the right count), and the just-accepted Listing
    // must be present.
    const acceptedFiltered = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?statuses=accepted&limit=100`);
    expect(acceptedFiltered.status).toBe(200);
    expect(acceptedFiltered.body.listings.every((l) => l.status === 'accepted'), 'statuses=accepted must only return accepted Listings').toBe(true);
    expect(acceptedFiltered.body.listings.map((l) => l.id)).toContain(acceptedOnA.body.id);

    // sourceIds filter alone: every row returned must belong to Source B,
    // and the Source-B open listing must be present while the Source-A one
    // must not.
    const bFiltered = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?sourceIds=${sourceIdB}&limit=100`);
    expect(bFiltered.status).toBe(200);
    expect(bFiltered.body.listings.every((l) => l.sourceId === sourceIdB), 'sourceIds filter must only return that Source\'s Listings').toBe(true);
    const bIds = bFiltered.body.listings.map((l) => l.id);
    expect(bIds).toContain(openOnB.body.id);
    expect(bIds).not.toContain(acceptedOnA.body.id);

    // Combined statuses + sourceIds: Source A has an accepted Listing, so
    // statuses=accepted&sourceIds=A must include it...
    const combinedHit = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?statuses=accepted&sourceIds=${sourceIdA}&limit=100`);
    expect(combinedHit.body.listings.map((l) => l.id)).toContain(acceptedOnA.body.id);

    // ...while statuses=accepted&sourceIds=B must exclude it (Source B's
    // only Listing here is still open), proving the two filters actually
    // AND together rather than either one alone satisfying the query.
    const combinedMiss = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?statuses=accepted&sourceIds=${sourceIdB}&limit=100`);
    expect(combinedMiss.body.listings.map((l) => l.id)).not.toContain(acceptedOnA.body.id);
  }, 30_000);

  it('fires two genuinely parallel accepts at the same open Listing via Promise.all and allows exactly one to win (Req 4)', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceIdA, { title: 'Double-accept race target' }));
    expect(created.status).toBe(201);
    const listingId = created.body.id;

    // The concurrency under test: both requests issued together via
    // Promise.all against the SAME Listing id, not sequential calls.
    const [first, second] = await Promise.all([
      postJson<AcceptListingResponse | { error: string }>(`${server.baseUrl}/api/listings/${listingId}/accept`, {}),
      postJson<AcceptListingResponse | { error: string }>(`${server.baseUrl}/api/listings/${listingId}/accept`, {}),
    ]);

    const statuses = [first.status, second.status].sort();
    const successes = [first, second].filter((r) => r.status === 201);
    const conflicts = [first, second].filter((r) => r.status === 409);

    // The CAS-guarded UPDATE in transitionOpenListing must let exactly one
    // of two genuinely parallel accepts win: the other must get back a 409
    // conflict, never a second 201 and never a 500.
    expect(statuses, `expected exactly one 201 and one 409, got ${JSON.stringify(statuses)}`).toEqual([201, 409]);
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(1);

    // Reconcile against the real persisted Purchase rows: exactly one
    // Purchase may exist for this Listing — a prior read-then-write bug
    // let both parallel accepts create a Purchase.
    const purchases = await getJson<{ purchases: { id: string; listingId: string }[]; total: number }>(
      `${server.baseUrl}/api/purchases?limit=500`,
    );
    const purchasesForListing = purchases.body.purchases.filter((p) => p.listingId === listingId);
    expect(purchasesForListing.length, 'exactly one Purchase must be created for the Listing (Req 4)').toBe(1);

    // The Listing itself must land on 'accepted', not get stuck mid-race.
    const final = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingId}`);
    expect(final.body.status).toBe('accepted');
  }, 30_000);
});
