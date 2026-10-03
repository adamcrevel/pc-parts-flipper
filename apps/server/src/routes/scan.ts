// HTTP route for triggering an automated marketplace scan on one Source
// (Req 2, 7). The handler is a thin wrapper over scanService.ts's
// scanSource — it never resolves a connector or touches the database
// itself — since scanSource already throws AppError(404) for an unknown
// sourceId and AppError(400) for an ineligible Source (no connectorConfig,
// inactive, or an unregistered platformType via the connector registry),
// both of which the central error handler (error-handler.ts) already
// translates into the right HTTP response, the same way every other route
// in this module lets AppError propagate rather than catching it.
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
import { logger } from '../logger.js';
import { scanSource } from '../scan/scanService.js';

/**
 * Registers the `/api/sources/:id/scan` route on the given Fastify
 * instance. Called once from index.ts during server bootstrap, the same way
 * registerSourcesRoutes is. The generic re-declaration (matching
 * registerSourcesRoutes/registerErrorHandler) lets TypeScript infer this
 * server's actual Logger type from the argument instead of defaulting to
 * FastifyBaseLogger, which the pino-backed `server` instance in index.ts is
 * not structurally assignable to.
 */
export async function registerScanRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post('/api/sources/:id/scan', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/sources/:id/scan', id }, 'Running source scan');
    const { foundCount, newCount } = await scanSource(id);
    return { foundCount, newCount };
  });
}
