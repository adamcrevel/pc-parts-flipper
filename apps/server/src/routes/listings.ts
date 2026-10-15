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
import type {
  AcceptListingResponse,
  ExpectedPartInput,
  ListingColumnFilters,
  ListingComparison,
  ListingDetail,
  ListingSortDirection,
  ListingSortField,
  ListingSummary,
  ListListingIdsResponse,
  ListListingsResponse,
  PricingStatus,
} from '@pc-parts-flipper/shared';
import {
  countListings,
  createExpectedPart,
  createListing,
  createPurchase,
  deleteExpectedPart,
  getLatestJobForListing,
  getListingById,
  listExpectedPartsByListing,
  listListingIds,
  listListings,
  listSources,
  promoteReferencePhotos,
  transitionOpenListing,
  updateListing,
  type ExpectedPart,
  type Listing,
} from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { triggerPriceLookups } from '../jobs/pricePartsTrigger.js';
import { registerListingPhotoRoutes } from './listingPhotos.js';
import { parseListingColumnFilters, validateListingInput, type ListingColumnFilterQuery, type ListingRequestBody } from './listingValidation.js';

// Req 3: sum of Expected Parts' estimated resale values vs. (asking price +
// acquisition fees/shipping), plus their difference.
function computeComparison(listing: Listing, expectedParts: ExpectedPart[]): ListingComparison {
  const totalExpectedResaleValue = expectedParts.reduce((sum, part) => sum + (part.estimatedResaleValue ?? 0), 0);
  const totalCost = listing.askingPrice + listing.acquisitionFees;
  return { totalExpectedResaleValue, totalCost, difference: totalExpectedResaleValue - totalCost };
}

// Req 8, 11: derives the three-way PricingStatus from a Listing's fetched
// Expected Parts. Four cases fall out of counting priced vs. unpriced parts:
// zero parts at all -> 'not_priced' (nothing to flag as priced, Req 11);
// a non-empty set where every part is priced -> 'fully_priced'; a
// non-empty set where every part is unpriced (zero priced) -> 'not_priced',
// same as the zero-parts case; and a non-empty set with at least one of
// each -> 'partially_priced'. Implemented once here rather than duplicated
// between toSummary/toDetail (unlike the old simpler boolean computation,
// which WAS intentionally duplicated there) because this four-way branch
// is non-trivial enough that a single shared implementation is the right
// call — duplicating it would risk the two call sites drifting apart on
// a case as easy to get subtly wrong as "non-empty but zero priced".
function computePricingStatus(expectedParts: ExpectedPart[]): PricingStatus {
  if (expectedParts.length === 0) {
    return 'not_priced';
  }
  const pricedCount = expectedParts.filter((part) => part.estimatedResaleValue !== null).length;
  if (pricedCount === 0) {
    return 'not_priced';
  }
  return pricedCount === expectedParts.length ? 'fully_priced' : 'partially_priced';
}

// Attaches the Req 3 comparison to a Listing for the list response, without
// the full Expected Parts array (kept out of the lighter list payload; the
// single-listing response below includes it).
async function toSummary(listing: Listing): Promise<ListingSummary> {
  const [expectedParts, job] = await Promise.all([listExpectedPartsByListing(listing.id), getLatestJobForListing(listing.id)]);
  return {
    ...listing,
    comparison: computeComparison(listing, expectedParts),
    identifyPartsStatus: job ? { stage: job.stage, errorMessage: job.errorMessage } : null,
    // Req 8, 11: the shared four-way computePricingStatus helper handles
    // the Req 11 zero-parts case ('not_priced') the same way it handles a
    // non-empty set where every part is still unpriced — both fall out of
    // its own zero-priced-count branch rather than needing a separate
    // empty-array branch here.
    pricingStatus: computePricingStatus(expectedParts),
  };
}

