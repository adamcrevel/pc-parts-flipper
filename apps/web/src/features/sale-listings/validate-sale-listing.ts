// Field-level validation for the Sale Listing draft editor, mirroring the
// backend's own checks (apps/server/src/routes/saleListingValidation.ts) so
// inline errors appear without a round trip (Requirement 13: title
// required, asking price non-negative).
export interface SaleListingFieldErrors {
  title?: string;
  askingPrice?: string;
}

/**
 * Validates the draft editor's required/non-negative fields client-side
 * (Requirement 13: title non-blank, asking price >= 0).
 */
export function validateSaleListingFields(title: string, askingPrice: string): SaleListingFieldErrors {
  const errors: SaleListingFieldErrors = {};
  if (title.trim().length === 0) {
    errors.title = 'Title is required.';
  }
  if (askingPrice.trim().length === 0 || Number.isNaN(Number(askingPrice)) || Number(askingPrice) < 0) {
    errors.askingPrice = 'Asking price is required and must be a non-negative number.';
  }
  return errors;
}
