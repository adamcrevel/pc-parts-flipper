// HTTP routes for the Parts list/detail reads and the Req 7 status
// transition the Parts screen needs. Every handler below reaches the
// database exclusively through the named exports of apps/server/src/db
// (barrel at db/index.ts) — never a direct DuckDB call — per the "all
// DuckDB access confined to db/**" standing check. The status-transition
// rule lives in the sibling partValidation.ts, split out to keep this file
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
import type { ListPartsResponse, PartStatus, PartSummary, UpdatePartStatusInput } from '@pc-parts-flipper/shared';
import { countParts, getPartById, getPartWithContextById, listPartsWithContext, updatePart, type PartWithPurchaseSummary } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { validatePartStatusTransition, VALID_PART_STATUSES } from './partValidation.js';

// Reshapes a Part-joined-with-Purchase/Listing row (one SQL query, no
// per-row round trip — see db/queries/parts.ts's listPartsWithContext doc
// comment) into the Req 7 embedded Purchase summary shape for the
// list/detail response. Exported so routes/saleListings.ts (Req 8's
// mark-listed response, which embeds the now-`listed` Part) can reuse the
// same reshape instead of duplicating it.
export function toSummary(row: PartWithPurchaseSummary): PartSummary {
  const { purchaseListingTitle, ...part } = row;
  return { ...part, purchase: { id: part.purchaseId, listingTitle: purchaseListingTitle } };
}

/**
 * Registers all `/api/parts` routes on the given Fastify instance. Called
 * once from index.ts during server bootstrap, the same way
 * registerPurchasesRoutes is.
 */
export async function registerPartsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.get('/api/parts', async (request): Promise<ListPartsResponse> => {
    const { status, purchaseId, limit, offset } = request.query as {
      status?: string;
      purchaseId?: string;
      limit?: string;
      offset?: string;
    };
    // An unrecognized status value is ignored (no filter applied) rather
    // than rejected — GET requests validate loosely, unlike the write path.
    const statusFilter = typeof status === 'string' && VALID_PART_STATUSES.includes(status as PartStatus) ? (status as PartStatus) : undefined;
    // Pagination (Req 15): limit/offset query params, defaulting to a
    // single page of 20 so the Parts list never renders an unbounded list.
    // `total` lets the frontend compute page count without a second
    // unpaginated fetch.
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    logger.info(
      { route: 'GET /api/parts', status: statusFilter, purchaseId, limit: limitValue, offset: offsetValue },
      'Listing parts',
    );
    // Sequential, not Promise.all: two statements running concurrently on
    // DuckDB's single shared connection (db/client.ts) proved intermittently
    // unreliable ("Failed to execute prepared statement") under load testing
    // (same lesson T8 hit building the Purchases list).
    const options = { status: statusFilter, purchaseId, limit: limitValue, offset: offsetValue };
    const parts = await listPartsWithContext(options);
    const total = await countParts(options);
    return { parts: parts.map(toSummary), total };
  });

  server.get('/api/parts/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/parts/:id', id }, 'Fetching part');
    const row = await getPartWithContextById(id);
    if (!row) {
      throw new AppError(`Part ${id} not found`, 404);
    }
    return toSummary(row);
  });

  server.patch('/api/parts/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PATCH /api/parts/:id/status', id }, 'Updating part status');
    const existing = await getPartById(id);
    if (!existing) {
      throw new AppError(`Part ${id} not found`, 404);
    }
    const { status, reason } = (request.body ?? {}) as Partial<UpdatePartStatusInput>;
    // Req 7: ready_to_list -> listed -> sold, one step forward at a time, OR
    // the ready_to_list -> unsellable side-branch requiring a non-blank
    // reason note (Req 13); validatePartStatusTransition rejects a skip, a
    // reversal, an unsellable request from any status but ready_to_list, or
    // an unsellable request with a blank reason.
    const { status: nextStatus, unsellableReason } = validatePartStatusTransition(existing.status, status, reason);
    await updatePart(id, { status: nextStatus, unsellableReason });
    const updated = await getPartWithContextById(id);
    if (!updated) {
      throw new AppError(`Part ${id} not found`, 404);
    }
    return toSummary(updated);
  });
}
