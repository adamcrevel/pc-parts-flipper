// HTTP route for the Profit dashboard (Req 10-11, 15): the aggregated,
// sortable/filterable/paginated per-Purchase profit rollup. Distinct from
// GET /api/purchases (routes/purchases.ts), which is the simpler per-purchase
// browsing list. Reaches the database exclusively through the named exports
// of apps/server/src/db (barrel at db/index.ts) — never a direct DuckDB
// call — per the "all DuckDB access confined to db/**" standing check.
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
import type { ListProfitResponse, ProfitSortBy, ProfitSortDir, PurchaseStatus } from '@pc-parts-flipper/shared';
import { countProfitByPurchase, listProfitByPurchase } from '../db/index.js';
import { logger } from '../logger.js';
import { VALID_PURCHASE_STATUSES } from './purchaseValidation.js';

// The only values GET /api/purchases/profit's sortBy query param accepts;
// anything else falls back to the default (purchaseDate) rather than erroring
// — GET requests validate loosely, matching the convention in parts.ts/
// purchases.ts's list handlers.
const VALID_SORT_BY: readonly ProfitSortBy[] = ['netProfit', 'pricePaid', 'purchaseDate'];

/**
 * Registers the `/api/purchases/profit` route on the given Fastify instance.
 * Called once from index.ts during server bootstrap, the same way
 * registerPurchasesRoutes is.
 */
export async function registerProfitRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.get('/api/purchases/profit', async (request): Promise<ListProfitResponse> => {
    const { status, partial, sortBy, sortDir, limit, offset } = request.query as {
      status?: string;
      partial?: string;
      sortBy?: string;
      sortDir?: string;
      limit?: string;
      offset?: string;
    };
    // An unrecognized status/sortBy value is ignored (no filter/default sort
    // applied) rather than rejected, same loose-GET convention as parts.ts.
    const statusFilter = typeof status === 'string' && VALID_PURCHASE_STATUSES.includes(status as PurchaseStatus) ? (status as PurchaseStatus) : undefined;
    // `partial` query param is "true"/"false" text; anything else leaves the
    // filter off so both partial and final rows are returned.
    const partialFilter = partial === 'true' ? true : partial === 'false' ? false : undefined;
    const sortByValue = typeof sortBy === 'string' && VALID_SORT_BY.includes(sortBy as ProfitSortBy) ? (sortBy as ProfitSortBy) : 'purchaseDate';
    const sortDirValue: ProfitSortDir = sortDir === 'asc' ? 'asc' : 'desc';
    // Pagination (Req 15): limit/offset query params, defaulting to a single
    // page of 20 so the Profit dashboard never renders an unbounded list.
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    logger.info(
      {
        route: 'GET /api/purchases/profit',
        status: statusFilter,
        partial: partialFilter,
        sortBy: sortByValue,
        sortDir: sortDirValue,
        limit: limitValue,
        offset: offsetValue,
      },
      'Listing purchase profit rollup',
    );
    // Sequential, not Promise.all: two statements running concurrently on
    // DuckDB's single shared connection (db/client.ts) proved intermittently
    // unreliable under load (same lesson T8/T10/T12 hit building their lists).
    const options = { status: statusFilter, partial: partialFilter, sortBy: sortByValue, sortDir: sortDirValue, limit: limitValue, offset: offsetValue };
    const purchases = await listProfitByPurchase(options);
    const total = await countProfitByPurchase(options);
    return { purchases, total };
  });
}
