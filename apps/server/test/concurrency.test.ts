// T14 standing-check proof: "Concurrent creation of Listings, Purchases, and
// Parts under genuinely parallel HTTP requests never collides on generated
// IDs or loses a record — proven with real parallel requests against the
// running server, not sequential calls in turn."
//
// Every primary key in this schema is an application-generated UUID
// (db/id.ts's newId(), via node:crypto randomUUID) rather than a DB-side
// auto-increment sequence, specifically so two concurrent requests can never
// be assigned the same id. This suite is what actually proves that claim: it
// boots the real server (helpers.ts) and fires N requests at a time via
// Promise.all — genuine concurrency, not sequential calls dressed up as
// parallel — through each of the three real write paths that create these
// rows (POST /api/listings, POST /api/listings/:id/accept, POST
// /api/purchases/:id/teardown), then reconciles the actual DB state (via the
// real GET list endpoints) against the N requests fired: every response must
// be 2xx, every id must be unique, and the stored row count must equal N
// exactly (no silent loss).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListingDetail,
  ListListingsResponse,
  ListPartsResponse,
  ListPurchasesResponse,
  PurchaseDetail,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import { getJson, patchJson, postJson, startTestServer, type TestServer } from './helpers.js';

// >= 20 per the task's requirement; large enough that a real id collision or
// a lost write under concurrency would be very unlikely to hide by chance.
const N = 25;
// Arbitrary high port unlikely to collide with the dev server's default
// 3001 or any other local service, so this suite can run alongside `npm run
// dev` without a port conflict.
const TEST_PORT = 34_591;

interface SourceResponse {
  id: string;
}

// Builds a distinct create-Listing request body for index `i`: a unique
function listingBody(i: number, sourceId: string): CreateListingInput {
  return {
    sourceId,
    title: `Concurrency Test Listing ${i}`,
    description: null,
    listingUrl: `https://example.com/listing-${i}`,
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    expectedParts: [{ componentCategory: 'CPU', description: `Test CPU ${i}`, estimatedResaleValue: 50 }],
  };
}

// Asserts every response in `responses` returned a 2xx status, reporting the
// first few failing bodies verbatim rather than just a count, so a real
// concurrency failure's evidence (the actual error response) survives into
// the test output instead of being silently swallowed.
function expectAll2xx(responses: { status: number; body: unknown }[], label: string): void {
  const failures = responses.filter((r) => r.status < 200 || r.status >= 300);
  expect(failures, `${label}: expected all ${responses.length} requests to return 2xx; failures: ${JSON.stringify(failures.slice(0, 5))}`).toHaveLength(0);
}

describe('concurrent write proof (T14)', () => {
  let server: TestServer;
  let sourceId: string;
  // Populated by the Listings test, consumed by the Purchases and Parts
  // tests below (each test depends on the previous one's real server state
  // — vitest runs `it` blocks within a `describe` in declaration order).
  let listingIds: string[] = [];
  let expectedPartIdByListingId = new Map<string, string>();
  let purchaseIds: string[] = [];

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Concurrency Test Source',
      platformType: 'ebay',
      url: 'https://example.com/concurrency-test',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 95_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it(`creates ${N} Listings via genuinely parallel POST requests with no id collisions or losses`, async () => {
    // The concurrency under test: all N requests are issued together via
    // Promise.all, not awaited one at a time.
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) => postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(i, sourceId))),
    );
    expectAll2xx(responses, 'POST /api/listings');

    listingIds = responses.map((r) => r.body.id);
    expectedPartIdByListingId = new Map(responses.map((r) => [r.body.id, r.body.expectedParts[0].id]));
    expect(new Set(listingIds).size, 'every created Listing id must be unique').toBe(N);

    // Reconcile against the real GET endpoint: total and row count must
    // match N exactly, and the stored ids themselves must still be unique
    // (catches a write that silently overwrote another row's id slot).
    const list = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=${N + 10}`);
    expect(list.body.total, 'GET /api/listings total must equal N — no Listing may be silently lost').toBe(N);
    expect(list.body.listings).toHaveLength(N);
    expect(new Set(list.body.listings.map((l) => l.id)).size).toBe(N);
  }, 30_000);

  it(`accepts ${N} Listings concurrently, creating ${N} distinct Purchases with no id collisions or losses`, async () => {
    const responses = await Promise.all(
      listingIds.map((id) => postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${id}/accept`, {})),
    );
    expectAll2xx(responses, 'POST /api/listings/:id/accept');

    purchaseIds = responses.map((r) => r.body.purchaseId);
    expect(new Set(purchaseIds).size, 'every created Purchase id must be unique').toBe(N);

    const list = await getJson<ListPurchasesResponse>(`${server.baseUrl}/api/purchases?limit=${N + 10}`);
    expect(list.body.total, 'GET /api/purchases total must equal N — no Purchase may be silently lost').toBe(N);
    expect(list.body.purchases).toHaveLength(N);
    expect(new Set(list.body.purchases.map((p) => p.id)).size).toBe(N);
  }, 30_000);

  it(`tears down ${N} Purchases concurrently, creating exactly one Part each with no id collisions or losses`, async () => {
    // Each Purchase's own ordered -> shipped -> received -> torn_down
    // lifecycle is forward-only one step at a time (purchaseValidation.ts),
    // so the two status advances below run sequentially *within* one
    // Purchase — but all N Purchases advance and tear down concurrently
    // with each other via the outer Promise.all, which is the genuine
    // concurrency this test exists to exercise.
    const responses = await Promise.all(
      purchaseIds.map(async (purchaseId, i) => {
        const shipped = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
        const received = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
        expectAll2xx([shipped, received], `PATCH .../status for purchase ${purchaseId}`);

        const expectedPartId = expectedPartIdByListingId.get(listingIds[i]);
        return postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
          results: [{ expectedPartId, result: 'present_as_expected', note: null }],
          additionalParts: [],
        });
      }),
    );
    expectAll2xx(responses, 'POST /api/purchases/:id/teardown');

    // 'present_as_expected' (as opposed to 'missing') always produces
    // exactly one Part per Purchase (teardown.ts), so exactly N total here.
    for (const r of responses) {
      expect(r.body.createdParts, `teardown of purchase ${r.body.purchaseId} should create exactly one Part`).toHaveLength(1);
    }
    const partIds = responses.map((r) => r.body.createdParts[0].id);
    expect(new Set(partIds).size, 'every created Part id must be unique').toBe(N);

    const list = await getJson<ListPartsResponse>(`${server.baseUrl}/api/parts?limit=${N + 10}`);
    expect(list.body.total, 'GET /api/parts total must equal N — no Part may be silently lost').toBe(N);
    expect(list.body.parts).toHaveLength(N);
    expect(new Set(list.body.parts.map((p) => p.id)).size).toBe(N);
  }, 60_000);
});
