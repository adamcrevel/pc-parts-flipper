// Field-level validation for the Record Sale form, mirroring the backend's
// own checks (apps/server/src/routes/salesValidation.ts) so inline errors
// appear without a round trip (Requirement 13: sold price/platform
// fee/shipping cost non-negative, sold date required).
export interface SaleFieldErrors {
  soldPrice?: string;
  soldDate?: string;
  platformFee?: string;
  shippingCost?: string;
}

/**
 * Validates the Record Sale form's required/non-negative fields
 * client-side (Requirement 13: sold price >= 0, sold date required,
 * platform fee >= 0, shipping cost >= 0). `buyerNote` is optional free text
 * and never produces an error.
 */
export function validateSaleFields(soldPrice: string, soldDate: string, platformFee: string, shippingCost: string): SaleFieldErrors {
  const errors: SaleFieldErrors = {};
  if (soldPrice.trim().length === 0 || Number.isNaN(Number(soldPrice)) || Number(soldPrice) < 0) {
    errors.soldPrice = 'Sold price is required and must be a non-negative number.';
  }
  if (soldDate.trim().length === 0) {
    errors.soldDate = 'Sold date is required.';
  }
  if (platformFee.trim().length === 0 || Number.isNaN(Number(platformFee)) || Number(platformFee) < 0) {
    errors.platformFee = 'Platform fee is required and must be a non-negative number.';
  }
  if (shippingCost.trim().length === 0 || Number.isNaN(Number(shippingCost)) || Number(shippingCost) < 0) {
    errors.shippingCost = 'Shipping cost is required and must be a non-negative number.';
  }
  return errors;
}
