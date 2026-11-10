// Request-body validation for Source create/update (Req 1, 13, plus the
// ebay-scanning feature's connectorConfig). Split out of sources.ts to keep
// that file under the ~200-line standing check, the same pattern
// listingValidation.ts uses for listings.ts; imported only by sources.ts,
// never a route-registration entry point itself.
import type { EbayConnectorConfig, FacebookMarketplaceConnectorConfig, MercariConnectorConfig, PlatformType } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's platform_type ENUM column accepts; mirrors
// apps/server/src/db/types.ts's PlatformType union.
export const VALID_PLATFORM_TYPES: readonly PlatformType[] = ['ebay', 'facebook_marketplace', 'mercari', 'other'];

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
 * Validates one Mercari connectorConfig object, throwing an AppError(400)
 * naming the specific field on the first violation: `queries` must be a
 * non-empty array of non-blank strings, and `maxPrice`, if given, must be a
 * non-negative number — the same rules as validateEbayConnectorConfig
 * above, scoped to platformType 'mercari'.
 */
function validateMercariConnectorConfig(raw: Record<string, unknown>): MercariConnectorConfig {
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
 * Validates one Facebook Marketplace connectorConfig object, throwing an
 * AppError(400) naming the specific field on the first violation:
 * `queries` must be a non-empty array of non-blank strings, `maxPrice` and
 * `radiusMiles`, if given, must each be a non-negative number, and
 * `location`, if given, must be a string — the same `queries`/`maxPrice`
 * rules as validateEbayConnectorConfig above, scoped to platformType
 * 'facebook_marketplace', plus the two Facebook-specific fields. A
 * present-but-blank `location` normalizes to omitted (undefined), the same
 * treatment validateSourceInput below already gives the request body's own
 * `notes` field, rather than being stored as an empty string.
 */
function validateFacebookMarketplaceConnectorConfig(raw: Record<string, unknown>): FacebookMarketplaceConnectorConfig {
  const queriesRaw = Array.isArray(raw.queries) ? raw.queries : [];
  if (queriesRaw.length === 0) {
    throw new AppError('connectorConfig.queries is required and must be a non-empty array', 400);
  }
  const queries = queriesRaw.map((value, index) => requireNonBlankString(value, `connectorConfig.queries[${index}]`));

  // location is optional — blank/missing normalizes to omitted rather than an empty string.
  const location = typeof raw.location === 'string' && raw.location.trim().length > 0 ? raw.location.trim() : undefined;

  // radiusMiles is optional — omitted entirely means no radius limit, not an error.
  const radiusMiles = raw.radiusMiles === undefined ? undefined : requireNonNegativeNumber(raw.radiusMiles, 'connectorConfig.radiusMiles');

  // maxPrice is optional — omitted entirely means no ceiling, not an error.
  const maxPrice = raw.maxPrice === undefined ? undefined : requireNonNegativeNumber(raw.maxPrice, 'connectorConfig.maxPrice');

  return {
    queries,
    ...(location === undefined ? {} : { location }),
    ...(radiusMiles === undefined ? {} : { radiusMiles }),
    ...(maxPrice === undefined ? {} : { maxPrice }),
  };
}

/**
 * Dispatches to the platform-specific connectorConfig validator for
 * `platformType`, or returns `raw` unvalidated for any platform without a
 * registered connector (see validateSourceInput's doc comment for why that
 * is safe). Extracted from validateSourceInput to keep its own cyclomatic
 * complexity under the project's ESLint threshold.
 */
function validateConnectorConfigForPlatform(
  platformType: PlatformType,
  raw: Record<string, unknown>,
): EbayConnectorConfig | MercariConnectorConfig | FacebookMarketplaceConnectorConfig | Record<string, unknown> {
  if (platformType === 'ebay') {
    return validateEbayConnectorConfig(raw);
  }
  if (platformType === 'mercari') {
    return validateMercariConnectorConfig(raw);
  }
  if (platformType === 'facebook_marketplace') {
    return validateFacebookMarketplaceConnectorConfig(raw);
  }
  return raw;
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
 * connectorConfig is validated against its platform-specific shape only
 * when platformType is 'ebay', 'mercari', or 'facebook_marketplace' —
 * Requirement 1 scopes the queries/maxPrice (and, for Facebook, location/
 * radiusMiles) rules to those connector-backed sources specifically. For
 * any other platformType, a connectorConfig value is still accepted and
 * stored as-is (JSON-stringified, unvalidated) rather than rejected
 * outright: no other platform's connector is registered yet
 * (apps/server/src/connectors/registry.ts), so there is no shape to
 * validate against, and a scan can never actually run against it in the
 * meantime — the registry throws for any unregistered platformType before
 * a search is attempted, so an unvalidated config for one of those is
 * inert, not dangerous.
 */
export function validateSourceInput(body: SourceRequestBody): NormalizedSourceFields {
  const name = requireNonBlankString(body.name, 'name');

  // Guard against non-string/garbage values before the union-membership check below.
  const platformTypeRaw = typeof body.platformType === 'string' ? body.platformType : '';
  if (!VALID_PLATFORM_TYPES.includes(platformTypeRaw as PlatformType)) {
    throw new AppError('platformType is required and must be one of: ebay, facebook_marketplace, mercari, other', 400);
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
    const validated = validateConnectorConfigForPlatform(platformType, raw);
    connectorConfig = JSON.stringify(validated);
  }

  return { name, platformType, url, notes, connectorConfig };
}
