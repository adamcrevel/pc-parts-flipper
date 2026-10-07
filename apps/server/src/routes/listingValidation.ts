// Request-body validation for Listing create/update (Req 2, 13). Split out of
// listings.ts to keep that file under the ~200-line standing check; imported
// only by listings.ts, never a route-registration entry point itself.
import type { ComponentCategory, ExpectedPartInput, IdentityCandidate, ListingStatus } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's component_category/listing_status ENUM columns
// accept; mirrors apps/server/src/db/types.ts's unions (assumption A8, Req 4).
export const VALID_CATEGORIES: readonly ComponentCategory[] = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'];
export const VALID_STATUSES: readonly ListingStatus[] = ['open', 'accepted', 'rejected'];

// Loosely-typed shapes of untrusted request input, confirmed by the validate
// functions below before anything reaches the db layer.
interface ExpectedPartRequestBody {
  componentCategory?: unknown;
  brand?: unknown;
  partNumber?: unknown;
  description?: unknown;
  estimatedResaleValue?: unknown;
  identityCandidates?: unknown;
}
export interface ListingRequestBody {
  sourceId?: unknown;
  title?: unknown;
  description?: unknown;
  listingUrl?: unknown;
  askingPrice?: unknown;
  listingDate?: unknown;
  acquisitionFees?: unknown;
  expectedParts?: unknown;
}

/** The listing-level fields validateListingInput normalizes, ready for the db layer. */
export interface NormalizedListingFields {
  sourceId: string;
  title: string;
  description: string | null;
  listingUrl: string;
  askingPrice: number;
  listingDate: string;
  acquisitionFees: number;
}

// Each of these single-purpose checks keeps validateListingInput's own
// cyclomatic complexity low (one call per field instead of one inline
// condition per field) while still producing the same field-specific
// AppError(400) messages.

/** Trims `value` and throws AppError(400) if the result is blank. */
function requireNonBlankString(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }
  return trimmed;
}

/** Throws AppError(400) unless `value` is a finite number >= 0 (Requirement 13). */
function requireNonNegativeNumber(value: unknown, fieldName: string): number {
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(num) || num < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }
  return num;
}

/**
 * Throws AppError(400) unless `value` is either absent (undefined/null,
 * meaning "not yet priced" — an AI-identified part is never priced by the
 * model) or a finite number >= 0. Distinct from requireNonNegativeNumber:
 * that one still backs every listing-level money field, which stays
 * required; only an Expected Part's own resale value may be left unset.
 */
function requireNonNegativeNumberOrNull(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(num) || num < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }
  return num;
}

/** Trims `value` and throws AppError(400) unless it parses as a real date. */
function requireValidDate(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    throw new AppError(`${fieldName} is required and must be a valid date`, 400);
  }
  return trimmed;
}

// Null, undefined, or an all-whitespace string all mean "not identified" for
// the optional brand/partNumber fields — a value of only spaces is as absent
// as no value at all, and these are deliberately never defaulted to
// placeholder text when the component could not be pinned down.
function trimmedOrNull(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Throws AppError(400) unless `value` is a plain object whose `brand` and
 * `partNumber` sub-fields (when present) are each `string | null`.
 */
function isValidIdentityCandidateShape(value: unknown): value is IdentityCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const brandOk = candidate.brand === undefined || candidate.brand === null || typeof candidate.brand === 'string';
  const partNumberOk = candidate.partNumber === undefined || candidate.partNumber === null || typeof candidate.partNumber === 'string';
  return brandOk && partNumberOk;
}

/**
 * Validates the optional `identityCandidates` array on an Expected Part
 * request body, throwing AppError(400) naming the field's index on any
 * malformed entry. Unlike identificationParser.ts's `coerceIdentityCandidates`
 * (the lenient AI-output path), this is a trusted-shape request-body
 * validator: undefined defaults to `[]`, but anything present and malformed
 * is rejected outright rather than silently dropped or fixed.
 */
function validateIdentityCandidates(value: unknown, index: number): IdentityCandidate[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AppError(`expectedParts[${index}].identityCandidates must be an array`, 400);
  }
  return value.map((entry, candidateIndex) => {
    if (!isValidIdentityCandidateShape(entry)) {
      throw new AppError(
        `expectedParts[${index}].identityCandidates[${candidateIndex}] must be an object with brand/partNumber as string or null`,
        400,
      );
    }
    return { brand: entry.brand ?? null, partNumber: entry.partNumber ?? null };
  });
}

/**
 * Validates one Expected Parts row, throwing an AppError(400) naming its
 * index on the first violation (Requirement 13: category/description
 * required, estimated resale value non-negative). `brand`/`partNumber` are
 * optional — omitted or blank normalizes to null, which is the honest
 * representation of "this component was not identified".
 */
function validateExpectedPartInput(raw: unknown, index: number): ExpectedPartInput {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as ExpectedPartRequestBody;

  const componentCategory = typeof body.componentCategory === 'string' ? body.componentCategory : '';
  if (!VALID_CATEGORIES.includes(componentCategory as ComponentCategory)) {
    throw new AppError(`expectedParts[${index}].componentCategory is required and must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
  }
  const description = requireNonBlankString(body.description, `expectedParts[${index}].description`);

  return {
    componentCategory: componentCategory as ComponentCategory,
    brand: trimmedOrNull(body.brand),
    partNumber: trimmedOrNull(body.partNumber),
    description,
    estimatedResaleValue: requireNonNegativeNumberOrNull(body.estimatedResaleValue, `expectedParts[${index}].estimatedResaleValue`),
    identityCandidates: validateIdentityCandidates(body.identityCandidates, index),
  };
}

/**
 * Validates and normalizes a create/update request body, throwing an
 * AppError(400) with a field-level message on the first violation found —
 * title, listingUrl, sourceId (non-blank), askingPrice (non-negative),
 * listingDate (a real date), acquisitionFees (non-negative, defaulting to 0
 * when omitted — it shares listings.acquisition_fees's `>= 0` CHECK with
 * askingPrice, so Requirement 13's "no negative monetary value" rule covers
 * it too), then every expectedParts row in order.
 */
export function validateListingInput(body: ListingRequestBody): {
  listing: NormalizedListingFields;
  expectedParts: ExpectedPartInput[];
} {
  const title = requireNonBlankString(body.title, 'title');
  const listingUrl = requireNonBlankString(body.listingUrl, 'listingUrl');
  const sourceId = requireNonBlankString(body.sourceId, 'sourceId');
  const askingPrice = requireNonNegativeNumber(body.askingPrice, 'askingPrice');
  const listingDate = requireValidDate(body.listingDate, 'listingDate');
  // Omitted acquisitionFees defaults to 0 rather than failing validation —
  // it is optional in the UI (not every listing carries extra fees).
  const acquisitionFees = body.acquisitionFees === undefined ? 0 : requireNonNegativeNumber(body.acquisitionFees, 'acquisitionFees');
  const description = typeof body.description === 'string' && body.description.trim().length > 0 ? body.description.trim() : null;

  const expectedPartsRaw = Array.isArray(body.expectedParts) ? body.expectedParts : [];
  const expectedParts = expectedPartsRaw.map((raw, index) => validateExpectedPartInput(raw, index));

  return { listing: { sourceId, title, description, listingUrl, askingPrice, listingDate, acquisitionFees }, expectedParts };
}
