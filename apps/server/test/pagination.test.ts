// T15 proof: deterministic LIMIT/OFFSET pagination. Before this fix, every
// paginated list query ordered only by its primary column (listing_date /
// purchase_date) with no tiebreaker, so rows tied on that column could sort
// in a different relative order between two consecutive page fetches —
// silently dropping some rows from both pages while duplicating others.
// Reproduced live against GET /api/listings: 24 Listings sharing one
// listing_date returned only 22 distinct ids across limit=20/offset=0 and
// limit=20/offset=20, with 2 ids duplicated and 2 missing entirely. Seeds
// many more rows than one page (500, so corruption anywhere in a long
// paginated walk is caught, not just at the first boundary) that all tie
// on the primary sort column, then asserts every page is disjoint from
// every other and their union is exactly the full seeded id set — the
// property that silently breaks without a
// secondary `id ASC` tiebreaker in the ORDER BY. Boots the real server via
// helpers.ts's startTestServer, the same pattern every other *.test.ts in
// this directory uses, so this exercises the actual HTTP routes/SQL rather
// than calling the query functions directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListingDetail,
  ListListingsResponse,
  ListPurchasesResponse,
} from '@pc-parts-flipper/shared';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from every other suite's TEST_PORT (see purchases.test.ts's
// comment for the full roster: 34_591-34_612) so this suite can run
// concurrently with the others without a port collision.
const TEST_PORT = 34_620;

// Seeds many more rows than one page (limit defaults to 20 on both
// endpoints under test) so the test walks many page boundaries, not just
// the first one, since the bug this guards against can surface at any
// boundary once rows tie on the primary sort column.
const SEED_COUNT = 500;

interface SourceResponse {
  id: string;
}

// Builds a create-Listing request body; every seeded Listing shares the
// same listingDate so they all tie on listings' primary sort column
// (listing_date DESC) and only `title` varies, to keep rows distinguishable
// in failure output without affecting sort order.
function listingBody(sourceId: string, index: number): CreateListingInput {
  return {
    sourceId,
    title: `Pagination Tiebreak Listing ${index}`,
    description: null,
    listingUrl: `https://example.com/pagination-listing-${index}`,
    askingPrice: 100,
    listingDate: '2026-02-01',
    acquisitionFees: 0,
    expectedParts: [{ componentCategory: 'CPU', brand: 'Intel', partNumber: 'i5-8500', description: 'Test CPU', estimatedResaleValue: 50 }],
  };
}

describe('Deterministic pagination tiebreaker across tied rows (T15)', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Pagination Tiebreak Test Source',
      platformType: 'ebay',
      url: 'https://example.com/pagination-tiebreak-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('returns disjoint, complete pages for Listings tied on listing_date (GET /api/listings)', async () => {
    const createdIds: string[] = [];
    for (let i = 0; i < SEED_COUNT; i++) {
      const res = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId, i));
      expect(res.status, `seed Listing ${i} creation failed: ${JSON.stringify(res.body)}`).toBe(201);
      createdIds.push(res.body.id);
    }
    const seededIds = new Set(createdIds);

    // Walk every page (not just the first two) to cover this suite's
    // Source so pre-existing Listings from another concurrently-running
    // suite's isolated DB can't change the expected counts (each suite
    // runs against its own temp DuckDB file via startTestServer, but this
    // keeps the filter explicit rather than relying on that isolation
    // alone). At SEED_COUNT=500 there are 25 pages of 20, so proving the
    // tiebreaker holds end-to-end requires checking every adjacent page
    // boundary, not only offset=0/20 — the bug this suite guards against
    // can surface at any boundary once rows tie on the primary sort
    // column.
    const pageSize = 20;
    const totalPages = SEED_COUNT / pageSize;
    const allIds: string[] = [];
    for (let p = 0; p < totalPages; p++) {
      const offset = p * pageSize;
      const page = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?sourceId=${sourceId}&limit=${pageSize}&offset=${offset}`);
      expect(page.status, `page offset=${offset} failed: ${JSON.stringify(page.body)}`).toBe(200);
      expect(page.body.listings).toHaveLength(Math.min(pageSize, SEED_COUNT - offset));
      allIds.push(...page.body.listings.map((l) => l.id));
    }

    // No id duplicated across any two pages.
    const unionIds = new Set(allIds);
    expect(unionIds.size, 'a row appearing on more than one page means the tiebreaker is missing/ineffective').toBe(SEED_COUNT);
    // The union across all pages must be exactly the seeded id set — no row
    // dropped, nothing from another run leaked in.
    expect(unionIds).toEqual(seededIds);
  }, 60_000);

  it('returns disjoint, complete pages for Purchases tied on purchase_date (GET /api/purchases)', async () => {
    // POST /api/listings/:id/accept stamps purchase_date as today's date
    // (apps/server/src/routes/listings.ts), so every Purchase accepted in
    // this test run naturally ties on the primary sort column without
    // needing a direct purchase_date input.
    const createdIds: string[] = [];
    for (let i = 0; i < SEED_COUNT; i++) {
      const listingRes = await postJson<ListingDetail>(
        `${server.baseUrl}/api/listings`,
        listingBody(sourceId, 1000 + i), // offset index so listingUrl stays unique from the Listings test above
      );
      expect(listingRes.status, `seed Listing ${i} creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
      const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
      expect(acceptRes.status, `accept ${i} failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);
      createdIds.push(acceptRes.body.purchaseId);
    }
    const seededIds = new Set(createdIds);

    // Walk every page by the server-reported `total` (this endpoint has no
    // Source filter to scope by, so pre-existing Purchases elsewhere in
    // this isolated DB could in principle extend the range beyond
    // SEED_COUNT). At SEED_COUNT=500 that's 25 pages of 20; checking every
    // adjacent boundary is required because the bug this suite guards
    // against can surface at any boundary once rows tie on purchase_date.
    const pageSize = 20;
    const allIds: string[] = [];
    let total = Infinity;
    for (let offset = 0; offset < total; offset += pageSize) {
      const page = await getJson<ListPurchasesResponse>(`${server.baseUrl}/api/purchases?limit=${pageSize}&offset=${offset}`);
      expect(page.status, `page offset=${offset} failed: ${JSON.stringify(page.body)}`).toBe(200);
      total = page.body.total;
      allIds.push(...page.body.purchases.map((p) => p.id));
    }

    // No id duplicated across any two pages.
    const unionIds = new Set(allIds);
    expect(unionIds.size, 'a row appearing on more than one page means the tiebreaker is missing/ineffective').toBe(allIds.length);
    // Every Purchase seeded by this test must appear exactly once across
    // all pages (union with the seeded set rather than equality guards
    // against any pre-existing Purchase from elsewhere in this isolated DB
    // landing on one of the pages observed).
    for (const id of seededIds) expect(unionIds.has(id), `seeded purchase ${id} missing from any page`).toBe(true);
  }, 90_000);
});
