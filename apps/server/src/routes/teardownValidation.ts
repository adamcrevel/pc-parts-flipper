// Request-body validation for the teardown submission (Req 6). Split out of
// teardown.ts to keep that file under the ~200-line standing check, the same
// way listingValidation.ts was split out of listings.ts. Submission is
// validated as a single atomic unit (not persisted partially, see
// teardown.ts's doc comment): every Expected Part on the originating Listing
// must appear exactly once with a result, present_but_different/missing
// entries require a non-blank note, and every Additional Part row must carry
// a valid category and non-blank description.
import type { ComponentCategory, ExpectedPart, TeardownExpectedPartResultInput, TeardownResultType } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';
import { VALID_CATEGORIES } from './listingValidation.js';

/** The teardown_result_type ENUM values a caller may submit for an Expected Part row — 'additional' is server-assigned, never caller-supplied. */
export const VALID_EXPECTED_PART_RESULTS: readonly Exclude<TeardownResultType, 'additional'>[] = [
  'present_as_expected',
  'present_but_different',
  'missing',
];

// Loosely-typed shapes of untrusted request input, confirmed by the validate
// functions below before anything reaches the db layer.
interface ResultRequestBody {
  expectedPartId?: unknown;
  result?: unknown;
  note?: unknown;
}
interface AdditionalPartRequestBody {
  category?: unknown;
  brand?: unknown;
  partNumber?: unknown;
  description?: unknown;
  note?: unknown;
}
export interface SubmitTeardownRequestBody {
  results?: unknown;
  additionalParts?: unknown;
}

/** Trims `value` and throws AppError(400) if the result is blank. */
function requireNonBlankString(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }
  return trimmed;
}

// Null, undefined, or an all-whitespace string all count as "no value" here —
// a note (or a brand/part number) consisting only of spaces is as useless as
// an absent one. For brand/partNumber this is also the deliberate choice not
// to invent placeholder text for a component nobody identified.
function trimmedOrNull(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/** One validated Additional Part row, ready for createPart. */
export interface ValidatedAdditionalPart {
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  note: string | null;
}

/**
 * Validates one Expected Part result row, throwing an AppError(400) naming
 * its expected part on the first violation: result must be one of the three
 * caller-supplied TeardownResultType values, and a note is required
 * (Requirement 13) when result is `present_but_different` or `missing`.
 */
function validateResultEntry(raw: unknown, expectedPart: ExpectedPart): TeardownExpectedPartResultInput {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as ResultRequestBody;
  const result = typeof body.result === 'string' ? body.result : '';
  if (!VALID_EXPECTED_PART_RESULTS.includes(result as (typeof VALID_EXPECTED_PART_RESULTS)[number])) {
    throw new AppError(
      `Expected part "${expectedPart.description}" (${expectedPart.id}) must have a result of one of: ${VALID_EXPECTED_PART_RESULTS.join(', ')}`,
      400,
    );
  }
  const note = trimmedOrNull(body.note);
  if ((result === 'present_but_different' || result === 'missing') && note === null) {
    throw new AppError(
      `Expected part "${expectedPart.description}" (${expectedPart.id}) is marked '${result}' and requires a note`,
      400,
    );
  }
  return { expectedPartId: expectedPart.id, result: result as (typeof VALID_EXPECTED_PART_RESULTS)[number], note };
}

/** Validates one Additional Part row (Requirement 13: category/description required; brand, part number and note all optional, blank normalizing to null). */
function validateAdditionalPartEntry(raw: unknown, index: number): ValidatedAdditionalPart {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as AdditionalPartRequestBody;
  const category = typeof body.category === 'string' ? body.category : '';
  if (!VALID_CATEGORIES.includes(category as ComponentCategory)) {
    throw new AppError(`additionalParts[${index}].category is required and must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
  }
  const description = requireNonBlankString(body.description, `additionalParts[${index}].description`);
  return {
    category: category as ComponentCategory,
    brand: trimmedOrNull(body.brand),
    partNumber: trimmedOrNull(body.partNumber),
    description,
    note: trimmedOrNull(body.note),
  };
}

/**
 * Validates a `POST /api/purchases/:id/teardown` request body against the
 * originating Listing's Expected Parts: `results` must contain exactly one
 * entry per Expected Part (an entry for an unknown id, a duplicate entry, or
 * a missing entry is rejected, the last one naming which Expected Parts
 * never got a result), each validated by validateResultEntry above; every
 * `additionalParts` row is validated by validateAdditionalPartEntry.
 */
export function validateTeardownSubmission(
  body: SubmitTeardownRequestBody,
  expectedParts: ExpectedPart[],
): { results: TeardownExpectedPartResultInput[]; additionalParts: ValidatedAdditionalPart[] } {
  const rawResults = Array.isArray(body.results) ? body.results : [];
  const expectedPartsById = new Map(expectedParts.map((part) => [part.id, part]));
  const seenExpectedPartIds = new Set<string>();

  const results = rawResults.map((raw) => {
    const expectedPartId = typeof raw === 'object' && raw !== null ? (raw as ResultRequestBody).expectedPartId : undefined;
    const expectedPart = typeof expectedPartId === 'string' ? expectedPartsById.get(expectedPartId) : undefined;
    if (!expectedPart) {
      throw new AppError(`results contains an expectedPartId that is not on this purchase's listing: ${String(expectedPartId)}`, 400);
    }
    if (seenExpectedPartIds.has(expectedPart.id)) {
      throw new AppError(`Expected part "${expectedPart.description}" (${expectedPart.id}) has more than one result entry`, 400);
    }
    seenExpectedPartIds.add(expectedPart.id);
    return validateResultEntry(raw, expectedPart);
  });

  const missingExpectedParts = expectedParts.filter((part) => !seenExpectedPartIds.has(part.id));
  if (missingExpectedParts.length > 0) {
    const names = missingExpectedParts.map((part) => `"${part.description}" (${part.id})`).join(', ');
    throw new AppError(`Every expected part must have a result; missing: ${names}`, 400);
  }

  const rawAdditionalParts = Array.isArray(body.additionalParts) ? body.additionalParts : [];
  const additionalParts = rawAdditionalParts.map((raw, index) => validateAdditionalPartEntry(raw, index));

  return { results, additionalParts };
}
