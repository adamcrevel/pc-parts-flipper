// Request-body validation for Purchase edit (price paid/purchase date, Req
// 5, 13) and the Req 5 lifecycle status transition rule. Split out of
// purchases.ts to keep that file under the ~200-line standing check, the
// same way listingValidation.ts was split out of listings.ts.
import type { PurchaseStatus, UpdatePurchaseInput } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's purchase_status ENUM column accepts, in their
// fixed forward order (Req 5). A status transition is valid only when it
// moves exactly one position forward in this list — never skipping ahead
// (e.g. shipped -> torn_down) and never moving backward.
export const PURCHASE_STATUS_ORDER: readonly PurchaseStatus[] = ['ordered', 'shipped', 'received', 'torn_down', 'closed'];
export const VALID_PURCHASE_STATUSES: readonly PurchaseStatus[] = PURCHASE_STATUS_ORDER;

/** The single status one step ahead of `current`, or null when `current` is already the terminal 'closed' status. */
export function nextValidStatus(current: PurchaseStatus): PurchaseStatus | null {
  const index = PURCHASE_STATUS_ORDER.indexOf(current);
  return index >= 0 && index < PURCHASE_STATUS_ORDER.length - 1 ? PURCHASE_STATUS_ORDER[index + 1] : null;
}

/** Throws AppError(400) unless `value` is a finite number >= 0 (Requirement 13). */
function requireNonNegativeNumber(value: unknown, fieldName: string): number {
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(num) || num < 0) {
    throw new AppError(`${fieldName} must be a non-negative number`, 400);
  }
  return num;
}

/** Trims `value` and throws AppError(400) unless it parses as a real date (Requirement 13: purchase date required). */
function requireValidDate(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed))) {
    throw new AppError(`${fieldName} is required and must be a valid date`, 400);
  }
  return trimmed;
}

/** Validates a `PUT /api/purchases/:id` request body (Req 5, 13): price paid non-negative, purchase date required/valid. */
export function validatePurchaseEditInput(body: Partial<UpdatePurchaseInput>): UpdatePurchaseInput {
  return {
    pricePaid: requireNonNegativeNumber(body.pricePaid, 'Price paid'),
    purchaseDate: requireValidDate(body.purchaseDate, 'Purchase date'),
  };
}

/**
 * Validates a requested status transition against `current` (Req 5): the
 * requested value must be a recognized purchase_status, and must be exactly
 * the one status one step ahead of `current` — a transition that skips a
 * step, moves backward, or is requested from the terminal 'closed' status
 * is rejected with AppError(400) naming the invalid transition.
 */
export function validateStatusTransition(current: PurchaseStatus, requested: unknown): PurchaseStatus {
  if (typeof requested !== 'string' || !VALID_PURCHASE_STATUSES.includes(requested as PurchaseStatus)) {
    throw new AppError(`status must be one of: ${VALID_PURCHASE_STATUSES.join(', ')}`, 400);
  }
  const next = nextValidStatus(current);
  if (next === null) {
    throw new AppError(`Cannot transition purchase from '${current}': it is already at the final status`, 400);
  }
  if (requested !== next) {
    throw new AppError(`Cannot transition purchase from '${current}' to '${requested}': the only valid next status is '${next}'`, 400);
  }
  return next;
}
