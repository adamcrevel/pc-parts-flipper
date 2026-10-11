// Row types for every DuckDB table owned by this data-access module, plus the
// enum unions that back DuckDB's native ENUM columns. These are intentionally
// local to apps/server (not packages/shared) for this task — promoting them
// to the shared package, so apps/web can reuse them over the HTTP API's JSON
// shapes, is left to the tasks that build the routes/screens on top of this
// module.
import type { AiPartConfidence, AiPartSource, IdentityCandidate } from '@pc-parts-flipper/shared';

// -- Enums -------------------------------------------------------------

/** Marketplace a Source/SaleListing lives on. Fixed set, matches Req 1 & 8. */
export type PlatformType = 'ebay' | 'facebook_marketplace' | 'other';

/** Listing lifecycle. Accepting creates a Purchase (Req 4). */
export type ListingStatus = 'open' | 'accepted' | 'rejected';

/** Purchase lifecycle (Req 5). */
export type PurchaseStatus = 'ordered' | 'shipped' | 'received' | 'torn_down' | 'closed';

/** Fixed component category list (assumption A8), used by ExpectedPart and Part. */
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

/** Outcome of reconciling one Expected Part during teardown (Req 6). */
export type TeardownResultType =
  | 'present_as_expected'
  | 'present_but_different'
  | 'missing'
  | 'additional';

/** Part lifecycle (Req 7). */
export type PartStatus = 'ready_to_list' | 'listed' | 'sold' | 'unsellable';

// -- Rows --------------------------------------------------------------

/** A purchase source: a place listings are found (Req 1). */
export interface Source {
  id: string;
  platform: PlatformType;
  name: string;
  /** EbayConnectorConfig (JSON-encoded), available for sources that auto-import listings via the ebay-scanning feature. */
  connectorConfig: string | null;
  /** Last time a scheduled scan pulled listings from this source (ebay-scanning feature). */
  lastScannedAt: string | null;
  /** Count of listings found on the most recent scan (ebay-scanning feature); used to show "found N" without separate query. */
  lastScanFoundCount: number | null;
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
  /** Local-disk paths to uploaded photos (assumption A4); JSON-encoded on disk. */
  photoPaths: string[];
  /** Marketplace this Listing was auto-imported from by an eBay scan (Req 3), or null for manually-entered Listings. */
  externalSource: string | null;
  /** The marketplace's own item id for this Listing (Req 3), used to detect duplicates on re-scan; null for manually-entered Listings. */
  externalItemId: string | null;
  /** Whether this listing's computer cannot be powered on or has non-functional components (server-only field, never from request body). */
  nonWorking: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One expected part on a Listing, with its estimated resale value (Req 2-3).
 * `brand`/`partNumber` are the component's structured identity, null when it
 * was not confidently identified (never guessed); `description` holds the
 * remaining context.
 */
export interface ExpectedPart {
  id: string;
  listingId: string;
  componentCategory: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  estimatedResaleValue: number | null;
  /** Other plausible brand/partNumber pairings the AI identifier considered but did not pick as primary; empty for manually-entered Expected Parts. */
  identityCandidates: IdentityCandidate[];
  /** Persisted AI-suggestion provenance (see packages/shared/src/listings.ts's ExpectedPart doc comment); both null for a manual or since-edited row. */
  aiConfidence: AiPartConfidence | null;
  aiSource: AiPartSource | null;
  /** Three-state (assumption A22, correcting A8): null = undecided (still eligible for the route's first auto-claim), `'auto'` = the background price-estimation pipeline owns this row's estimatedResaleValue, `'manual'` = the user has explicitly taken ownership (typed a value, or cleared one the pipeline had filled in) and it must never be auto-claimed or cache-overwritten again. */
  priceSource: 'auto' | 'manual' | null;
  /** The working/non-working status of this component. */
  workingStatus: 'working' | 'non_working';
  /** Free-text notes about this Expected Part (e.g. condition quirks, missing hardware); null when none were recorded. */
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

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

/** Reconciliation of one Expected Part (or an unexpected find) during teardown (Req 6). */
export interface TeardownResult {
  id: string;
  purchaseId: string;
  expectedPartId: string | null;
  resultType: TeardownResultType;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A physical part produced by a teardown, tracked through resale (Req 6-7).
 * `brand`/`partNumber` carry over from the Expected Part (or Additional Part
 * row) the teardown reconciled; null when never identified.
 */
export interface Part {
  id: string;
  purchaseId: string;
  componentCategory: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  status: PartStatus;
  identityCandidates: IdentityCandidate[];
  createdAt: string;
  updatedAt: string;
}

/** A reference photo of a part, used for AI visual identification training data. */
export interface ReferencePhoto {
  id: string;
  photoPath: string;
  partCategory: ComponentCategory;
  partBrand: string | null;
  partNumber: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** One attempt (successful or not) to auto-source a reference photo for a (category, brand, partNumber) combo. */
export interface SourcingAttempt {
  id: string;
  partCategory: ComponentCategory;
  partBrand: string | null;
  partNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A draft/posted marketplace listing for one ready_to_list Part (Req 8). */
export interface SaleListing {
  id: string;
  partId: string;
  platform: PlatformType;
  platformListingUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** The recorded outcome of selling a Part (Req 9). */
export interface Sale {
  id: string;
  partId: string;
  platform: PlatformType;
  saleDate: string;
  priceSold: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Cache of an AI-researched resale-value estimate for a (category, brand,
 * partNumber) combo, updated in the background by the price-estimation
 * feature (assumed to exist by Req 7, built by a later task). Queries from
 * this table populate Expected Parts' estimated_resale_value defaulting (see
 * pricePartsJobs.ts) when an Expected Part is first identified.
 */
export interface PartPriceCacheEntry {
  id: string;
  partCategory: ComponentCategory;
  partBrand: string;
  partNumber: string;
  cachedPrice: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stage of one queued price-research job (part-price-estimation feature,
 * not part of the core workflow — assumed to exist by T10's Req 7).
 */
export type PricePartsJobStage = 'queued' | 'pricing' | 'completed' | 'failed';

/**
 * One unit of background price research, keyed by the (category, brand,
 * partNumber) triple, queued when an Expected Part is first identified with
 * a brand+partNumber and no estimatedResaleValue yet (pricePartsJobs.ts
 * claim-and-work loop, run by identifyPartsWorkerPool.ts's post-identification
 * pipeline).
 */
export interface PricePartsJob {
  id: string;
  partCategory: ComponentCategory;
  partBrand: string;
  partNumber: string;
  stage: PricePartsJobStage;
  createdAt: string;
  updatedAt: string;
}
