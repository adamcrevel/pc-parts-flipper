// Listing + Expected Part domain types shared between apps/server (route
// request/response bodies) and apps/web (API client + UI state). Mirrors the
// DuckDB row shapes in apps/server/src/db/types.ts, plus the request bodies
// and the Req 3 computed comparison the HTTP layer adds on top — this file
// lives here (not apps/server) because apps/web may never import apps/server
// directly (standing check).
import type { AiPartConfidence, AiPartSource, IdentityCandidate } from './aiIdentification.js';
import type { IdentifyPartsJobStage } from './identifyPartsJob.js';

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
  estimatedResaleValue: number | null;
  identityCandidates: IdentityCandidate[];
  // Set only for a part identify-parts added and the user hasn't edited
  // since (apps/server/src/jobs/identifyPartsWorkerPool.ts writes these
  // the moment a job completes); null for a manually-entered row, or one
  // the user has since touched. Both present together or both null —
  // never one without the other.
  aiConfidence?: AiPartConfidence | null;
  aiSource?: AiPartSource | null;
  // Three-state (assumption A22, correcting A8). Null means *undecided*:
  // nobody has claimed this row's price, so the server may claim it for the
  // background price-estimation pipeline the first time the row has a brand
  // + partNumber and no price of its own. 'auto' means the pipeline owns
  // this row's estimatedResaleValue and may write a cached or freshly
  // researched value onto it. 'manual' means the user has explicitly taken
  // ownership — typed a price, or cleared one the pipeline had filled in —
  // and the row is never auto-claimed or cache-overwritten again. Optional
  // for the same backward-fixture-compatibility reason as the pair above.
  priceSource?: 'auto' | 'manual' | null;
  /** The working/non-working status of this component. */
  workingStatus: 'working' | 'non_working';
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
  /** Whether this listing's computer cannot be powered on or has non-functional components (server-only field, never from request body). */
  nonWorking: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The Req 3 comparison: sum of Expected Parts' estimated resale values vs.
 * (asking price + acquisition fees/shipping), plus their difference — so
 * neither side of the HTTP boundary needs to recompute it from raw figures.
 */
export interface ListingComparison {
  totalEstimatedResaleValue: number;
  totalCost: number;
  margin: number;
}

/**
 * `GET /api/listings` row shape: a Listing plus its comparison (Req 3, 12),
 * plus the status of the most recent Identify-Parts job run against it
 * (null if no job has ever run for this Listing), so apps/web can render
 * per-row progress/error state without a second request per Listing.
 */
export type ListingSummary = Listing & {
  comparison: ListingComparison;
  identifyPartsStatus: { stage: IdentifyPartsJobStage; errorMessage: string | null } | null;
};

/** `GET /api/listings/:id` shape: a Listing with its full Expected Parts set. */
export type ListingDetail = ListingSummary & { expectedParts: ExpectedPart[] };


/** `GET /api/listings` response: one page of Listing summaries plus the total count matching the filters, so apps/web can render pagination controls without an unbounded fetch (Req 12, 15). */
export interface ListListingsResponse {
  listings: ListingSummary[];
  totalCount: number;
}

/** `GET /api/listings/ids` response: every Listing id matching the current filters, so apps/web can resolve "select all" to a full id set without paginating. */
export interface ListListingIdsResponse {
  ids: string[];
}

/** `POST /api/listings/:id/accept` response: the now-accepted Listing plus the id of the Purchase created from it (Req 4). A full Purchase shape isn't defined here yet — T8 introduces it alongside the Purchases API this id will then resolve against. */
export interface AcceptListingResponse {
  listing: Listing;
  purchaseId: string;
}

/** One row of the Expected Parts editor in a create/edit request body. `brand`/`partNumber` are null when the user has not identified the component. */
export interface ExpectedPartInput {
  componentCategory: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  estimatedResaleValue: number | null;
  identityCandidates: IdentityCandidate[];
  // Carried through from the row's own aiConfidence/aiSource only while
  // it's still marked an unreviewed AI suggestion (row.aiSuggested); null
  // otherwise, including once the user has edited the row — see
  // ExpectedPart's doc comment above. Required (unlike ExpectedPart's own
  // optional pair): every writer of this request-body shape is new code
  // in this same change, so there's no legacy caller to stay compatible
  // with, and a required field catches a writer that forgot to decide.
  aiConfidence: AiPartConfidence | null;
  aiSource: AiPartSource | null;
  // The row's current priceSource, carried straight back from whatever the
  // client holds, so resaving leaves the row's ownership untouched: 'auto'
  // stays the pipeline's, 'manual' stays the user's (the editor flips an
  // 'auto' row to 'manual' the moment the user edits it, which is what
  // stops the server re-claiming a price the user just cleared). Optional,
  // unlike the required pair above: a client built before this feature
  // simply omits it, which reads the same as null — undecided.
  priceSource?: 'auto' | 'manual' | null;
  /** The working/non-working status of this component; omitted defaults to 'working'. */
  workingStatus?: 'working' | 'non_working' | null;
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
