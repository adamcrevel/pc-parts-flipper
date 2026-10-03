// Purchase domain types shared between apps/server (route request/response
// bodies) and apps/web (API client + UI state). Mirrors the DuckDB row shape
// in apps/server/src/db/types.ts, plus the request bodies and the embedded
// Listing context the HTTP layer adds on top (Req 5) — this file lives here
// (not apps/server) because apps/web may never import apps/server directly
// (standing check). A full Purchase type was deferred by T7's accept
// endpoint (which only needed `purchaseId`); this task adds it.
import type { ExpectedPart, Listing } from './listings.js';

/** Purchase lifecycle (Req 5): moves forward one step at a time only. */
export type PurchaseStatus = 'ordered' | 'shipped' | 'received' | 'torn_down' | 'closed';

/** The actual buy created when a Listing is accepted (Req 4-5). */
export interface Purchase {
  id: string;
  listingId: string;
  status: PurchaseStatus;
  pricePaid: number;
  purchaseDate: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Minimal context about the originating Listing embedded in every list row,
 * so the Purchases list screen (and T9/T13, which also need this) never
 * needs a second round-trip just to show what was bought.
 */
export interface PurchaseListingSummary {
  id: string;
  title: string;
  expectedPartsCount: number;
}

/** `GET /api/purchases` row shape: a Purchase plus its Listing summary. */
export type PurchaseSummary = Purchase & { listing: PurchaseListingSummary };

/** `GET /api/purchases` response: one page plus the total matching count, so apps/web can paginate without an unbounded fetch (Req 5, 15). */
export interface ListPurchasesResponse {
  purchases: PurchaseSummary[];
  total: number;
}

/**
 * `GET /api/purchases/:id` shape: a Purchase with the full originating
 * Listing (including its Expected Parts), needed by this task's detail
 * screen and by T9's teardown screen, which reconciles against that same
 * Expected Parts list.
 */
export type PurchaseDetail = Purchase & { listing: Listing & { expectedParts: ExpectedPart[] } };

/** Request body for `PUT /api/purchases/:id`: price paid and purchase date only — status moves through the dedicated transition endpoint below. */
export interface UpdatePurchaseInput {
  pricePaid: number;
  purchaseDate: string;
}

/** Request body for `PATCH /api/purchases/:id/status`. */
export interface UpdatePurchaseStatusInput {
  status: PurchaseStatus;
}
