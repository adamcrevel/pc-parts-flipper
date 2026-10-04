// HTTP route for on-demand AI identification of a Listing's Expected Parts.
// A thin wrapper over ai/partIdentification.ts: it resolves the Listing (404
// if it does not exist, the same getListingById-based check every other
// Listing sub-route uses) and returns the identification result verbatim.
// Every failure inside the identification itself is already an AppError with
// a client-safe message, so nothing is caught here — error-handler.ts turns it
// into the right status, exactly as the scan route does with scanSource.
//
// The response is deliberately *not* persisted: suggestions are draft rows the
// user edits or discards in the Expected Parts editor, and only a normal
// Listing save writes anything to the database.
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
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import { identifyListingParts } from '../ai/partIdentification.js';
import { getListingById } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';

/**
 * Registers `POST /api/listings/:id/identify-parts` on the given Fastify
 * instance. Called once from index.ts during bootstrap, alongside the other
 * route registrations. The generic re-declaration matches every other route
 * module here, so TypeScript infers the pino-backed server's own Logger type
 * instead of defaulting to FastifyBaseLogger.
 */
export async function registerIdentifyPartsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post('/api/listings/:id/identify-parts', async (request): Promise<IdentifyPartsResponse> => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/listings/:id/identify-parts', id }, 'Identifying listing parts with AI');

    const listing = await getListingById(id);
    if (!listing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }

    return identifyListingParts(listing);
  });
}
