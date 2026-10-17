// Automated-scan connector config types, shared between apps/server
// (parsing/validating sources.connector_config, running the eBay connector)
// and apps/web (the Source config editor UI). Lives here (not apps/server)
// because apps/web may never import apps/server directly (standing check).

/**
 * Parsed shape of Source.connectorConfig (JSON-encoded VARCHAR column, T1)
 * for an eBay-backed Source. `queries` drives one scan pass per search term;
 * `maxPrice` is an optional ceiling applied across all queries.
 */
export interface EbayConnectorConfig {
  queries: string[];
  maxPrice?: number;
}

/**
 * Parsed shape of Source.connectorConfig for a Mercari-backed Source.
 * Identical shape to EbayConnectorConfig today, but kept as its own named
 * interface per this file's one-interface-per-platform convention — the
 * two platforms' configs are free to diverge later without a breaking
 * rename.
 */
export interface MercariConnectorConfig {
  queries: string[];
  maxPrice?: number;
}

/**
 * Parsed shape of Source.connectorConfig for a Facebook Marketplace-backed
 * Source. Adds `location`/`radiusMiles` on top of the eBay/Mercari shape
 * since Facebook Marketplace search is inherently local (no equivalent on
 * eBay/Mercari, both nationwide marketplaces) — both are optional, meaning
 * "no location filter applied".
 */
export interface FacebookMarketplaceConnectorConfig {
  queries: string[];
  location?: string;
  radiusMiles?: number;
  maxPrice?: number;
}
