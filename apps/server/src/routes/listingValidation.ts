// Request validation for Listings: the strict create/update body checks
// (Req 2, 13) and the loose GET column-filter query parsing. Split out of
// listings.ts to keep that file under the ~200-line standing check; imported
// only by listings.ts, never a route-registration entry point itself.
import type {
  AiPartConfidence,
  AiPartSource,
  ComponentCategory,
  ExpectedPartInput,
  IdentifyPartsJobStage,
  IdentityCandidate,
  ListingColumnFilters,
  ListingStatus,
  PricingStatus,
} from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's component_category/listing_status ENUM columns
// accept; mirrors apps/server/src/db/types.ts's unions (assumption A8, Req 4).
export const VALID_CATEGORIES: readonly ComponentCategory[] = ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other'];
const VALID_AI_CONFIDENCES: readonly AiPartConfidence[] = ['high', 'medium', 'low'];
const VALID_AI_SOURCES: readonly AiPartSource[] = ['text', 'image', 'both'];
// Three-state (assumption A22, correcting A8): absent/null means undecided
// — still eligible for the route's auto-claim — while 'auto' and 'manual'
// are both explicit claims the route stores verbatim.
const VALID_PRICE_SOURCES: readonly ('auto' | 'manual')[] = ['auto', 'manual'];
export const VALID_STATUSES: readonly ListingStatus[] = ['open', 'accepted', 'rejected'];
// Two-state: 'working' is the default for any component not explicitly marked otherwise.
const VALID_WORKING_STATUSES: readonly ('working' | 'non_working')[] = ['working', 'non_working'];
// The accepted values of the two computed-column filters on GET
// /api/listings (Req 5, 6): every IdentifyPartsJobStage plus the 'none'
// sentinel ListingColumnFilters documents for "no job has ever run", and
// the three PricingStatus buckets.
export const VALID_IDENTIFY_PARTS_STAGE_FILTERS: readonly (IdentifyPartsJobStage | 'none')[] = ['none', 'queued', 'identifying', 'sourcing_references', 'comparing', 'completed', 'failed'];
export const VALID_PRICING_STATUSES: readonly PricingStatus[] = ['not_priced', 'partially_priced', 'fully_priced'];

/**
 * The raw query-string shape of the column filters, one key per
 * `ListingColumnFilters` field. Every value arrives as a string, or as a
 * string[] when the same key was repeated (Fastify's default parser turns
 * `?statuses=open&statuses=accepted` into an array).
 */
export type ListingColumnFilterQuery = Partial<Record<keyof ListingColumnFilters, string | string[]>>;

// Splits one multi-value query param into its trimmed, non-empty values.
// Both `?statuses=open,accepted` (comma-separated, what URLSearchParams.set
// naturally produces) and `?statuses=open&statuses=accepted` (repeated key)
// are accepted, since neither form was an existing convention here.
function splitListParam(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

// Keeps only the values in `validValues`: an unrecognized value is ignored
// rather than rejected, the same loose GET validation the old single
// `status` param had. An empty surviving set means "no filter on this
// column" (assumption A4), never "match nothing", so it comes back as
// undefined like an absent param.
function parseEnumListParam<T extends string>(raw: string | string[] | undefined, validValues: readonly T[]): T[] | undefined {
  const values = splitListParam(raw).filter((value): value is T => validValues.includes(value as T));
  return values.length > 0 ? values : undefined;
}

// A blank or non-numeric bound is ignored (no bound on that side), matching
// the loose GET validation above.
function parseNumberParam(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parses the eight column-filter query params of GET /api/listings and GET
 * /api/listings/ids (Req 2-7) into a `ListingColumnFilters`. Validates
 * loosely, like every other GET param on these routes: a blank, malformed
 * or unrecognized value simply applies no filter on that column. The
 * returned object carries ONLY the keys that are actually active, so
 * `Object.keys(result).length === 0` means "no filter at all" — the signal
 * the route uses to keep the SQL-only fast path.
 */
export function parseListingColumnFilters(query: ListingColumnFilterQuery): ListingColumnFilters {
  const sourceIds = splitListParam(query.sourceIds);
  const parsed: ListingColumnFilters = {
    title: typeof query.title === 'string' && query.title.trim().length > 0 ? query.title : undefined,
    // Same empty-means-absent rule as parseEnumListParam, minus the
    // allow-list: a Source id is only checked by membership later.
    sourceIds: sourceIds.length > 0 ? sourceIds : undefined,
    statuses: parseEnumListParam(query.statuses, VALID_STATUSES),
    askingPriceMin: parseNumberParam(query.askingPriceMin),
    askingPriceMax: parseNumberParam(query.askingPriceMax),
    expectedResaleMin: parseNumberParam(query.expectedResaleMin),
    expectedResaleMax: parseNumberParam(query.expectedResaleMax),
    differenceMin: parseNumberParam(query.differenceMin),
    differenceMax: parseNumberParam(query.differenceMax),
    identifyPartsStages: parseEnumListParam(query.identifyPartsStages, VALID_IDENTIFY_PARTS_STAGE_FILTERS),
    pricingStatuses: parseEnumListParam(query.pricingStatuses, VALID_PRICING_STATUSES),
  };
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as ListingColumnFilters;
}

// Loosely-typed shapes of untrusted request input, confirmed by the validate
// functions below before anything reaches the db layer.
interface ExpectedPartRequestBody {
  componentCategory?: unknown;
  brand?: unknown;
  partNumber?: unknown;
  description?: unknown;
  estimatedResaleValue?: unknown;
  identityCandidates?: unknown;
  aiConfidence?: unknown;
  aiSource?: unknown;
  priceSource?: unknown;
  workingStatus?: unknown;
  notes?: unknown;
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

/** Throws AppError(400) unless `value` is null/undefined (meaning "not AI-suggested") or one of `validValues`. Shared by aiConfidence/aiSource below — each has its own small fixed vocabulary. */
function validateOptionalEnum<T extends string>(value: unknown, validValues: readonly T[], fieldName: string): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' && (validValues as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new AppError(`${fieldName} must be one of: ${validValues.join(', ')}`, 400);
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
    aiConfidence: validateOptionalEnum(body.aiConfidence, VALID_AI_CONFIDENCES, `expectedParts[${index}].aiConfidence`),
    aiSource: validateOptionalEnum(body.aiSource, VALID_AI_SOURCES, `expectedParts[${index}].aiSource`),
    priceSource: validateOptionalEnum(body.priceSource, VALID_PRICE_SOURCES, `expectedParts[${index}].priceSource`),
    workingStatus: validateOptionalEnum(body.workingStatus, VALID_WORKING_STATUSES, `expectedParts[${index}].workingStatus`),
    notes: trimmedOrNull(body.notes),
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
