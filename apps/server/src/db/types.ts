// Row types for the DuckDB tables with no packages/shared counterpart: these
// never cross the HTTP boundary (internal job-queue/cache/training-data
// concerns), so they stay local to apps/server rather than living in
// packages/shared like every other entity this data-access module reads.
// Every other table's row type (Source, Listing, Purchase, TeardownResult,
// Part, SaleListing, Sale, ExpectedPart, plus their 6 backing enums) is
// re-exported from @pc-parts-flipper/shared via db/index.ts instead, since
// each of those is an exact duplicate of its packages/shared counterpart
// once corrected — one declaration per entity, not two free to drift apart.
import type { ComponentCategory } from '@pc-parts-flipper/shared';

// -- Rows --------------------------------------------------------------

/** A reference photo of a part, used for AI visual identification training data. */
export interface ReferencePhoto {
  id: string;
  photoPath: string;
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  source: string;
  listingId: string | null;
  createdAt: string;
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

/**
 * Cache of an AI-researched resale-value estimate for a (category, brand,
 * partNumber) combo, updated in the background by the price-estimation
 * feature (assumed to exist by Req 7, built by a later task). Queries from
 * this table populate Expected Parts' estimated_resale_value defaulting (see
 * pricePartsJobs.ts) when an Expected Part is first identified.
 */
export interface PartPriceCacheEntry {
  id: string;
  category: ComponentCategory;
  brand: string;
  partNumber: string;
  estimatedResaleValue: number | null;
  lastResearchedAt: string | null;
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
  category: ComponentCategory;
  brand: string;
  partNumber: string;
  stage: PricePartsJobStage;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}
