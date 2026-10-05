// T11 proof: Sale Listings API (Req 8) — "draft prep pre-filled from a
// ready_to_list Part" and "mark-as-listed sets listed_at and moves the Part
// to 'listed'". Boots the real server (helpers.ts, the same pattern
// concurrency.test.ts uses) and drives it through the full upstream chain
// (Source -> Listing -> accept -> Purchase lifecycle -> teardown) to obtain
// a *real* ready_to_list Part, since Sale Listings cannot be drafted against
// a fabricated id — the draft route 404s/400s on anything that didn't come
// through teardown. Every assertion below reads the real HTTP response, not
// the production code's own return value, so none of these recompute the
// expectation with the code under test.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListingDetail,
  MarkSaleListingListedResponse,
  Part,
  PurchaseDetail,
  SaleListing,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Distinct from every other suite's TEST_PORT (concurrency.test.ts: 34_591,
// parts.test.ts: 34_592, profit.test.ts: 34_593, sources.test.ts: 34_597,
// purchases.test.ts: 34_599, app-shell.test.ts: 34_601, listings.test.ts:
// 34_602, listingsAcceptReject.test.ts: 34_603, sales.test.ts: 34_612,
// teardown.test.ts: 34_625) so vitest can run every suite's own spawned
// server concurrently (separate worker processes) without a port collision.
const TEST_PORT = 34_594;

interface SourceResponse {
  id: string;
}

// helpers.ts only exports GET/POST/PATCH wrappers (concurrency.test.ts never
// needed PUT); this suite's draft-edit test does, so it gets its own local
// wrapper rather than widening the shared test helper every other task's
// tester also pulls from.
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

