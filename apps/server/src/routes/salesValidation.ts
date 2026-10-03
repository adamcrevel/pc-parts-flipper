// Request-body validation for recording a Sale (Req 9, 13). Split out of
// sales.ts to keep that file under the ~200-line standing check, the same
// way saleListingValidation.ts was split out of saleListings.ts.
import { AppError } from '../error-handler.js';

/** Loosely-typed shape of an incoming `POST /api/parts/:partId/sale` request body — fields are `unknown` until the validate function below confirms their type, since the body is untrusted request input. */
export interface SaleRequestBody {
  soldPrice?: unknown;
  soldDate?: unknown;
  platformFee?: unknown;
  shippingCost?: unknown;
  buyerNote?: unknown;
}

/** The normalized fields a validated Sale request resolves to, ready for the db layer. */
export interface NormalizedSaleFields {
  soldPrice: number;
  soldDate: string;
  platformFee: number;
  shippingCost: number;
  buyerNote: string | null;
}

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
  const num = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(num) || num < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }
  return num;
}

/** Throws AppError(400) unless `value` is a non-blank string that parses as a valid calendar date (Requirement 13: sold date required). */
function requireValidDateString(value: unknown, fieldName: string): string {
  const trimmed = requireNonBlankString(value, fieldName);
  if (Number.isNaN(Date.parse(trimmed))) {
    throw new AppError(`${fieldName} must be a valid date`, 400);
  }
  return trimmed;
}

/** Normalizes the optional buyer note: a non-string value is rejected, a blank/omitted one collapses to null rather than being required (it's optional free text, not a blank-rejects-save field). */
function normalizeOptionalNote(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new AppError('Buyer note must be text', 400);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates and normalizes a `POST /api/parts/:partId/sale` request body
 * (Req 9, 13): sold price, platform fee, and shipping cost must each be a
 * non-negative number; sold date is required and must be a valid date;
 * buyer note is optional free text.
 */
export function validateCreateSaleInput(body: SaleRequestBody): NormalizedSaleFields {
  const soldPrice = requireNonNegativeNumber(body.soldPrice, 'Sold price');
  const soldDate = requireValidDateString(body.soldDate, 'Sold date');
  const platformFee = requireNonNegativeNumber(body.platformFee, 'Platform fee');
  const shippingCost = requireNonNegativeNumber(body.shippingCost, 'Shipping cost');
  const buyerNote = normalizeOptionalNote(body.buyerNote);
  return { soldPrice, soldDate, platformFee, shippingCost, buyerNote };
}
