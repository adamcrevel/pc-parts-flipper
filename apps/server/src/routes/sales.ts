// HTTP routes for recording the final sale outcome of a `listed` Part (Req
// 9), plus GET reads for the Sales list (Req 9, 15). Every handler below
// reaches the database exclusively through the named exports of
// apps/server/src/db (barrel at db/index.ts) — never a direct DuckDB call —
// per the "all DuckDB access confined to db/**" standing check. Request
// validation lives in the sibling salesValidation.ts, split out to keep
// this file under the ~200-line standing check. The `listed -> sold` Part
// transition on record-sale reuses partValidation.ts's
// validatePartStatusTransition rather than duplicating the forward-only
// rule T7 already built — which also means a second sale against an
// already-sold Part is rejected for free (it's no longer 'listed').
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
import type { ListSalesResponse, RecordSaleResponse } from '@pc-parts-flipper/shared';
import { countSales, createSale, getPartById, getPartWithContextById, getSaleById, listSales, updatePart } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { toSummary } from './parts.js';
import { validatePartStatusTransition } from './partValidation.js';
import { validateCreateSaleInput, type SaleRequestBody } from './salesValidation.js';

/**
 * Registers the `/api/parts/:partId/sale` and `/api/sales` routes on the
 * given Fastify instance. Called once from index.ts during server
 * bootstrap, the same way registerSaleListingsRoutes is.
 */
export async function registerSalesRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post('/api/parts/:partId/sale', async (request, reply): Promise<RecordSaleResponse> => {
    const { partId } = request.params as { partId: string };
    logger.info({ route: 'POST /api/parts/:partId/sale', partId }, 'Recording sale');
    const part = await getPartById(partId);
    if (!part) {
      throw new AppError(`Part ${partId} not found`, 404);
    }
    // Req 9: a Sale can only be recorded against a Part that's currently
    // listed. This also rejects a second sale against the same Part: once
    // the first sale moves it to 'sold' below, it is no longer 'listed'.
    if (part.status !== 'listed') {
      throw new AppError(`Cannot record a sale for part ${partId}: it is '${part.status}', not 'listed'`, 400);
    }
    const input = validateCreateSaleInput(request.body as SaleRequestBody);
    const sale = await createSale({ partId, ...input });
    // Reuses T7's forward-only transition rule (Req 7) instead of
    // duplicating it — rejects anything but listed -> sold.
    const { status: nextStatus, unsellableReason } = validatePartStatusTransition(part.status, 'sold', undefined);
    await updatePart(part.id, { status: nextStatus, unsellableReason });
    const updatedPart = await getPartWithContextById(part.id);
    if (!updatedPart) {
      throw new AppError(`Part ${part.id} not found`, 404);
    }
    reply.status(201);
    return { sale, part: toSummary(updatedPart) };
  });

  server.get('/api/sales', async (request): Promise<ListSalesResponse> => {
    const { partId, limit, offset } = request.query as { partId?: string; limit?: string; offset?: string };
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    logger.info({ route: 'GET /api/sales', partId, limit: limitValue, offset: offsetValue }, 'Listing sales');
    // Sequential, not Promise.all: DuckDB's single shared connection
    // (db/client.ts) proved intermittently unreliable under concurrent
    // statements — see parts.ts/saleListings.ts's own GET list handlers.
    const options = { partId, limit: limitValue, offset: offsetValue };
    const sales = await listSales(options);
    const total = await countSales(options);
    return { sales, total };
  });

  server.get('/api/sales/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/sales/:id', id }, 'Fetching sale');
    const sale = await getSaleById(id);
    if (!sale) {
      throw new AppError(`Sale ${id} not found`, 404);
    }
    return sale;
  });
}
