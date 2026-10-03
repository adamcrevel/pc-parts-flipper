// Source domain types shared between apps/server (route request/response
// bodies) and apps/web (API client + UI state), so both sides agree on one
// shape instead of each redefining it. Mirrors the DuckDB row shape in
// apps/server/src/db/types.ts, but lives here because HTTP callers (apps/web)
// may never import apps/server directly (standing check).
import type { EbayConnectorConfig } from './connectors.js';

/** Marketplace a Source lives on. Fixed set (Req 1). */
export type PlatformType = 'ebay' | 'facebook_marketplace' | 'other';

/** A purchase source: a place listings are found (Req 1). */
export interface Source {
  id: string;
  name: string;
  platformType: PlatformType;
  url: string | null;
  notes: string | null;
  active: boolean;
  /**
   * JSON-encoded EbayConnectorConfig (connectors.ts), null when this Source
   * has no automated scan configured. Stored as a VARCHAR column rather than
   * nested JSON because DuckDB's column type here is plain text (T1); callers
   * parse/stringify at the boundary.
   */
  connectorConfig: string | null;
  /** Timestamp of the most recent automated scan run against this Source, null if never scanned. */
  lastScannedAt: string | null;
  /** Count of Listings the most recent automated scan found, null if never scanned. */
  lastScanFoundCount: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for `POST /api/sources`. name/platformType/url are required
 * and non-blank; notes is required-but-nullable (not optional) so it lines
 * up with apps/server/src/db/queries/sources.ts's CreateSourceInput without
 * a cast at the route boundary — callers pass `null` explicitly for "no notes".
 *
 * `connectorConfig` is optional and only meaningful for platformType 'ebay'
 * (T8/T9): a plain EbayConnectorConfig object, NOT pre-stringified — the
 * server (sourceValidation.ts) validates and JSON.stringifies it before
 * storing. Omit it (or pass `null`) for "no automated scan configured".
 */
export interface CreateSourceInput {
  name: string;
  platformType: PlatformType;
  url: string;
  notes: string | null;
  connectorConfig?: EbayConnectorConfig | null;
}

/** Request body for `PUT /api/sources/:id`. Same required fields as create. */
export type UpdateSourceInput = CreateSourceInput;