describe('Sale Listings API (T11, Req 8)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  // Drives Source -> Listing -> accept -> Purchase (shipped -> received) ->
  // teardown (present_as_expected) to mint a brand-new, real ready_to_list
  // Part, so every test gets its own Part rather than sharing mutable state
  // across `it` blocks. `identity` is the Expected Part's brand/partNumber,
  // which the teardown carries into the Part and which the Sale Listing
  // draft's default title is then derived from.
  async function createReadyToListPart(
    label: string,
    identity: { brand: string | null; partNumber: string | null } = { brand: null, partNumber: null },
  ): Promise<Part> {
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: `Sale Listing Test Source ${label}`,
      platformType: 'ebay',
      url: `https://example.com/${label}`,
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);

    const listingBody: CreateListingInput = {
      sourceId: sourceRes.body.id,
      title: `Sale Listing Test Listing ${label}`,
      description: null,
      listingUrl: `https://example.com/listing-${label}`,
      askingPrice: 100,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      expectedParts: [{ componentCategory: 'GPU', brand: identity.brand, partNumber: identity.partNumber, description: `Test GPU ${label}`, estimatedResaleValue: 150 }],
    };
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody);
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
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
    expect(teardownRes.body.createdParts).toHaveLength(1);
    const part = teardownRes.body.createdParts[0];
    expect(part.status, 'a freshly torn-down present_as_expected Part must start ready_to_list').toBe('ready_to_list');
    return part;
  }

  it('falls back to the `category: description` title when the Part has neither brand nor part number', async () => {
    const part = await createReadyToListPart('prefill');
    // Precondition, not an assumption: this Part really is unidentified, so
    // the fallback below is the branch actually being exercised.
    expect(part.brand).toBeNull();
    expect(part.partNumber).toBeNull();

    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status, `draft creation failed: ${JSON.stringify(draftRes.body)}`).toBe(201);
    // The exact pre-fill contract (saleListingValidation.ts's
    // defaultSaleListingTitle): `${category}: ${description}`, taken from
    // the real Part just torn down, not a value this test invents.
    expect(draftRes.body.title).toBe(`${part.category}: ${part.description}`);
    expect(draftRes.body.description).toBe(part.description);
    expect(draftRes.body.platform).toBe('other');
    expect(draftRes.body.askingPrice).toBe(0);
    expect(draftRes.body.partId).toBe(part.id);
    expect(draftRes.body.listedAt).toBeNull();
  });

  it('titles the draft from the Part\'s brand and part number when it has them', async () => {
    const part = await createReadyToListPart('identified', { brand: 'NVIDIA', partNumber: 'RTX 3060' });
    // The whole point of carrying brand/partNumber through teardown: they
    // must have survived Expected Part -> Part before the title can use them.
    expect(part.brand).toBe('NVIDIA');
    expect(part.partNumber).toBe('RTX 3060');

    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status, `draft creation failed: ${JSON.stringify(draftRes.body)}`).toBe(201);
    expect(draftRes.body.title).toBe('NVIDIA RTX 3060');
    // And explicitly NOT the fallback — a title that merely "contains the
    // brand" would also pass a looser check while the fallback still ran.
    expect(draftRes.body.title).not.toBe(`${part.category}: ${part.description}`);
    // description keeps its own role; it is not replaced by the identity.
    expect(draftRes.body.description).toBe(part.description);
  });

  it('honors a client-supplied title/platform/askingPrice instead of the Part-derived default', async () => {
    const part = await createReadyToListPart('overrides');

    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {
      platform: 'facebook_marketplace',
      title: 'Custom override title',
      askingPrice: 42.5,
    });
    expect(draftRes.status, `draft creation failed: ${JSON.stringify(draftRes.body)}`).toBe(201);
    expect(draftRes.body.title).toBe('Custom override title');
    expect(draftRes.body.platform).toBe('facebook_marketplace');
    expect(draftRes.body.askingPrice).toBe(42.5);
  });

  it('rejects drafting a Sale Listing for a Part that is not ready_to_list', async () => {
    const part = await createReadyToListPart('not-ready');
    // Move the Part out of ready_to_list first, via the real mark-listed
    // route itself, so this is a genuine second draft attempt against an
    // already-listed Part — not a fabricated status.
    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status).toBe(201);
    const markRes = await postJson<MarkSaleListingListedResponse>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}/mark-listed`, {});
    expect(markRes.status, `mark-listed failed: ${JSON.stringify(markRes.body)}`).toBe(200);

    const secondDraftRes = await postJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(secondDraftRes.status).toBe(400);
    expect(secondDraftRes.body.error.message).toContain("not 'ready_to_list'");
  });

  it('rejects a negative askingPrice on draft creation with a 400 and inline error (Req 13)', async () => {
    const part = await createReadyToListPart('negative-price');
    const draftRes = await postJson<{ error: { message: string } }>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {
      askingPrice: -5,
    });
    expect(draftRes.status).toBe(400);
    expect(draftRes.body.error.message).toContain('asking price');
  });

  it('edits a draft via PUT while it is still unposted', async () => {
    const part = await createReadyToListPart('edit-draft');
    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status).toBe(201);

    const putRes = await putJson<SaleListing>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}`, { title: 'Edited draft title' });
    expect(putRes.status, `edit failed: ${JSON.stringify(putRes.body)}`).toBe(200);
    expect(putRes.body.title).toBe('Edited draft title');

    const getRes = await getJson<SaleListing>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}`);
    expect(getRes.body.title, 'the edit must actually persist, not just echo in the PUT response').toBe('Edited draft title');
  });

  it('marking a Sale Listing listed sets listedAt and moves the Part to listed', async () => {
    const part = await createReadyToListPart('mark-listed');
    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status).toBe(201);
    expect(draftRes.body.listedAt).toBeNull();

    const draftCreatedAtMs = new Date(draftRes.body.createdAt).getTime();
    const markRes = await postJson<MarkSaleListingListedResponse>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}/mark-listed`, {});
    expect(markRes.status, `mark-listed failed: ${JSON.stringify(markRes.body)}`).toBe(200);

    // listedAt must be a real, parseable timestamp strictly after the
    // draft's own createdAt — not just "truthy" — so a mutation that stamps
    // a fixed/garbage value, or never sets it, can't slip past. Both
    // timestamps come from the same server process/clock (unlike comparing
    // against this test process's own Date.now(), which this environment's
    // host/VM clock can drift from by hours between process starts).
    expect(markRes.body.saleListing.listedAt).not.toBeNull();
    const listedAtMs = new Date(markRes.body.saleListing.listedAt as string).getTime();
    expect(Number.isNaN(listedAtMs), `listedAt must parse as a real date, got ${markRes.body.saleListing.listedAt}`).toBe(false);
    expect(listedAtMs).toBeGreaterThanOrEqual(draftCreatedAtMs);

    expect(markRes.body.part.id).toBe(part.id);
    expect(markRes.body.part.status).toBe('listed');

    // Reconcile against a fresh GET of the Sale Listing, so the proof isn't
    // only the mutating response echoing its own input back.
    const getRes = await getJson<SaleListing>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}`);
    expect(getRes.body.listedAt).toBe(markRes.body.saleListing.listedAt);
  });

  it('rejects marking an already-listed Sale Listing listed a second time', async () => {
    const part = await createReadyToListPart('double-mark');
    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status).toBe(201);
    const firstMark = await postJson<MarkSaleListingListedResponse>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}/mark-listed`, {});
    expect(firstMark.status).toBe(200);

    const secondMark = await postJson<{ error: { message: string } }>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}/mark-listed`, {});
    expect(secondMark.status).toBe(400);
    expect(secondMark.body.error.message).toContain('already been listed');
  });

  it('rejects editing a Sale Listing via PUT once it has already been listed', async () => {
    const part = await createReadyToListPart('edit-after-listed');
    const draftRes = await postJson<SaleListing>(`${server.baseUrl}/api/parts/${part.id}/sale-listings`, {});
    expect(draftRes.status).toBe(201);
    const markRes = await postJson<MarkSaleListingListedResponse>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}/mark-listed`, {});
    expect(markRes.status).toBe(200);

    const putRes = await putJson<{ error: { message: string } }>(`${server.baseUrl}/api/sale-listings/${draftRes.body.id}`, { title: 'Too late' });
    expect(putRes.status).toBe(400);
    expect(putRes.body.error.message).toContain('already been listed');
  });
});
