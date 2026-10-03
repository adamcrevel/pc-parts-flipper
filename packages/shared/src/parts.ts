// Part-related HTTP types for the Parts list/detail/status-update screens
// (Req 7) — the Part row shape and PartStatus union themselves are defined
// in teardown.ts (the teardown submission is what first creates Parts) and
// re-exported from there; this file only adds the embedded Purchase/Listing
// context and request/response shapes the Parts screen's own HTTP layer
// needs on top. Lives here (not apps/server) because apps/web may never
// import apps/server directly (standing check).
import type { Part, PartStatus } from './teardown.js';

/**
 * Minimal context about the owning Purchase and its originating Listing,
 * embedded in every Part row so the Parts list (Req 7, 10) never needs a
 * second round-trip just to show what the part came from.
 */
export interface PartPurchaseSummary {
  id: string;
  listingTitle: string;
}

/** `GET /api/parts` and `GET /api/parts/:id` row shape: a Part plus its Purchase/Listing context. */
export type PartSummary = Part & { purchase: PartPurchaseSummary };

/** `GET /api/parts` response: one page plus the total matching count, so apps/web can paginate without an unbounded fetch (Req 7, 15). */
export interface ListPartsResponse {
  parts: PartSummary[];
  total: number;
}

/** Request body for `PATCH /api/parts/:id/status` (Req 7). `reason` is required only when `status` is `unsellable`; ignored otherwise. */
export interface UpdatePartStatusInput {
  status: PartStatus;
  reason?: string;
}
