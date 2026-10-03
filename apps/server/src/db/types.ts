// Row types for every DuckDB table owned by this data-access module, plus the
// enum unions that back DuckDB's native ENUM columns. These are intentionally
// local to apps/server (not packages/shared) for this task — promoting them
// to the shared package, so apps/web can reuse them over the HTTP API's JSON
// shapes, is left to the tasks that build the routes/screens on top of this
// module.

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
  name: string;
  platformType: PlatformType;
  url: string | null;
  notes: string | null;
  active: boolean;
  /** JSON-encoded EbayConnectorConfig (packages/shared/src/connectors.ts), null when no automated scan is configured. */
  connectorConfig: string | null;
  /** Timestamp of the most recent automated scan run against this Source, null if never scanned. */
  lastScannedAt: string | null;
  /** Count of Listings the most recent automated scan found, null if never scanned. */
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
  createdAt: string;
  updatedAt: string;
}

/** One expected part on a Listing, with its estimated resale value (Req 2-3). */
export interface ExpectedPart {
  id: string;
  listingId: string;
  componentCategory: ComponentCategory;
  description: string;
  estimatedResaleValue: number;
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
  /** Null when this row records an Additional Part not on the original Listing. */
  expectedPartId: string | null;
  result: TeardownResultType;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A physical part produced by a teardown, tracked through resale (Req 6-7). */
export interface Part {
  id: string;
  purchaseId: string;
  category: ComponentCategory;
  description: string;
  status: PartStatus;
  unsellableReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A draft/posted marketplace listing for one ready_to_list Part (Req 8). */
export interface SaleListing {
  id: string;
  partId: string;
  platform: PlatformType;
  title: string;
  description: string | null;
  askingPrice: number;
  /** Set only once the user confirms they've manually posted it (Req 8, A5). */
  listedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The recorded outcome of selling a Part (Req 9). */
export interface Sale {
  id: string;
  partId: string;
  soldPrice: number;
  soldDate: string;
  platformFee: number;
  shippingCost: number;
  buyerNote: string | null;
  createdAt: string;
  updatedAt: string;
}
