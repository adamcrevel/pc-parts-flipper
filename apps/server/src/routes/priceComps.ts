// HTTP route for reading a part's cached price-research state, including
// the supporting comps the model found for its estimate (pricing-comps
// feature T3). Reaches the database exclusively through findPriceCacheEntry
// (the db barrel at db/index.ts) — never a direct DuckDB call — per the
// "all DuckDB access confined to db/**" standing check.
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
} from 'fastify';
import type { ComponentCategory, GetPriceCompsResponse } from '@pc-parts-flipper/shared';
import { findPriceCacheEntry } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { VALID_CATEGORIES } from './listingValidation.js';

/** Trims `value` and throws AppError(400) if the result is blank — same shape as listingValidation.ts's requireNonBlankString. */
function requireNonBlankQueryString(value: unknown, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    throw new AppError(`${fieldName} is required`, 400);
  }
  return trimmed;
}

/** Throws AppError(400) unless `value` is one of listingValidation.ts's VALID_CATEGORIES. */
function requireValidCategory(value: unknown): ComponentCategory {
  const category = requireNonBlankQueryString(value, 'category');
  if (!VALID_CATEGORIES.includes(category as ComponentCategory)) {
    throw new AppError(`category must be one of: ${VALID_CATEGORIES.join(', ')}`, 400);
  }
  return category as ComponentCategory;
}

/**
 * Registers the `/api/price-comps` route on the given Fastify instance.
 * Called once from index.ts during server bootstrap, the same way
 * registerSourcesRoutes is. The generic re-declaration (matching
 * error-handler.ts's registerErrorHandler) lets TypeScript infer this
 * server's actual Logger type from the argument instead of defaulting to
 * FastifyBaseLogger, which the pino-backed `server` instance in index.ts is
 * not structurally assignable to.
 */
export async function registerPriceCompsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.get('/api/price-comps', async (request): Promise<GetPriceCompsResponse> => {
    const { category: rawCategory, brand: rawBrand, partNumber: rawPartNumber } = request.query as {
      category?: string;
      brand?: string;
      partNumber?: string;
    };
    const category = requireValidCategory(rawCategory);
    const brand = requireNonBlankQueryString(rawBrand, 'brand');
    const partNumber = requireNonBlankQueryString(rawPartNumber, 'partNumber');

    logger.info({ route: 'GET /api/price-comps', category, brand, partNumber }, 'Fetching price-comps cache entry');
    const entry = await findPriceCacheEntry(category, brand, partNumber);
    // No row for this combo is a normal "not yet researched" state (never a
    // 404) — the frontend renders it the same as a researched-but-comp-less
    // row, just with every field at its empty default.
    if (!entry) {
      return { estimatedResaleValue: null, lastResearchedAt: null, comps: [] };
    }
    return { estimatedResaleValue: entry.estimatedResaleValue, lastResearchedAt: entry.lastResearchedAt, comps: entry.comps };
  });
}