/**
 * Per-column sort-key extractors, one per `ListingSortField` (Req 1, 6).
 * Each returns the value that column actually displays, never a raw stored
 * proxy for it: `source` resolves the Source's *name* through the id->name
 * table its caller passes (every other extractor ignores that argument),
 * `expectedResale`/`difference` read the computed `ListingComparison`
 * rather than any stored price, and `identifyParts` reads the latest job's
 * stage, treating a Listing with no job at all as an empty stage so those
 * rows group together at one end of the column instead of scattering.
 * Declared as a Record keyed by the shared union, so a column added to
 * `ListingSortField` later fails to compile until its extractor lands here.
 */
const SORT_KEYS: Record<ListingSortField, (listing: ListingSummary, sourceNamesById: Record<string, string>) => string | number> = {
  title: (listing) => listing.title,
  source: (listing, sourceNamesById) => sourceNamesById[listing.sourceId] ?? '',
  status: (listing) => listing.status,
  askingPrice: (listing) => listing.askingPrice,
  expectedResale: (listing) => listing.comparison.totalExpectedResaleValue,
  difference: (listing) => listing.comparison.difference,
  identifyParts: (listing) => listing.identifyPartsStatus?.stage ?? '',
  // Req 7, 10: an ordinal mapping, not the old binary one. The shared
  // comparator sorts ascending via `Number(keyA) - Number(keyB)`, so the
  // *smaller* key sorts first; mapping not_priced -> 0, partially_priced
  // -> 1, fully_priced -> 2 is what makes ascending "unpriced" sort read
  // Not Priced, then Partially Priced, then Fully Priced (Req 7), and a
  // descending sort (this same sort key, reversed after the comparator
  // runs — see sortSummaries) reverses that to Fully Priced,
  // then Partially Priced, then Not Priced.
  unpriced: (listing) => ({ not_priced: 0, partially_priced: 1, fully_priced: 2 })[listing.pricingStatus],
};

// The allow-list of accepted `sortBy` query values, derived from SORT_KEYS
// itself so the two can never drift apart.
const VALID_SORT_FIELDS = Object.keys(SORT_KEYS) as ListingSortField[];

/**
 * Per-column filter predicates, one per `ListingColumnFilters` key (Req
 * 2-7), each given the parsed value of its own key. Like SORT_KEYS, every
 * predicate reads the value the column actually displays: `sourceIds`
 * matches the stored Source id (Req 3 — two Sources sharing a name are
 * never conflated), `expectedResale*`/`difference*` read the computed
 * `ListingComparison`, and `identifyPartsStages` reads the latest job's
 * stage, with a Listing that has no job at all matching only the `'none'`
 * sentinel (Req 5). The six bounds are inclusive and independent — an
 * absent bound is simply not in the parsed object, so that side stays
 * unbounded (Req 7). Declared as a mapped type over the shared interface,
 * so a filter field added to `ListingColumnFilters` later fails to compile
 * until its predicate lands here.
 */
const COLUMN_FILTERS: { [K in keyof ListingColumnFilters]-?: (listing: ListingSummary, value: NonNullable<ListingColumnFilters[K]>) => boolean } = {
  title: (listing, title) => listing.title.toLowerCase().includes(title.toLowerCase()),
  sourceIds: (listing, sourceIds) => sourceIds.includes(listing.sourceId),
  statuses: (listing, statuses) => statuses.includes(listing.status),
  askingPriceMin: (listing, min) => listing.askingPrice >= min,
  askingPriceMax: (listing, max) => listing.askingPrice <= max,
  expectedResaleMin: (listing, min) => listing.comparison.totalExpectedResaleValue >= min,
  expectedResaleMax: (listing, max) => listing.comparison.totalExpectedResaleValue <= max,
  differenceMin: (listing, min) => listing.comparison.difference >= min,
  differenceMax: (listing, max) => listing.comparison.difference <= max,
  identifyPartsStages: (listing, stages) => stages.includes(listing.identifyPartsStatus?.stage ?? 'none'),
  pricingStatuses: (listing, pricingStatuses) => pricingStatuses.includes(listing.pricingStatus),
};

