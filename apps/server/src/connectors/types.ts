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
}

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
}
