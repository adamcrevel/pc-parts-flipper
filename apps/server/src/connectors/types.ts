// Shared contract every marketplace scan connector implements (Req 6/7).
// apps/server/src/connectors/registry.ts looks these up by PlatformType, and
// T6 (not this batch) will call `search` against a Source's parsed
// connectorConfig to produce candidate Listings for review. Lives in its own
// file so registry.ts and each per-platform connector module can import the
// contract without a circular dependency on each other.
import type { PlatformType } from '@pc-parts-flipper/shared';

/**
 * One marketplace listing found by a connector's search pass, normalized to
 * the fields T6 needs to turn it into a candidate Listing for review. Every
 * connector maps its platform-specific API response down to this shape so
 * callers never branch on platformType after the search call returns.
 */
export interface CandidateListing {
  externalItemId: string;
  title: string;
  listingUrl: string;
  askingPrice: number;
  listingDate: string;
  /**
   * Marketplace-hosted photo URLs for this listing, highest resolution the
   * platform offers, in display order (primary image first). The scan
   * service downloads these to local disk on import so the AI
   * part-identification pass has the real photos, not just a link out.
   * Always present — an empty array means the platform returned no images
   * for this item, which callers must handle without branching on
   * undefined.
   */
  imageUrls: string[];
  /**
   * For eBay listings: true when conditionId is '7000' (parts only / non-working),
   * false otherwise. Used to flag potentially non-functional items that require
   * extra caution during sourcing.
   */
  nonWorking: boolean;
}

/**
 * Fetches one marketplace item's long-form description/specifics text,
 * given that platform's own external item id. Resolves to `null` when the
 * platform simply has no description text for the item — that is an
 * ordinary outcome, not a failure; a genuine failure rejects.
 */
export type DescriptionFetcher = (externalItemId: string) => Promise<string | null>;

/**
 * The three states a marketplace can report for a previously-seen listing:
 * still for sale, sold, or removed/deleted by the seller or platform.
 */
export type ListingLiveStatus = 'active' | 'sold' | 'removed';

/**
 * Checks one marketplace item's current live status, given that platform's
 * own external item id.
 */
export type StatusChecker = (externalItemId: string) => Promise<ListingLiveStatus>;

/**
 * A single marketplace's automated-scan implementation. `platformType`
 * identifies which Source.platformType this connector serves (used as the
 * registry key in registry.ts); `search` takes that Source's parsed
 * connector_config (shape varies per platform, hence `unknown` here) and
 * returns every candidate listing found across the config's search terms.
 */
export interface MarketplaceConnector {
  platformType: PlatformType;
  search(config: unknown): Promise<CandidateListing[]>;
  /**
   * Optional hook a connector implements when its platform can supply
   * per-item description text beyond what `search` returns. The scan
   * service calls this at most once per scan pass and reuses the returned
   * function for every newly-imported candidate in that pass, so a
   * connector can set up a shared, lazily-created resource (an OAuth
   * token, a browser session) inside the returned closure and pay for it
   * only on a scan that actually imports something.
   *
   * Omitting it means "this platform has no description fetch" — the scan
   * service then skips the step entirely rather than branching on
   * `platformType`.
   */
  createDescriptionFetcher?(): DescriptionFetcher;
  /**
   * Optional hook a connector implements when its platform can supply a
   * per-item live-status recheck beyond what `search` returns. The scan
   * service calls this at most once per scan pass and reuses the returned
   * function for every missing-candidate lookup in that pass, so a
   * connector can set up a shared, lazily-created resource (an OAuth
   * token, a browser session) inside the returned closure and pay for it
   * only on a scan that actually needs a recheck.
   *
   * Omitting it means "this platform has no per-item status recheck" — a
   * later scan-service task then skips the recheck entirely rather than
   * branching on `platformType`.
   */
  createStatusChecker?(): StatusChecker;
}
