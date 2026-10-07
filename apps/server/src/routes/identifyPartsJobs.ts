// HTTP routes for identify-parts job polling and acknowledgment (T3):
// - GET /api/identify-parts-jobs/:jobId: fetch a job by id
// - POST /api/identify-parts-jobs/:jobId/ack: mark a terminal job as delivered
//
// These routes allow a frontend to fetch a specific job by its id (after
// getting it from the POST /api/listings/:id/identify-parts enqueue response)
// and acknowledge it once it has seen the result, preventing a second poll
// from re-delivering the same result data.
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
import { getJobById, markDelivered } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';

/**
 * Registers the identify-parts job polling and acknowledgment routes on the
 * given Fastify instance. Called once from index.ts during bootstrap,
 * alongside the other route registrations. The generic re-declaration matches
 * every other route module here, so TypeScript infers the pino-backed
 * server's own Logger type instead of defaulting to FastifyBaseLogger.
 */
export async function registerIdentifyPartsJobsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.get<{ Params: { jobId: string } }>('/api/identify-parts-jobs/:jobId', async (request) => {
    const { jobId } = request.params;
    logger.info({ route: 'GET /api/identify-parts-jobs/:jobId', jobId }, 'Fetching identify-parts job');

    const job = await getJobById(jobId);
    if (!job) {
      throw new AppError(`Identify-parts job ${jobId} not found`, 404);
    }

    return job;
  });

  server.post<{ Params: { jobId: string } }>('/api/identify-parts-jobs/:jobId/ack', async (request): Promise<IdentifyPartsJob> => {
    const { jobId } = request.params;
    logger.info({ route: 'POST /api/identify-parts-jobs/:jobId/ack', jobId }, 'Acknowledging identify-parts job');

    const job = await getJobById(jobId);
    if (!job) {
      throw new AppError(`Identify-parts job ${jobId} not found`, 404);
    }

    // Only terminal jobs (completed or failed) can be acknowledged
    if (job.stage !== 'completed' && job.stage !== 'failed') {
      throw new AppError(`Job ${jobId} has nothing to acknowledge yet`, 400);
    }

    await markDelivered(jobId);
    // Return the updated job (with delivered flag now true)
    const updated = await getJobById(jobId);
    return updated!; // Safe to assert non-null since we just updated it
  });
}
