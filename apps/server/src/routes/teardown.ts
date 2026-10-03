// HTTP routes for the Req 6 teardown workflow: reconciling a 'received'
// Purchase's Expected Parts against what actually arrived, and generating
// the Part records that feed the Req 7 Parts screen. Every handler reaches
// the database exclusively through the named exports of apps/server/src/db
// (db/index.ts barrel) — never a direct DuckDB call — per the "all DuckDB
// access confined to db/**" standing check.
//
// Design choice (no partial persistence): the submission is one atomic,
// all-or-nothing POST, not a series of autosaved per-row PATCHes. A teardown
// form only ever needs filling out once per Purchase — GET only returns a
// partially-filled form's worth of inputs if the browser tab was closed
// mid-fill, which React state loss already makes a non-goal here (assumption:
// resuming an in-progress-but-unsubmitted form is out of scope for this
// task) — so there is nothing to resume from until a submission has
// actually landed. `existingResults` on the GET response is therefore only
// ever populated after a successful POST already moved the Purchase to
// `torn_down`, letting a caller that re-opens this screen see what was
// recorded instead of re-deriving it from the (now side-effect-free) Parts
// list.
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
import type { Part, SubmitTeardownResponse, TeardownFormResponse, TeardownResult } from '@pc-parts-flipper/shared';
import {
  createPart,
  createTeardownResult,
  getListingById,
  getPurchaseById,
  listExpectedPartsByListing,
  listTeardownResultsByPurchase,
  updatePurchase,
} from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { validateStatusTransition } from './purchaseValidation.js';
import { validateTeardownSubmission, type SubmitTeardownRequestBody } from './teardownValidation.js';

/**
 * Registers the `/api/purchases/:id/teardown` routes on the given Fastify
 * instance. Called once from index.ts during server bootstrap, the same way
 * registerPurchasesRoutes is.
 */
export async function registerTeardownRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.get('/api/purchases/:id/teardown', async (request): Promise<TeardownFormResponse> => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/purchases/:id/teardown', id }, 'Fetching teardown form');
    const purchase = await getPurchaseById(id);
    if (!purchase) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    const listing = await getListingById(purchase.listingId);
    if (!listing) {
      // A Purchase's listing_id is a NOT NULL foreign key (same reasoning as
      // purchases.ts's toDetail): missing here means data corruption, not a
      // normal 404.
      throw new AppError(`Listing ${purchase.listingId} for purchase ${purchase.id} not found`, 500);
    }
    // Sequential, not Promise.all — see the standing lesson from T8 on
    // DuckDB's single shared connection (db/client.ts) under overlapping
    // concurrent queries.
    const expectedParts = await listExpectedPartsByListing(listing.id);
    const existingResults = await listTeardownResultsByPurchase(purchase.id);
    return { purchaseId: purchase.id, purchaseStatus: purchase.status, expectedParts, existingResults };
  });

  server.post('/api/purchases/:id/teardown', async (request): Promise<SubmitTeardownResponse> => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/purchases/:id/teardown', id }, 'Submitting teardown');
    const purchase = await getPurchaseById(id);
    if (!purchase) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    if (purchase.status !== 'received') {
      throw new AppError(`Cannot submit teardown for purchase ${id}: status is '${purchase.status}', not 'received'`, 400);
    }
    const listing = await getListingById(purchase.listingId);
    if (!listing) {
      throw new AppError(`Listing ${purchase.listingId} for purchase ${purchase.id} not found`, 500);
    }
    const expectedParts = await listExpectedPartsByListing(listing.id);
    const { results, additionalParts } = validateTeardownSubmission((request.body ?? {}) as SubmitTeardownRequestBody, expectedParts);
    const expectedPartsById = new Map(expectedParts.map((part) => [part.id, part]));

    // Sequential awaits throughout, not Promise.all — DuckDB's single shared
    // connection (db/client.ts) proved intermittently unreliable under
    // concurrent per-row calls (T8's lesson); this is "as atomic as this
    // DuckDB setup allows" for a multi-row, multi-table write.
    const teardownResults: TeardownResult[] = [];
    const createdParts: Part[] = [];
    for (const entry of results) {
      const expectedPart = expectedPartsById.get(entry.expectedPartId);
      if (!expectedPart) {
        // Unreachable: validateTeardownSubmission already resolved every
        // entry against expectedPartsById. Guards TypeScript's Map.get
        // return type rather than a real runtime path.
        throw new AppError(`Expected part ${entry.expectedPartId} not found`, 500);
      }
      teardownResults.push(
        await createTeardownResult({ purchaseId: purchase.id, expectedPartId: expectedPart.id, result: entry.result, note: entry.note ?? null }),
      );
      // 'missing' means nothing physically arrived — no Part to track.
      if (entry.result !== 'missing') {
        createdParts.push(await createPart({ purchaseId: purchase.id, category: expectedPart.componentCategory, description: expectedPart.description }));
      }
    }
    for (const additional of additionalParts) {
      teardownResults.push(
        await createTeardownResult({ purchaseId: purchase.id, expectedPartId: null, result: 'additional', note: additional.note }),
      );
      createdParts.push(await createPart({ purchaseId: purchase.id, category: additional.category, description: additional.description }));
    }

    // Reuses purchases.ts's own forward-only lifecycle rule rather than
    // duplicating it — teardown is just another one-step transition (Req 5).
    const nextStatus = validateStatusTransition(purchase.status, 'torn_down');
    const updated = await updatePurchase(purchase.id, { status: nextStatus });
    if (!updated) {
      throw new AppError(`Purchase ${id} not found`, 404);
    }
    return { purchaseId: updated.id, purchaseStatus: updated.status, teardownResults, createdParts };
  });
}
