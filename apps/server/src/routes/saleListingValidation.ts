// Request-body validation for Sale Listing create/update (Req 8, 13). Split
// out of saleListings.ts to keep that file under the ~200-line standing
// check, the same way listingValidation.ts was split out of listings.ts.
import type { ComponentCategory, PlatformType } from '@pc-parts-flipper/shared';
import { AppError } from '../error-handler.js';

// The only values DuckDB's platform_type ENUM column accepts; mirrors
// apps/server/src/db/types.ts's PlatformType union (also reused by Sources,
// Req 1 & 8).
export const VALID_PLATFORM_TYPES: readonly PlatformType[] = ['ebay', 'facebook_marketplace', 'other'];

// Loosely-typed shape of an incoming create/update request body — fields
// are `unknown` until the validate functions below confirm their type,
// since the body is untrusted request input. Every field is optional: a
// create defaults the omitted ones (see validateCreateSaleListingInput's
// doc comment); an update leaves an omitted field unchanged.
export interface SaleListingRequestBody {
  platform?: unknown;
  title?: unknown;
  description?: unknown;
  askingPrice?: unknown;
}

/** The normalized fields a validated request resolves to, ready for the db layer. `undefined` on an update field means "leave unchanged"; a create never leaves platform/title/askingPrice undefined (defaults fill them). */
export interface NormalizedSaleListingFields {
  platform?: PlatformType;
  title?: string;
  description?: string | null;
  askingPrice?: number;
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

/** Throws AppError(400) if `value` is present but not one of VALID_PLATFORM_TYPES; returns it typed otherwise, or undefined when omitted. */
function validateOptionalPlatform(value: unknown): PlatformType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !VALID_PLATFORM_TYPES.includes(value as PlatformType)) {
    throw new AppError(`platform must be one of: ${VALID_PLATFORM_TYPES.join(', ')}`, 400);
  }
  return value as PlatformType;
}

/** The `${category}: ${description}` title a draft Sale Listing gets when the client sends no title override (Req 8). */
export function defaultSaleListingTitle(category: ComponentCategory, description: string): string {
  return `${category}: ${description}`;
}

/**
 * Validates and normalizes a `POST /api/parts/:partId/sale-listings`
 * request body (Req 8, 13). Every field is optional on input: an omitted
 * `platform` defaults to `'other'`, an omitted `askingPrice` defaults to
 * `0`, and omitted `title`/`description` default to
 * `${category}: ${description}` / the Part's own description, generated
 * from the owning Part — all meant to be edited immediately afterward via
 * the draft editor rather than required up front. A *supplied* title or
 * asking price is still validated (non-blank / non-negative) the same as
 * an update.
 */
export function validateCreateSaleListingInput(body: SaleListingRequestBody, part: { category: ComponentCategory; description: string }): Required<NormalizedSaleListingFields> {
  const platform = validateOptionalPlatform(body.platform) ?? 'other';
  const title = body.title !== undefined ? requireNonBlankString(body.title, 'title') : defaultSaleListingTitle(part.category, part.description);
  const description = body.description !== undefined ? (body.description === null ? null : requireNonBlankString(body.description, 'description')) : part.description;
  const askingPrice = body.askingPrice !== undefined ? requireNonNegativeNumber(body.askingPrice, 'asking price') : 0;
  return { platform, title, description, askingPrice };
}

/**
 * Validates and normalizes a `PUT /api/sale-listings/:id` request body (Req
 * 8, 13). Unlike create, every field left `undefined` here stays
 * `undefined` in the result (buildSetClause's "leave unchanged" signal) —
 * only fields the client actually sent are checked/applied.
 */
export function validateUpdateSaleListingInput(body: SaleListingRequestBody): NormalizedSaleListingFields {
  const platform = validateOptionalPlatform(body.platform);
  const title = body.title !== undefined ? requireNonBlankString(body.title, 'title') : undefined;
  const description = body.description !== undefined ? (body.description === null ? null : requireNonBlankString(body.description, 'description')) : undefined;
  const askingPrice = body.askingPrice !== undefined ? requireNonNegativeNumber(body.askingPrice, 'asking price') : undefined;
  return { platform, title, description, askingPrice };
}
