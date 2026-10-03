// Request-body validation for the Part status transition (Req 7). Split out
// of parts.ts to keep that file under the ~200-line standing check, the
// same way purchaseValidation.ts was split out of purchases.ts.
import type { PartStatus } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's part_status ENUM column accepts. 'unsellable' is
// deliberately excluded from PART_STATUS_ORDER below: it is a side-branch
// reachable only from 'ready_to_list', not a step in the forward chain.
export const VALID_PART_STATUSES: readonly PartStatus[] = ['ready_to_list', 'listed', 'sold', 'unsellable'];

// The forward-only lifecycle chain (Req 7): ready_to_list -> listed -> sold,
// one step at a time. 'unsellable' is handled separately in
// validateStatusTransition below, since it is reachable only from
// 'ready_to_list' and is itself terminal (not part of this ordered chain).
const PART_STATUS_ORDER: readonly PartStatus[] = ['ready_to_list', 'listed', 'sold'];

/** The single status one step ahead of `current` in the forward chain, or null when `current` is 'sold' or 'unsellable' (both terminal). */
function nextForwardStatus(current: PartStatus): PartStatus | null {
  const index = PART_STATUS_ORDER.indexOf(current);
  return index >= 0 && index < PART_STATUS_ORDER.length - 1 ? PART_STATUS_ORDER[index + 1] : null;
}

/** Trims `value` and throws AppError(400) if the result is blank — used for the unsellable reason note (Req 7, 13). */
function requireNonBlankString(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }
  return trimmed;
}

/**
 * Validates a requested Part status transition against `current` (Req 7).
 * Two legal shapes: the forward chain (ready_to_list -> listed -> sold, one
 * step at a time — a skip, a reversal, or a request from a terminal status
 * is rejected), or the 'unsellable' side-branch, reachable only from
 * 'ready_to_list' and requiring a non-blank `reason` in the request body
 * (Requirement 13). Returns the validated next status and, when
 * transitioning to unsellable, the trimmed reason.
 */
export function validatePartStatusTransition(
  current: PartStatus,
  requested: unknown,
  reason: unknown,
): { status: PartStatus; unsellableReason: string | null } {
  if (typeof requested !== 'string' || !VALID_PART_STATUSES.includes(requested as PartStatus)) {
    throw new AppError(`status must be one of: ${VALID_PART_STATUSES.join(', ')}`, 400);
  }
  if (requested === 'unsellable') {
    if (current !== 'ready_to_list') {
      throw new AppError(`Cannot mark a part unsellable from status '${current}': only 'ready_to_list' parts can be marked unsellable`, 400);
    }
    return { status: 'unsellable', unsellableReason: requireNonBlankString(reason, 'A reason note') };
  }
  const next = nextForwardStatus(current);
  if (next === null) {
    throw new AppError(`Cannot transition part from '${current}': it is already at a final status`, 400);
  }
  if (requested !== next) {
    throw new AppError(`Cannot transition part from '${current}' to '${requested}': the only valid next status is '${next}'`, 400);
  }
  return { status: next, unsellableReason: null };
}
