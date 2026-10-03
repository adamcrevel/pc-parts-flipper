// HTTP routes for the Purchase lifecycle (Req 5), its own price-paid/
// purchase-date edit (Req 13), and the list/detail reads the Purchases
// screens need. Every handler below reaches the database exclusively
// through the named exports of apps/server/src/db (barrel at db/index.ts)
// — never a direct DuckDB call — per the "all DuckDB access confined to
// db/**" standing check. Request validation and the status-transition rule
// live in the sibling purchaseValidation.ts, split out to keep this file
// under the ~200-line standing check.
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
import type {
  ListPurchasesResponse,
  Purchase,
  PurchaseDetail,
  PurchaseStatus,
  PurchaseSummary,
  UpdatePurchaseInput,
  UpdatePurchaseStatusInput,
} from '@pc-parts-flipper/shared';
import {
  countPurchases,
  getListingById,
  getPurchaseById,
  listExpectedPartsByListing,
  listPurchasesWithListingSummary,
  updatePurchase,
  type PurchaseWithListingSummary,
} from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { validatePurchaseEditInput, validateStatusTransition, VALID_PURCHASE_STATUSES } from './purchaseValidation.js';

// Reshapes a Purchase-joined-with-Listing row (one SQL query, no per-row
// round trip — see db/queries/purchases.ts's listPurchasesWithListingSummary
// doc comment for why fanning out a query per row broke under DuckDB's
// single-connection concurrency limits) into the Req 5 embedded Listing
// summary shape for the list response.
function toSummary(row: PurchaseWithListingSummary): PurchaseSummary {
  const { listingTitle, expectedPartsCount, ...purchase } = row;
  return { ...purchase, listing: { id: purchase.listingId, title: listingTitle, expectedPartsCount } };
}

// Attaches the full originating Listing (including its Expected Parts) to a
// Purchase for the single-purchase response — this is what T9's teardown
// screen reconciles against, and what this task's detail screen displays.
async function toDetail(purchase: Purchase): Promise<PurchaseDetail> {
  const listing = await getListingById(purchase.listingId);
  if (!listing) {
    // A Purchase's listing_id is a NOT NULL foreign key, so a missing row
    // here means data corruption rather than a normal 404 — surfaced as a
    // 500 rather than silently rendering a blank Listing panel.
    throw new AppError(`Listing ${purchase.listingId} for purchase ${purchase.id} not found`, 500);
  }
  const expectedParts = await listExpectedPartsByListing(listing.id);
  return { ...purchase, listing: { ...listing, expectedParts } };
}

/**
 * Registers all `/api/purchases` routes on the given Fastify instance.
 * Called once from index.ts during server bootstrap, the same way
 * registerListingsRoutes is.
 */
export async function registerPurchasesRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.get('/api/purchases', async (request): Promise<ListPurchasesResponse> => {
    const { status, limit, offset } = request.query as { status?: string; limit?: string; offset?: string };
    // An unrecognized status value is ignored (no filter applied) rather
    // than rejected — GET requests validate loosely, unlike the write path.
    const statusFilter =
      typeof status === 'string' && VALID_PURCHASE_STATUSES.includes(status as PurchaseStatus) ? (status as PurchaseStatus) : undefined;
    // Pagination (Req 15): limit/offset query params, defaulting to a
    // single page of 20 so the Purchases list never renders an unbounded
    // list. `total` lets the frontend compute page count without a second
    // unpaginated fetch.
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    logger.info({ route: 'GET /api/purchases', status: statusFilter, limit: limitValue, offset: offsetValue }, 'Listing purchases');
    // Sequential, not Promise.all: two statements running concurrently on
    // DuckDB's single shared connection (db/client.ts) proved intermittently
    // unreliable ("Failed to execute prepared statement") under load testing.
    const purchases = await listPurchasesWithListingSummary({ status: statusFilter, limit: limitValue, offset: offsetValue });
    const total = await countPurchases({ status: statusFilter });
    return { purchases: purchases.map(toSummary), total };
  });

  server.get('/api/purchases/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/purchases/:id', id }, 'Fetching purchase');
    const purchase = await getPurchaseById(id);
    if (!purchase) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    return toDetail(purchase);
  });

  server.put('/api/purchases/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PUT /api/purchases/:id', id }, 'Updating purchase');
    const existing = await getPurchaseById(id);
    if (!existing) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    const input = validatePurchaseEditInput((request.body ?? {}) as Partial<UpdatePurchaseInput>);
    const updated = await updatePurchase(id, input);
    if (!updated) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    return toDetail(updated);
  });

  server.patch('/api/purchases/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PATCH /api/purchases/:id/status', id }, 'Updating purchase status');
    const existing = await getPurchaseById(id);
    if (!existing) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    const { status } = (request.body ?? {}) as Partial<UpdatePurchaseStatusInput>;
    // Req 5: ordered -> shipped -> received -> torn_down -> closed, one step
    // forward at a time only; validateStatusTransition rejects a skip, a
    // reversal, or a transition requested from the terminal 'closed' state.
    const nextStatus = validateStatusTransition(existing.status, status);
    const updated = await updatePurchase(id, { status: nextStatus });
    if (!updated) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    return toDetail(updated);
  });
}
