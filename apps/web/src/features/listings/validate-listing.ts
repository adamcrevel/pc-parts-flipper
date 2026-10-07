import type { ExpectedPartRow, ExpectedPartRowErrors } from '@/features/listings/expected-parts-editor';

// Field-level validation messages for the listing-level fields, mirroring
// the backend's own checks (apps/server/src/routes/listingValidation.ts) so
// inline errors appear without a round trip wherever feasible. Split out of
// listing-form.tsx to keep that file under the ~200-line standing check.
export interface ListingFieldErrors {
  title?: string;
  listingUrl?: string;
  sourceId?: string;
  askingPrice?: string;
  listingDate?: string;
  acquisitionFees?: string;
}

// A string value is an invalid non-negative number when it doesn't parse as
// a number at all, or parses to a negative one. Shared by askingPrice (Req
// 13's required-and-non-negative check) and acquisitionFees (optional, but
// non-negative when provided) below so validateListingFields' own
// complexity stays low — one call per field instead of one inline
// multi-condition `if` per field.
function isInvalidNonNegativeNumber(value: string): boolean {
  return Number.isNaN(Number(value)) || Number(value) < 0;
}

/**
 * Validates the listing-level required/non-negative fields client-side
 * (Requirement 13). Expected Parts rows are validated separately per-row by
 * validateExpectedPartRows below, matching the backend's per-index messages.
 */
export function validateListingFields(
  title: string,
  listingUrl: string,
  sourceId: string,
  askingPrice: string,
  listingDate: string,
  acquisitionFees: string,
): ListingFieldErrors {
  const errors: ListingFieldErrors = {};
  if (title.trim().length === 0) errors.title = 'Title is required.';
  if (listingUrl.trim().length === 0) errors.listingUrl = 'Listing URL is required.';
  if (sourceId.trim().length === 0) errors.sourceId = 'Source is required.';
  if (askingPrice.trim().length === 0 || isInvalidNonNegativeNumber(askingPrice)) {
    errors.askingPrice = 'Asking price is required and must be a non-negative number.';
  }
  if (listingDate.trim().length === 0) errors.listingDate = 'Listing date is required.';
  if (acquisitionFees.trim().length > 0 && isInvalidNonNegativeNumber(acquisitionFees)) {
    errors.acquisitionFees = 'Acquisition fees/shipping must be a non-negative number.';
  }
  return errors;
}

/**
 * Validates every Expected Parts row (Requirement 13), returning one error
 * object per row (empty object when that row is valid).
 */
export function validateExpectedPartRows(rows: ExpectedPartRow[]): ExpectedPartRowErrors[] {
  return rows.map((row) => {
    const errors: ExpectedPartRowErrors = {};
    if (row.componentCategory === '') errors.componentCategory = 'Category is required.';
    if (row.description.trim().length === 0) errors.description = 'Description is required.';
    // Blank is valid — "not yet priced" is a real state (every AI
    // suggestion starts this way), distinct from an invalid entry.
    if (row.estimatedResaleValue.trim().length > 0 && isInvalidNonNegativeNumber(row.estimatedResaleValue)) {
      errors.estimatedResaleValue = 'Estimated resale value must be a non-negative number.';
    }
    return errors;
  });
}
