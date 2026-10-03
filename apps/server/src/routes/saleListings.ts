// HTTP routes for drafting, editing, listing, and posting Sale Listings
// (Req 8). Every handler below reaches the database exclusively through the
// named exports of apps/server/src/db (barrel at db/index.ts) — never a
// direct DuckDB call — per the "all DuckDB access confined to db/**"
// standing check. Request validation lives in the sibling
// saleListingValidation.ts, split out to keep this file under the ~200-line
// standing check. The `ready_to_list -> listed` Part transition on
// mark-listed reuses partValidation.ts's validatePartStatusTransition
// rather than duplicating the forward-only rule T7 already built.
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
import type { ListSaleListingsResponse, MarkSaleListingListedResponse } from '@pc-parts-flipper/shared';
import {
  countSaleListings,
  createSaleListing,
  getPartById,
  getPartWithContextById,
  getSaleListingById,
  listSaleListings,
  updatePart,
  updateSaleListing,
  type SaleListing,
} from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { toSummary } from './parts.js';
import { validatePartStatusTransition } from './partValidation.js';
import { validateCreateSaleListingInput, validateUpdateSaleListingInput, type SaleListingRequestBody } from './saleListingValidation.js';

// Throws AppError(400) unless `listing` is still a draft (never posted) —
// shared by the PUT edit route (Req 8: "edit the draft ... while still in
// draft") and the mark-listed route (reject a repeat post).
function requireDraftSaleListing(listing: SaleListing): void {
  if (listing.listedAt !== null) {
    throw new AppError(`Sale Listing ${listing.id} has already been listed and can no longer be edited`, 400);
  }
}

/**
 * Registers all `/api/parts/:partId/sale-listings` and `/api/sale-listings`
 * routes on the given Fastify instance. Called once from index.ts during
 * server bootstrap, the same way registerPartsRoutes is.
 */
export async function registerSaleListingsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post('/api/parts/:partId/sale-listings', async (request, reply) => {
    const { partId } = request.params as { partId: string };
    logger.info({ route: 'POST /api/parts/:partId/sale-listings', partId }, 'Drafting sale listing');
    const part = await getPartById(partId);
    if (!part) {
      throw new AppError(`Part ${partId} not found`, 404);
    }
    // Req 8: a Sale Listing can only be drafted for a Part that's currently
    // ready_to_list — not yet listed/sold/unsellable.
    if (part.status !== 'ready_to_list') {
      throw new AppError(`Cannot draft a Sale Listing for part ${partId}: it is '${part.status}', not 'ready_to_list'`, 400);
    }
    const input = validateCreateSaleListingInput(request.body as SaleListingRequestBody, part);
    const created = await createSaleListing({ partId, ...input });
    reply.status(201);
    return created;
  });

  server.get('/api/sale-listings', async (request): Promise<ListSaleListingsResponse> => {
    const { partId, limit, offset } = request.query as { partId?: string; limit?: string; offset?: string };
    // Pagination (Req 15): limit/offset query params, defaulting to a
    // single page of 20 so the Sale Listings screen never renders an
    // unbounded list. `total` lets the frontend compute page count without
    // a second unpaginated fetch.
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    logger.info({ route: 'GET /api/sale-listings', partId, limit: limitValue, offset: offsetValue }, 'Listing sale listings');
    // Sequential, not Promise.all: DuckDB's single shared connection
    // (db/client.ts) proved intermittently unreliable under concurrent
    // statements — see parts.ts/purchases.ts's own GET list handlers.
    const options = { partId, limit: limitValue, offset: offsetValue };
    const saleListings = await listSaleListings(options);
    const total = await countSaleListings(options);
    return { saleListings, total };
  });

  server.get('/api/sale-listings/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/sale-listings/:id', id }, 'Fetching sale listing');
    const saleListing = await getSaleListingById(id);
    if (!saleListing) {
      throw new AppError(`Sale Listing ${id} not found`, 404);
    }
    return saleListing;
  });

  server.put('/api/sale-listings/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PUT /api/sale-listings/:id', id }, 'Updating sale listing');
    const existing = await getSaleListingById(id);
    if (!existing) {
      throw new AppError(`Sale Listing ${id} not found`, 404);
    }
    requireDraftSaleListing(existing);
    const input = validateUpdateSaleListingInput(request.body as SaleListingRequestBody);
    const updated = await updateSaleListing(id, input);
    if (!updated) {
      throw new AppError(`Sale Listing ${id} not found`, 404);
    }
    return updated;
  });

  server.post('/api/sale-listings/:id/mark-listed', async (request): Promise<MarkSaleListingListedResponse> => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/sale-listings/:id/mark-listed', id }, 'Marking sale listing listed');
    const existing = await getSaleListingById(id);
    if (!existing) {
      throw new AppError(`Sale Listing ${id} not found`, 404);
    }
    requireDraftSaleListing(existing);
    const part = await getPartById(existing.partId);
    if (!part) {
      throw new AppError(`Part ${existing.partId} not found`, 404);
    }
    // Reuses T7's forward-only transition rule (Req 7) instead of
    // duplicating it — rejects anything but ready_to_list -> listed.
    const { status: nextStatus, unsellableReason } = validatePartStatusTransition(part.status, 'listed', undefined);
    await updatePart(part.id, { status: nextStatus, unsellableReason });
    const updatedSaleListing = await updateSaleListing(id, { listedAt: new Date().toISOString() });
    if (!updatedSaleListing) {
      throw new AppError(`Sale Listing ${id} not found`, 404);
    }
    const updatedPart = await getPartWithContextById(part.id);
    if (!updatedPart) {
      throw new AppError(`Part ${part.id} not found`, 404);
    }
    return { saleListing: updatedSaleListing, part: toSummary(updatedPart) };
  });
}