// True when the Listing passes every filter present in `filters` — the
// columns AND together (Req 11). parseListingColumnFilters only emits keys
// that are active, so iterating the object's own keys is exactly "every
// active filter".
function matchesColumnFilters(listing: ListingSummary, filters: ListingColumnFilters): boolean {
  return (Object.keys(filters) as (keyof ListingColumnFilters)[]).every((key) => {
    // The mapped type ties each predicate's value type to its own key, but
    // a lookup by a union-typed key loses that pairing; the cast restores
    // the call without weakening the table's declaration above.
    const predicate = COLUMN_FILTERS[key] as (listing: ListingSummary, value: unknown) => boolean;
    return predicate(listing, filters[key]);
  });
}

// Sorts `summaries` in place by one column (Req 1, 6), resolving Source
// names only when actually sorting by Source, so no other column pays for
// that query. `Array.prototype.sort` is stable (ES2019+), so rows tied on
// the sort field keep the relative order `listListings` already gave them
// (`listing_date DESC, id ASC`) with no secondary sort key needed; the
// `reverse()` for 'desc' flips those ties too, which keeps 'desc' the
// exact mirror image of 'asc'.
async function sortSummaries(summaries: ListingSummary[], sortBy: ListingSortField, sortDirection: ListingSortDirection): Promise<void> {
  const sourceNamesById: Record<string, string> = sortBy === 'source' ? Object.fromEntries((await listSources()).map((source) => [source.id, source.name])) : {};
  const sortKeyOf = SORT_KEYS[sortBy];
  summaries.sort((a, b) => {
    const keyA = sortKeyOf(a, sourceNamesById);
    const keyB = sortKeyOf(b, sourceNamesById);
    // Text columns compare by locale, so a column of names orders the way a
    // user reads it rather than by raw UTF-16 code unit; money/number
    // columns subtract, so -15 sorts below 5 instead of lexically after it.
    return typeof keyA === 'string' && typeof keyB === 'string' ? keyA.localeCompare(keyB) : Number(keyA) - Number(keyB);
  });
  if (sortDirection === 'desc') {
    summaries.reverse();
  }
}

/**
 * Builds the WHOLE filtered, optionally sorted Listings table in memory
 * (Req 2-7, 11) — the shared slow path behind both GET /api/listings (which
 * slices one page out of it) and GET /api/listings/ids (which keeps every
 * row). The table is server-paginated, so a correct "cheapest first" or a
 * correct "Expected Profit >= 50" has to be decided over every Listing
 * before a page is sliced out — sorting or filtering only the 20 rows a
 * page happens to hold would be a different, wrong answer. And most of
 * the filters cannot be a SQL WHERE at all: Expected Resale, Expected
 * Profit, Sourcing Status and Pricing Status are all computed by
 * `toSummary`, not stored columns, so every column filters the same way
 * rather than splitting into a SQL half and an in-memory half.
 *
 * Flow: count the table, fetch all of it in one unpaginated `listListings`
 * call (`limit: total` turns pagination off for this fetch), enrich every
 * row through the same unchanged `toSummary` the fast path uses — which
 * is what makes the computed comparison and the identify-parts stage
 * available as real filter and sort keys (Req 6) — drop every row that
 * fails a filter, then sort if a column was requested. Callers that only
 * want the SQL-level fast path (no filter, no sort) must not come here.
 */
async function listFilteredSummaries(filters: ListingColumnFilters, sortBy: ListingSortField | undefined, sortDirection: ListingSortDirection): Promise<ListingSummary[]> {
  const total = await countListings();
  const listings = await listListings({ limit: total, offset: 0 });
  const summaries = (await Promise.all(listings.map(toSummary))).filter((summary) => matchesColumnFilters(summary, filters));
  if (sortBy !== undefined) {
    await sortSummaries(summaries, sortBy, sortDirection);
  }
  return summaries;
}

