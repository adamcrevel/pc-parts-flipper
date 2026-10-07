// HTTP routes for Listing CRUD with nested Expected Parts (Req 2-4, 12, 15)
// and the Req 3 comparison calculation. Every handler below reaches the
// database exclusively through the named exports of apps/server/src/db
// (barrel at db/index.ts) — never a direct DuckDB call — per the "all
// DuckDB access confined to db/**" standing check. Request validation lives
// in the sibling listingValidation.ts and photo uploads in listingPhotos.ts,
// split out to keep this file under the ~200-line standing check.
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
import type { AcceptListingResponse, ExpectedPartInput, ListingComparison, ListingDetail, ListingStatus, ListingSummary, ListListingsResponse } from '@pc-parts-flipper/shared';
import {
  countListings,
  createExpectedPart,
  createListing,
  createPurchase,
  deleteExpectedPart,
  getListingById,
  listExpectedPartsByListing,
  listListings,
  promoteReferencePhotos,
  transitionOpenListing,
  updateListing,
  type ExpectedPart,
  type Listing,
} from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { registerListingPhotoRoutes } from './listingPhotos.js';
import { VALID_STATUSES, validateListingInput, type ListingRequestBody } from './listingValidation.js';

// Req 3: sum of Expected Parts' estimated resale values vs. (asking price +
// acquisition fees/shipping), plus their difference.
function computeComparison(listing: Listing, expectedParts: ExpectedPart[]): ListingComparison {
  const totalExpectedResaleValue = expectedParts.reduce((sum, part) => sum + (part.estimatedResaleValue ?? 0), 0);
  const totalCost = listing.askingPrice + listing.acquisitionFees;
  return { totalExpectedResaleValue, totalCost, difference: totalExpectedResaleValue - totalCost };
}

// Attaches the Req 3 comparison to a Listing for the list response, without
// the full Expected Parts array (kept out of the lighter list payload; the
// single-listing response below includes it).
async function toSummary(listing: Listing): Promise<ListingSummary> {
  const expectedParts = await listExpectedPartsByListing(listing.id);
  return { ...listing, comparison: computeComparison(listing, expectedParts) };
}

// Attaches both the full Expected Parts set and the Req 3 comparison, for
// the single-listing response.
async function toDetail(listing: Listing): Promise<ListingDetail> {
  const expectedParts = await listExpectedPartsByListing(listing.id);
  return { ...listing, expectedParts, comparison: computeComparison(listing, expectedParts) };
}

// Req 4: both accept and reject require the Listing to currently be open —
// a repeat accept/reject, or one against an already-decided Listing, is
// rejected with AppError(400) rather than silently re-applied.
function requireOpenListing(listing: Listing): void {
  if (listing.status !== 'open') {
    throw new AppError(`Listing ${listing.id} is not open (current status: ${listing.status})`, 400);
  }
}

/** Promotes reference photos for any Expected Parts with confirmed brands. */
export async function promoteReferencesForExpectedParts(
  listingId: string,
  photoPaths: readonly string[],
  expectedParts: ExpectedPartInput[],
): Promise<void> {
  for (const part of expectedParts) {
    if (part.brand) {
      try {
        await promoteReferencePhotos(listingId, photoPaths, part.componentCategory, part.brand, part.partNumber ?? null);
      } catch (err) {
        logger.error({ err, listingId, part }, 'Failed to promote reference photos for Expected Part');
      }
    }
  }
}

/**
 * Registers all `/api/listings` routes (plus, via registerListingPhotoRoutes,
 * the photo-upload route) on the given Fastify instance. Called once from
 * index.ts during server bootstrap, the same way registerSourcesRoutes is.
 */
