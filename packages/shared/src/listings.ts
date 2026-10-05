// Listing + Expected Part domain types shared between apps/server (route
// request/response bodies) and apps/web (API client + UI state). Mirrors the
// DuckDB row shapes in apps/server/src/db/types.ts, plus the request bodies
// and the Req 3 computed comparison the HTTP layer adds on top — this file
// lives here (not apps/server) because apps/web may never import apps/server
// directly (standing check).
import type { IdentityCandidate } from './aiIdentification.js';

/** Fixed component category list (assumption A8), not user-configurable. */
export type ComponentCategory =
  | 'CPU'
  | 'GPU'
  | 'Motherboard'
  | 'RAM'
  | 'Storage'
  | 'PSU'
  | 'Case'
  | 'Cooler'
  | 'Other';

/** Listing lifecycle (Req 4). Accepting one creates a linked Purchase (T7+). */
export type ListingStatus = 'open' | 'accepted' | 'rejected';

/**
 * One expected part on a Listing, with its estimated resale value (Req 2-3).
 * `brand` and `partNumber` are the structured identity of the component
 * (e.g. "NVIDIA" / "RTX 3060"); both are null whenever the part has not been
 * confidently identified — they are never guessed or filled with placeholder
 * text. `description` keeps its separate role: condition notes and whatever
 * context brand/partNumber do not already carry. `identityCandidates` holds
 * other plausible brand/partNumber pairings from AI identification that
 * weren't picked as primary (empty when not AI-identified or unambiguous).
 */
export interface ExpectedPart {
  id: string;
  listingId: string;
  componentCategory: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  estimatedResaleValue: number;
  identityCandidates: IdentityCandidate[];
  createdAt: string;
  updatedAt: string;
}

/** A candidate pre-built computer found on a Source (Req 2-4). */
export interface Listing {
  id: string;
  sourceId: string;
  title: string;
  description: string | null;
  listingUrl: string | null;
  askingPrice: number;
  listingDate: string;
  status: ListingStatus;
  acquisitionFees: number;
  /** Local-disk paths to uploaded photos (assumption A4), relative to data/. */
  photoPaths: string[];
  /** Connector that created this Listing via automated scan (e.g. 'ebay'), null for manually-entered Listings. */
  externalSource: string | null;
  /** Marketplace-native item id, used with externalSource to dedupe re-scans against already-ingested Listings. */
  externalItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The Req 3 comparison: sum of Expected Parts' estimated resale values vs.
 * (asking price + acquisition fees/shipping), plus their difference — so
 * neither side of the HTTP boundary needs to recompute it from raw figures.
 */
export interface ListingComparison {
  totalExpectedResaleValue: number;
  totalCost: number;
  difference: number;
}

/** `GET /api/listings` row shape: a Listing plus its comparison (Req 3, 12). */
export type ListingSummary = Listing & { comparison: ListingComparison };

/** `GET /api/listings/:id` shape: a Listing with its full Expected Parts set. */
export type ListingDetail = ListingSummary & { expectedParts: ExpectedPart[] };


/** `GET /api/listings` response: one page of Listing summaries plus the total count matching the filters, so apps/web can render pagination controls without an unbounded fetch (Req 12, 15). */
export interface ListListingsResponse {
  listings: ListingSummary[];
  total: number;
}

/** `POST /api/listings/:id/accept` response: the now-accepted Listing plus the id of the Purchase created from it (Req 4). A full Purchase shape isn't defined here yet — T8 introduces it alongside the Purchases API this id will then resolve against. */
export interface AcceptListingResponse {
  listing: ListingDetail;
  purchaseId: string;
}

/** One row of the Expected Parts editor in a create/edit request body. `brand`/`partNumber` are null when the user has not identified the component. */
export interface ExpectedPartInput {
  componentCategory: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  estimatedResaleValue: number;
  identityCandidates: IdentityCandidate[];
}

/**
 * Request body for `POST /api/listings` and `PUT /api/listings/:id`. The
 * `expectedParts` array fully replaces the Listing's set on PUT — there is
 * no separate per-row edit endpoint in this task's scope.
 */
export interface CreateListingInput {
  sourceId: string;
  title: string;
  description: string | null;
  listingUrl: string;
  askingPrice: number;
  listingDate: string;
  acquisitionFees: number;
  expectedParts: ExpectedPartInput[];
}

/** Request body for `PUT /api/listings/:id`. Same shape as create. */
export type UpdateListingInput = CreateListingInput;