// Attaches both the full Expected Parts set and the Req 3 comparison, for
// the single-listing response.
async function toDetail(listing: Listing): Promise<ListingDetail> {
  const [expectedParts, job] = await Promise.all([listExpectedPartsByListing(listing.id), getLatestJobForListing(listing.id)]);
  return {
    ...listing,
    expectedParts,
    comparison: computeComparison(listing, expectedParts),
    identifyPartsStatus: job ? { stage: job.stage, errorMessage: job.errorMessage } : null,
    // Req 8, 11: calls the same shared computePricingStatus helper as
    // toSummary above — see its doc comment for the four-way reasoning.
    // Unlike the old simpler boolean computation (which WAS intentionally
    // duplicated between the two functions), this logic is non-trivial
    // enough that a single shared implementation is the right call.
    pricingStatus: computePricingStatus(expectedParts),
  };
}

// Req 4: both accept and reject require the Listing to currently be open —
// a repeat accept/reject, or one against an already-decided Listing, is
// rejected with AppError(400) rather than silently re-applied.
function requireOpenListing(listing: Listing): void {
  if (listing.status !== 'open') {
    throw new AppError(`Listing ${listing.id} is not open (current status: ${listing.status})`, 400);
  }
}

/**
 * Promotes reference photos for any Expected Parts with confirmed brands.
 * Takes only the fields actually read below (not the full `ExpectedPartInput`
 * shape) so this also accepts already-persisted `ExpectedPart` rows (e.g.
 * listingPhotos.ts's post-upload promotion pass), whose `aiConfidence`/
 * `aiSource`/`priceSource` are optional on `ExpectedPart` and would otherwise
 * fail `ExpectedPartInput`'s stricter required-field shape.
 */