export async function registerListingsRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  server.post('/api/listings', async (request, reply) => {
    logger.info({ route: 'POST /api/listings' }, 'Creating listing');
    const { listing: input, expectedParts } = validateListingInput(request.body as ListingRequestBody);
    const created = await createListing({ ...input, photoPaths: [] });
    // Nested Expected Parts are created together with the Listing in this
    // one request (Req 2) — order doesn't matter, so these run concurrently.
    await Promise.all(expectedParts.map((part) => createExpectedPart({ listingId: created.id, ...part })));
    // Promote reference photos for any Expected Part with a confirmed brand (Req T2)
    await promoteReferencesForExpectedParts(created.id, created.photoPaths, expectedParts);
    reply.status(201);
    return toDetail(created);
  });

  server.get('/api/listings', async (request): Promise<ListListingsResponse> => {
    const { status, sourceId, limit, offset } = request.query as {
      status?: string;
      sourceId?: string;
      limit?: string;
      offset?: string;
    };
    // An unrecognized status value is ignored (no filter applied) rather
    // than rejected — GET requests validate loosely, unlike the write path.
    const statusFilter = typeof status === 'string' && VALID_STATUSES.includes(status as ListingStatus) ? (status as ListingStatus) : undefined;
    const sourceIdFilter = sourceId && sourceId.length > 0 ? sourceId : undefined;
    // Pagination (Req 15): limit/offset query params, defaulting to a
    // single page of 20 so the Listings queue screen never renders an
    // unbounded list. `total` lets the frontend compute page count without
    // a second unpaginated fetch.
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    logger.info({ route: 'GET /api/listings', status: statusFilter, sourceId: sourceIdFilter, limit: limitValue, offset: offsetValue }, 'Listing listings');
    const [listings, total] = await Promise.all([
      listListings({ status: statusFilter, sourceId: sourceIdFilter, limit: limitValue, offset: offsetValue }),
      countListings({ status: statusFilter, sourceId: sourceIdFilter }),
    ]);
    return { listings: await Promise.all(listings.map(toSummary)), total };
  });

  server.get('/api/listings/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'GET /api/listings/:id', id }, 'Fetching listing');
    const listing = await getListingById(id);
    if (!listing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    return toDetail(listing);
  });

  server.put('/api/listings/:id', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'PUT /api/listings/:id', id }, 'Updating listing');
    const existing = await getListingById(id);
    if (!existing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    const { listing: input, expectedParts } = validateListingInput(request.body as ListingRequestBody);
    const updated = await updateListing(id, input);
    if (!updated) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    // Full replace: the edit form resubmits every row, so the existing set
    // is cleared and recreated rather than diffed (Req 2-3 scope: no
    // separate per-row edit endpoint).
    const existingParts = await listExpectedPartsByListing(id);
    await Promise.all(existingParts.map((part) => deleteExpectedPart(part.id)));
    await Promise.all(expectedParts.map((part) => createExpectedPart({ listingId: id, ...part })));
    // Promote reference photos for any Expected Part with a confirmed brand (Req T2)
    await promoteReferencesForExpectedParts(id, updated.photoPaths, expectedParts);
    return toDetail(updated);
  });

  server.post('/api/listings/:id/accept', async (request, reply): Promise<AcceptListingResponse> => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/listings/:id/accept', id }, 'Accepting listing');
    const existing = await getListingById(id);
    if (!existing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    requireOpenListing(existing);
    // Req 4: the UPDATE inside transitionOpenListing is guarded on
    // `status = 'open'`, so if another request's accept/reject already won
    // the race between the requireOpenListing check above and this write,
    // this call returns false instead of flipping the row a second time —
    // see transitionOpenListing's doc comment for why that guard is the
    // actual fix (a prior read-then-write here let two parallel accepts
    // both succeed and both create a Purchase).
    const transitioned = await transitionOpenListing(id, 'accepted');
    if (!transitioned) {
      throw new AppError(`Listing ${id} was already accepted or rejected by a concurrent request`, 409);
    }
    const updated = await getListingById(id);
    if (!updated) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    // Req 4: the Purchase is pre-filled from the Listing's asking price.
    // Its Expected Parts aren't copied into a separate table — the
    // Purchase stays linked via listing_id, and the teardown workflow (T9)
    // reads the Expected Parts through that link.
    const purchase = await createPurchase({
      listingId: id,
      pricePaid: updated.askingPrice,
      purchaseDate: new Date().toISOString().slice(0, 10),
    });
    reply.status(201);
    return { listing: await toDetail(updated), purchaseId: purchase.id };
  });

  server.post('/api/listings/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/listings/:id/reject', id }, 'Rejecting listing');
    const existing = await getListingById(id);
    if (!existing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    requireOpenListing(existing);
    // Req 4: same CAS guard as accept above — a loser here gets a 409
    // conflict rather than silently re-applying reject over another
    // request's status change.
    const transitioned = await transitionOpenListing(id, 'rejected');
    if (!transitioned) {
      throw new AppError(`Listing ${id} was already accepted or rejected by a concurrent request`, 409);
    }
    const updated = await getListingById(id);
    if (!updated) {
      throw new AppError(`Listing ${id} not found`, 404);
    }
    return toDetail(updated);
  });

  await registerListingPhotoRoutes(server);
}
