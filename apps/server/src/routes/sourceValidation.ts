// Request-body validation for Source create/update (Req 1, 13, plus the
// ebay-scanning feature's connectorConfig). Split out of sources.ts to keep
// that file under the ~200-line standing check, the same pattern
// listingValidation.ts uses for listings.ts; imported only by sources.ts,
// never a route-registration entry point itself.
import type { EbayConnectorConfig, PlatformType } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's platform_type ENUM column accepts; mirrors
// apps/server/src/db/types.ts's PlatformType union.
export const VALID_PLATFORM_TYPES: readonly PlatformType[] = ['ebay', 'facebook_marketplace', 'other'];

// Loosely-typed shape of an incoming create/update request body — fields are
// `unknown` until validateSourceInput below confirms their type, since the
// body is untrusted request input. connectorConfig arrives as a plain
// object (the client's EbayConnectorConfig), not pre-stringified —
// stringifying for the VARCHAR column happens here, after validation.
export interface SourceRequestBody {
  name?: unknown;
  platformType?: unknown;
  url?: unknown;
  notes?: unknown;
  connectorConfig?: unknown;
}

// The fields validateSourceInput normalizes, ready for the db layer's
// CreateSourceInput (apps/server/src/db/queries/sources.ts). Deliberately
// NOT declared as `extends` the shared package's own CreateSourceInput:
// that type represents the untyped-on-the-wire HTTP request shape, whose
// `connectorConfig` is a plain EbayConnectorConfig object (apps/web sends
// it unstringified) — this type is the post-validation, pre-stringified
// shape the db layer actually persists (`connectorConfig: string | null`),
// a different and incompatible type for the same field name.
export interface NormalizedSourceFields {
  name: string;
  platformType: PlatformType;
  url: string;
  notes: string | null;
  connectorConfig: string | null;
}

/** Trims `value` and throws AppError(400) if the result is blank. */
function requireNonBlankString(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }
  return trimmed;
}

/** Throws AppError(400) unless `value` is a finite number >= 0. */
function requireNonNegativeNumber(value: unknown, fieldName: string): number {
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(num) || num < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }
  return num;
}

/**
 * Validates one eBay connectorConfig object, throwing an AppError(400)
 * naming the specific field on the first violation: `queries` must be a
 * non-empty array of non-blank strings, and `maxPrice`, if given, must be a
 * non-negative number (Requirement 1). Only called for platformType 'ebay'
 * — see validateSourceInput below for the non-ebay case.
 */
function validateEbayConnectorConfig(raw: Record<string, unknown>): EbayConnectorConfig {
  const queriesRaw = Array.isArray(raw.queries) ? raw.queries : [];
  if (queriesRaw.length === 0) {
    throw new AppError('connectorConfig.queries is required and must be a non-empty array', 400);
  }
  const queries = queriesRaw.map((value, index) => requireNonBlankString(value, `connectorConfig.queries[${index}]`));

  // maxPrice is optional — omitted entirely means no ceiling, not an error.
  const maxPrice = raw.maxPrice === undefined ? undefined : requireNonNegativeNumber(raw.maxPrice, 'connectorConfig.maxPrice');

  return maxPrice === undefined ? { queries } : { queries, maxPrice };
}

/**
 * Validates and normalizes a create/update request body, throwing an
 * AppError(400) with a field-level message on the first violation found —
 * name/url (non-blank), platformType (one of the fixed enum values), then
 * connectorConfig if present (Requirement 13: "reject save on blank
 * required fields ... with inline error"). Returns the normalized input
 * ready to pass to the db layer, with connectorConfig already
 * JSON-stringified for the VARCHAR column (Source.connectorConfig's
 * documented shape, packages/shared/src/sources.ts).
 *
 * connectorConfig is validated against EbayConnectorConfig's shape only
 * when platformType is 'ebay' — Requirement 1 scopes the queries/maxPrice
 * rules to eBay sources specifically. For a non-ebay platformType, a
 * connectorConfig value is still accepted and stored as-is
 * (JSON-stringified, unvalidated) rather than rejected outright: no other
 * platform's connector is registered yet (apps/server/src/connectors/
 * registry.ts only knows 'ebay'), so there is no shape to validate against,
 * and a scan can never actually run against it in the meantime — the
 * registry throws for any unregistered platformType before a search is
 * attempted, so an unvalidated non-ebay config is inert, not dangerous.
 */
export function validateSourceInput(body: SourceRequestBody): NormalizedSourceFields {
  const name = requireNonBlankString(body.name, 'name');

  // Guard against non-string/garbage values before the union-membership check below.
  const platformTypeRaw = typeof body.platformType === 'string' ? body.platformType : '';
  if (!VALID_PLATFORM_TYPES.includes(platformTypeRaw as PlatformType)) {
    throw new AppError('platformType is required and must be one of: ebay, facebook_marketplace, other', 400);
  }
  const platformType = platformTypeRaw as PlatformType;

  const url = requireNonBlankString(body.url, 'url');

  // notes is optional — blank/missing normalizes to null rather than an empty string.
  const notes = typeof body.notes === 'string' && body.notes.trim().length > 0 ? body.notes.trim() : null;

  let connectorConfig: string | null = null;
  if (body.connectorConfig !== undefined && body.connectorConfig !== null) {
    if (typeof body.connectorConfig !== 'object') {
      throw new AppError('connectorConfig must be an object', 400);
    }
    const raw = body.connectorConfig as Record<string, unknown>;
    connectorConfig = JSON.stringify(platformType === 'ebay' ? validateEbayConnectorConfig(raw) : raw);
  }

  return { name, platformType, url, notes, connectorConfig };
}
