// Source domain types shared between apps/server (route request/response
// bodies) and apps/web (API client + UI state), so both sides agree on one
// shape instead of each redefining it. Mirrors the DuckDB row shape in
// apps/server/src/db/types.ts, but lives here because HTTP callers (apps/web)
// may never import apps/server directly (standing check).

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
  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for `POST /api/sources`. name/platformType/url are required
 * and non-blank; notes is required-but-nullable (not optional) so it lines
 * up with apps/server/src/db/queries/sources.ts's CreateSourceInput without
 * a cast at the route boundary — callers pass `null` explicitly for "no notes".
 */
export interface CreateSourceInput {
  name: string;
  platformType: PlatformType;
  url: string;
  notes: string | null;
}

/** Request body for `PUT /api/sources/:id`. Same required fields as create. */
export type UpdateSourceInput = CreateSourceInput;
