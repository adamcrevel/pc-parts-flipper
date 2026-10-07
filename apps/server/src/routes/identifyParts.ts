// HTTP routes for the async identify-parts queue (T3):
// - POST /api/listings/:id/identify-parts: enqueue or fetch active job
// - GET /api/listings/:id/identify-parts-jobs/latest: poll for job result
//
// The first route enqueues a new job via insertQueuedJobIfNoneActive (atomic
// check-and-insert) and returns 201 with the newly created job, or 409 if one's
// already active (Requirement 13: concurrency-safe). The second route fetches
// the most recent job (any stage) for a Listing, so a frontend can poll it until
// it reaches a terminal stage (completed/failed) and the result is available.
//
// These routes directly query the jobs table; the background worker
// (T2, jobs/identifyPartsWorker.ts) owns the job lifecycle transitions
// (queued -> identifying -> sourcing_references -> comparing -> completed/failed).
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
import type { IdentifyPartsJob } from '@pc-parts-flipper/shared';
import {
  insertQueuedJobIfNoneActive,
  getLatestJobForListing,
  getListingById,
} from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';

/**
 * Registers the two identify-parts-queue routes (`POST .../identify-parts`,
 * `GET .../identify-parts-jobs/latest`) on the given Fastify instance.
 * Called once from index.ts during bootstrap, alongside the other route
 * registrations. The generic re-declaration matches every other route module
 * here, so TypeScript infers the pino-backed server's own Logger type
 * instead of defaulting to FastifyBaseLogger.
 */
export async function registerIdentifyPartsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post<{ Params: { id: string } }>('/api/listings/:id/identify-parts', async (request, reply): Promise<IdentifyPartsJob> => {
    const { id } = request.params;
    logger.info({ route: 'POST /api/listings/:id/identify-parts', id }, 'Enqueueing identify-parts job');

    const listing = await getListingById(id);
    if (!listing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }

    const job = await insertQueuedJobIfNoneActive(id);
    if (job) {
      // Successfully created a new queued job
      reply.status(201);
      return job;
    }

    // A job already exists in an active stage
    throw new AppError(`Listing ${id} already has an active identify-parts job`, 409);
  });

  server.get<{ Params: { id: string } }>('/api/listings/:id/identify-parts-jobs/latest', async (request): Promise<IdentifyPartsJob> => {
    const { id } = request.params;
    logger.info({ route: 'GET /api/listings/:id/identify-parts-jobs/latest', id }, 'Fetching latest identify-parts job');

    const job = await getLatestJobForListing(id);
    if (!job) {
      throw new AppError(`No identify-parts job for listing ${id}`, 404);
    }

    return job;
  });
}