export async function promoteReferencesForExpectedParts(
  listingId: string,
  photoPaths: readonly string[],
  expectedParts: Pick<ExpectedPartInput, 'componentCategory' | 'brand' | 'partNumber'>[],
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
 * Creates every Expected Part of a validated create/update body on
 * `listingId`, deciding each row's `priceSource` on the way in, and returns
 * the rows as stored (which the price trigger then works from).
 *
 * `priceSource` is three-state (assumption A22, correcting A8): null is
 * *undecided*, `'auto'` means the background pipeline owns the row's price,
 * `'manual'` means the user does (he typed a value, or cleared one the
 * pipeline had filled in). Only an undecided row is ever claimed here, and
 * only when it is fully identified (brand *and* partNumber) with no price
 * of its own; an incoming `'auto'`/`'manual'` is stored verbatim. That is
 * what makes Req 14/15 hold across a resave: on the old two-value field a
 * cleared auto-priced row was indistinguishable from an undecided one, so
 * it got re-claimed and then re-filled from the cache in the same request.
 */
async function createExpectedPartsForListing(
  listingId: string,
  expectedParts: ExpectedPartInput[],
): Promise<ExpectedPart[]> {
  return Promise.all(
    expectedParts.map((part) => {
      // Determine priceSource based on completeness and current state.
      const priceSource =
        (part.priceSource ?? null) === null &&
        part.brand !== null &&
        part.partNumber !== null &&
        part.estimatedResaleValue === null
          ? 'auto'
          : part.priceSource ?? null;

      // Determine working status, defaulting to 'working' if not provided.
      const workingStatus = part.workingStatus ?? 'working';

      // Apply the $1 override for non-working parts with auto pricing.
      const estimatedResaleValue =
        priceSource === 'auto' && workingStatus === 'non_working'
          ? 1
          : part.estimatedResaleValue;

      return createExpectedPart({
        listingId,
        ...part,
        priceSource,
        workingStatus,
        estimatedResaleValue,
      });
    }),
  );
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
    const createdParts = await createExpectedPartsForListing(created.id, expectedParts);
    // Promote reference photos for any Expected Part with a confirmed brand (Req T2)
    await promoteReferencesForExpectedParts(created.id, created.photoPaths, expectedParts);
    // Decide, per part, between an already-cached price and a queued
    // research job (Req 5-7). Awaited like the promotion above: the work
    // here is only the cache lookup and the enqueue — the AI research
    // itself happens later, in the price worker pool, never in this request.
    await triggerPriceLookups(createdParts);
    reply.status(201);
    return toDetail(created);
  });

  server.get('/api/listings', async (request): Promise<ListListingsResponse> => {
    const { limit, offset, sortBy, sortDirection, ...filterQuery } = request.query as ListingColumnFilterQuery & {
      limit?: string;
      offset?: string;
      sortBy?: string;
      sortDirection?: string;
    };
    // The eight column filters (Req 2-7), validated loosely — an
    // unrecognized value applies no filter rather than being rejected,
    // since GET requests validate loosely, unlike the write path. The old
    // single-value `status`/`sourceId` params are gone (Req 12); if a
    // caller still sends them they are simply not read.
    const filters = parseListingColumnFilters(filterQuery);
    // Pagination (Req 15): limit/offset query params, defaulting to a
    // single page of 20 so the Listings queue screen never renders an
    // unbounded list. `total` lets the frontend compute page count without
    // a second unpaginated fetch.
    const limitValue = limit !== undefined ? Number(limit) : 20;
    const offsetValue = offset !== undefined ? Number(offset) : 0;
    // Req 1: the click-to-sort column params, validated as loosely as the
    // filters above — an unrecognized `sortBy` applies no sort at all, and
    // any `sortDirection` other than 'desc' means ascending, the direction
    // a freshly-clicked column starts in (Req 2).
    const sortField = typeof sortBy === 'string' && VALID_SORT_FIELDS.includes(sortBy as ListingSortField) ? (sortBy as ListingSortField) : undefined;
    const sortDirectionValue: ListingSortDirection = sortDirection === 'desc' ? 'desc' : 'asc';
    logger.info(
      { route: 'GET /api/listings', filters, limit: limitValue, offset: offsetValue, sortBy: sortField, sortDirection: sortField !== undefined ? sortDirectionValue : undefined },
      'Listing listings',
    );
    if (sortField !== undefined || Object.keys(filters).length > 0) {
      // Sorting (Req 1) and filtering (Req 11) both have to see the whole
      // table before a page is sliced out, and `total` reports the whole
      // filtered count so the pagination controls stay accurate.
      const summaries = await listFilteredSummaries(filters, sortField, sortDirectionValue);
      return { listings: summaries.slice(offsetValue, offsetValue + limitValue), total: summaries.length };
    }
    // Req 9: with neither a sort nor a filter requested this stays exactly
    // the original path — SQL-level LIMIT/OFFSET over listListings'
    // default listing_date DESC ordering, never materializing the table.
    const [listings, total] = await Promise.all([listListings({ limit: limitValue, offset: offsetValue }), countListings()]);
    return { listings: await Promise.all(listings.map(toSummary)), total };
  });

  // Static route, registered ahead of the /api/listings/:id parametric
  // route below — find-my-way (Fastify's router) matches static segments
  // before parametric ones regardless of registration order, but this
  // ordering keeps the file's own route list matching match-priority order.
  server.get('/api/listings/ids', async (request): Promise<ListListingIdsResponse> => {
    // Same loose filter parsing as GET /api/listings above, so "select all
    // matching across every page" sees exactly the rows the table shows
    // (Req 11) — never sorted or paginated, since only the id set matters.
    const filters = parseListingColumnFilters(request.query as ListingColumnFilterQuery);
    logger.info({ route: 'GET /api/listings/ids', filters }, 'Listing listing ids');
    if (Object.keys(filters).length > 0) {
      return { ids: (await listFilteredSummaries(filters, undefined, 'asc')).map((summary) => summary.id) };
    }
    return { ids: await listListingIds() };
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
    const createdParts = await createExpectedPartsForListing(id, expectedParts);
    // Promote reference photos for any Expected Part with a confirmed brand (Req T2)
    await promoteReferencesForExpectedParts(id, updated.photoPaths, expectedParts);
    // Same cache-hit/miss decision as the create path above (Req 5-7).
    await triggerPriceLookups(createdParts);
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
