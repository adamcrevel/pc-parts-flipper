// Sale Listing HTTP types for the Sale Listing prep screen (Req 8) — a
// draft/posted marketplace listing for one `ready_to_list` Part. Lives here
// (not apps/server) because apps/web may never import apps/server directly
// (standing check); mirrors the DuckDB row shape in apps/server/src/db/types.ts.
import type { PartSummary } from './parts.js';
import type { PlatformType } from './sources.js';

/**
 * A draft/posted marketplace listing for one Part (Req 8). Draft vs. posted
 * is represented by `listedAt` alone (null = draft, set = posted) rather
 * than a separate status column — one less field to keep in sync, and the
 * timestamp itself is the information a "when was this listed" display
 * needs anyway.
 */
export interface SaleListing {
  id: string;
  partId: string;
  platform: PlatformType;
  title: string;
  description: string | null;
  askingPrice: number;
  listedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for `POST /api/parts/:partId/sale-listings`. Every field is
 * optional: an omitted `platform` defaults server-side to `'other'`, an
 * omitted `askingPrice` defaults to `0`, and omitted `title`/`description`
 * are generated server-side from the Part's category/description (Req 8) —
 * all intended to be edited immediately afterward via
 * `PUT /api/sale-listings/:id` rather than required up front.
 */
export interface CreateSaleListingInput {
  platform?: PlatformType;
  title?: string;
  description?: string | null;
  askingPrice?: number;
}

/** Request body for `PUT /api/sale-listings/:id`. Every field is optional; an omitted key leaves that column unchanged. Rejected with a 400 once the listing has already been marked listed (Req 8: edits apply to drafts only). */
export type UpdateSaleListingInput = CreateSaleListingInput;

/** `GET /api/sale-listings` response: one page of Sale Listings plus the total matching count, so apps/web can paginate without an unbounded fetch (Req 8, 15). */
export interface ListSaleListingsResponse {
  saleListings: SaleListing[];
  total: number;
}

/** `POST /api/sale-listings/:id/mark-listed` response: the now-posted Sale Listing plus its Part, whose status has just moved `ready_to_list -> listed` (Req 7, 8). */
export interface MarkSaleListingListedResponse {
  saleListing: SaleListing;
  part: PartSummary;
}
