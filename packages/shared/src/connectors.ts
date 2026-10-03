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
