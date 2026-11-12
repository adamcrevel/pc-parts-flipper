// Runs an automated marketplace scan for a Source (Req 3, 5, 7, 9): calls its
// connector's search(), imports every candidate not already seen as a
// Listing on this Source, and records scan-recency stats on the Source even
// when nothing new was found. T7 (route) and T8 (scheduler, neither in this
// batch) call scanSource/scanAllEligibleSources; scanSourceWithConnector
// takes the connector explicitly so tests can inject a fake one instead of
// hitting the real eBay API.
import { getConnectorForPlatform } from '../connectors/registry.js';
import type { CandidateListing, DescriptionFetcher, MarketplaceConnector, StatusChecker } from '../connectors/types.js';
import {
  countListings,
  createListing,
  findListingByExternalId,
  getSourceById,
  listListings,
  listSources,
  transitionListingMarketplaceStatus,
  updateListing,
  updateSourceScanStats,
} from '../db/index.js';
import type { Listing, ListingStatus, PlatformType, Source } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { downloadImagesToFiles } from '../photos/photoStorage.js';
import { isUniqueConstraintViolation } from './duplicateDetection.js';

/** Outcome of one scan pass: how many candidates the connector returned and how many became new Listings. */
export interface ScanResult {
  foundCount: number;
  newCount: number;
}

/**
 * Downloads a freshly-imported candidate's marketplace photos to local disk
 * and attaches whichever succeeded to the Listing. The Listing is inserted
 * with no photos and patched afterwards (rather than downloading first) so
 * the dedup insert — the step that can legitimately lose a race to a
 * concurrent scan — never pays for downloads it would then discard.
 *
 * Photos are a best-effort enrichment, never a precondition: every failure
 * here is logged and swallowed, because an imported Listing with missing
 * photos is strictly better than no Listing at all. Note these are plain
 * image-CDN downloads of URLs the search response already returned, not
 * eBay API calls — a scan still issues exactly one Browse API call per
 * configured query (Req 2).
 */
async function attachCandidatePhotos(listingId: string, candidate: CandidateListing): Promise<void> {
  if (candidate.imageUrls.length === 0) {
    return;
  }
  try {
    const photoPaths = await downloadImagesToFiles(candidate.imageUrls, listingId);
    if (photoPaths.length === 0) {
      logger.warn({ listingId, externalItemId: candidate.externalItemId }, 'No scan candidate photos could be downloaded');
      return;
    }
    await updateListing(listingId, { photoPaths });
    logger.debug({ listingId, photoCount: photoPaths.length }, 'Attached downloaded photos to imported Listing');
  } catch (err) {
    logger.warn({ listingId, externalItemId: candidate.externalItemId, err }, 'Failed to attach photos to imported Listing');
  }
}

/**
 * Fetches a freshly-imported candidate's description/item-specifics text
 * via `fetchDescription` and attaches it to its Listing (Req 1, 5). No-ops
 * immediately — without calling anything at all — when `fetchDescription`
 * is undefined, which is the case for every connector that does not
 * implement `createDescriptionFetcher` and for every test injecting a fake
 * connector, so neither gains a detail call.
 *
 * Mirrors attachCandidatePhotos's best-effort shape exactly: every failure
 * here is logged and swallowed rather than thrown, because a detail-fetch
 * failure must never fail the Listing's own import (Req 5).
 */
async function attachCandidateDescription(
  listingId: string,
  candidate: CandidateListing,
  fetchDescription: DescriptionFetcher | undefined,
): Promise<void> {
  if (fetchDescription === undefined) {
    return;
  }
  try {
    const description = await fetchDescription(candidate.externalItemId);
    if (description !== null) {
      await updateListing(listingId, { description });
      logger.debug({ listingId }, 'Attached marketplace description/specifics to imported Listing');
    }
  } catch (err) {
    logger.warn({ listingId, externalItemId: candidate.externalItemId, err }, 'Failed to attach description to imported Listing');
  }
}

/**
 * Imports one CandidateListing as a Listing on `source` unless it is already
 * present. Treats a unique-constraint violation on insert the same as an
 * already-seen duplicate — "skip, don't count as new" rather than a thrown
 * error — because it means a concurrent scan won the race to import this
 * exact brand-new item between this function's own existence check and its
 * insert; the existence check alone cannot close that window, only this
 * catch can (Req 3's dedup guarantee under concurrent scans).
 */
async function importCandidateIfNew(
  source: Source,
  connector: MarketplaceConnector,
  candidate: CandidateListing,
  fetchDescription: DescriptionFetcher | undefined,
): Promise<boolean> {
  const existing = await findListingByExternalId(source.id, candidate.externalItemId);
  if (existing) {
    return false;
  }
  try {
    const listing = await createListing({
      sourceId: source.id,
      title: candidate.title,
      description: null,
      listingUrl: candidate.listingUrl,
      askingPrice: candidate.askingPrice,
      listingDate: candidate.listingDate,
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: connector.platformType,
      externalItemId: candidate.externalItemId,
      nonWorking: candidate.nonWorking,
    });
    await attachCandidatePhotos(listing.id, candidate);
    await attachCandidateDescription(listing.id, candidate, fetchDescription);
    return true;
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      logger.warn(
        { sourceId: source.id, externalItemId: candidate.externalItemId },
        'Skipped scan candidate already imported by a concurrent scan',
      );
      return false;
    }
    throw err;
  }
}

/**
 * Fetches every Listing on `sourceId` currently in `status`, unpaginated:
 * `listListings`'s own default caps a page at 50 rows, so the count is read
 * first and passed straight back in as the limit — the same `limit: total`
 * idiom `routes/listings.ts`'s listFilteredSummaries already uses to turn
 * pagination off for a whole-table pass. The reconciliation below has to
 * see every row, not the newest page of them.
 */
async function listAllSourceListingsByStatus(sourceId: string, status: ListingStatus): Promise<Listing[]> {
  const total = await countListings({ sourceId, status });
  return listListings({ sourceId, status, limit: total });
}

/**
 * Picks out the Listings this pass's connector results no longer contain:
 * rows imported from this same platform (`externalSource`) that carry an
 * `externalItemId` at all, whose id is absent from `candidateItemIds`.
 * Returns the id pair rather than the whole Listing so the caller never has
 * to re-narrow `externalItemId` away from `string | null`.
 */
function missingExternalItems(
  listings: Listing[],
  platformType: PlatformType,
  candidateItemIds: Set<string>,
): Array<{ id: string; externalItemId: string }> {
  const missing: Array<{ id: string; externalItemId: string }> = [];
  for (const listing of listings) {
    const { externalItemId } = listing;
    if (externalItemId !== null && listing.externalSource === platformType && !candidateItemIds.has(externalItemId)) {
      missing.push({ id: listing.id, externalItemId });
    }
  }
  return missing;
}

/**
 * Runs one missing Listing's direct per-item recheck and acts on it (Req 3):
 * a `sold`/`removed` result atomically transitions the Listing `open` ->
 * `removed` with that result and the detection time recorded in the same
 * guarded write, while an `active` result writes nothing at all — that is
 * the false-positive guard, since absence from one page of search results is
 * never on its own evidence an item is gone.
 *
 * Best-effort per row, the same shape attachCandidatePhotos/
 * attachCandidateDescription already use: a recheck that throws (network
 * error, unexpected response) is logged and swallowed so one unreachable
 * item can never abort the rest of the scan pass.
 */
async function recheckMissingListing(
  listing: { id: string; externalItemId: string },
  checkStatus: StatusChecker,
): Promise<void> {
  try {
    const liveStatus = await checkStatus(listing.externalItemId);
    if (liveStatus === 'active') {
      logger.debug({ listingId: listing.id, externalItemId: listing.externalItemId }, 'Missing scan candidate is still live, leaving it open');
      return;
    }
    const transitioned = await transitionListingMarketplaceStatus(listing.id, 'open', 'removed', liveStatus, new Date().toISOString());
    logger.info(
      { listingId: listing.id, externalItemId: listing.externalItemId, marketplaceStatus: liveStatus, transitioned },
      'Recheck confirmed a scanned Listing is gone from the marketplace',
    );
  } catch (err) {
    logger.warn({ listingId: listing.id, externalItemId: listing.externalItemId, err }, 'Failed to recheck a missing Listing\'s marketplace status');
  }
}

/**
 * Req 3, 5: rechecks every still-`open` Listing on `source` whose
 * `externalItemId` did not appear among this pass's candidates, and marks
 * the confirmed-gone ones `removed`. A connector with no
 * `createStatusChecker` has no per-item recheck for its platform, so nothing
 * is checked and nothing is written — absence alone never infers removal,
 * and no branch on a platform name appears here. The checker is built at
 * most once per pass (and only once there is at least one row to check),
 * then reused for every missing row — the same build-once-per-pass contract
 * `createDescriptionFetcher` already has above. Already-`removed` Listings
 * are never re-checked (Req 5): only `open` rows are queried here.
 */
async function recheckMissingListings(
  source: Source,
  connector: MarketplaceConnector,
  candidateItemIds: Set<string>,
): Promise<void> {
  const openListings = await listAllSourceListingsByStatus(source.id, 'open');
  const missing = missingExternalItems(openListings, connector.platformType, candidateItemIds);
  if (missing.length === 0) {
    return;
  }
  const checkStatus = connector.createStatusChecker?.();
  if (checkStatus === undefined) {
    logger.debug({ sourceId: source.id, missingCount: missing.length }, 'Connector has no per-item status recheck, skipping missing-Listing reconciliation');
    return;
  }
  for (const listing of missing) {
    await recheckMissingListing(listing, checkStatus);
  }
}

/**
 * Req 4: transitions any `removed` Listing on `source` back to `open` once
 * its `externalItemId` turns up among this pass's candidates again, clearing
 * `marketplaceStatus`/`marketplaceStatusDetectedAt` in the same guarded
 * write. No status-checker call is made here — reappearing in the
 * connector's own results is itself the positive signal that the item is
 * live, so a recheck would only spend a network call to re-learn it.
 */
async function restoreReappearedListings(
  source: Source,
  connector: MarketplaceConnector,
  candidateItemIds: Set<string>,
): Promise<void> {
  const removedListings = await listAllSourceListingsByStatus(source.id, 'removed');
  for (const listing of removedListings) {
    const { externalItemId } = listing;
    if (externalItemId === null || listing.externalSource !== connector.platformType || !candidateItemIds.has(externalItemId)) {
      continue;
    }
    const transitioned = await transitionListingMarketplaceStatus(listing.id, 'removed', 'open', null, null);
    logger.info({ listingId: listing.id, externalItemId, transitioned }, 'Removed Listing reappeared in scan results, restored to open');
  }
}

/**
 * Runs one scan pass for `source` using `connector` (passed in explicitly so
 * callers/tests can inject a fake connector without touching the registry).
 * Refuses to scan an inactive Source or one with no connector configuration
 * (Req 7). Always records scan stats on the Source after processing every
 * candidate, even when zero are new (Req 5).
 *
 * Whatever per-item description fetch the connector offers is set up once
 * per scan pass, through its optional `createDescriptionFetcher` hook, and
 * reused for every newly-imported candidate in the pass. A connector that
 * does not implement the hook simply never gets a description fetch — no
 * branch on a platform name anywhere in this file.
 *
 * After importing, the pass reconciles the Source's already-imported
 * Listings against the same candidate set (Req 3, 4, 5): open Listings the
 * connector no longer returns are rechecked per item and marked `removed`
 * once confirmed gone, and `removed` Listings that reappeared are restored
 * to `open`.
 */
export async function scanSourceWithConnector(source: Source, connector: MarketplaceConnector): Promise<ScanResult> {
  if (!source.active) {
    throw new AppError(`Source ${source.id} is not active, cannot scan`, 400);
  }
  if (source.connectorConfig === null) {
    throw new AppError(`Source ${source.id} has no connector configuration, cannot scan`, 400);
  }
  // sourceValidation.ts already validated this JSON at write time; this
  // parse only decodes it back for the connector to consume, and leaves it
  // `unknown` deliberately: each connector's own search() validates and
  // narrows its platform's config shape, so this function never has to know
  // which platform it is scanning.
  const config = JSON.parse(source.connectorConfig) as unknown;
  logger.info({ sourceId: source.id, platformType: connector.platformType }, 'Starting scan');

  const fetchDescription = connector.createDescriptionFetcher?.();

  let candidates: CandidateListing[];
  try {
    candidates = await connector.search(config);
  } catch (err) {
    logger.error({ sourceId: source.id, err }, 'Connector search failed during scan');
    throw err;
  }

  let newCount = 0;
  for (const candidate of candidates) {
    try {
      if (await importCandidateIfNew(source, connector, candidate, fetchDescription)) {
        newCount += 1;
      }
    } catch (err) {
      logger.error({ sourceId: source.id, externalItemId: candidate.externalItemId, err }, 'Failed to import scan candidate');
      throw err;
    }
  }

  const candidateItemIds = new Set(candidates.map((candidate) => candidate.externalItemId));
  await recheckMissingListings(source, connector, candidateItemIds);
  await restoreReappearedListings(source, connector, candidateItemIds);

  const lastScannedAt = new Date().toISOString();
  await updateSourceScanStats(source.id, { lastScannedAt, lastScanFoundCount: newCount });
  logger.info({ sourceId: source.id, foundCount: candidates.length, newCount }, 'Scan completed');
  return { foundCount: candidates.length, newCount };
}

/**
 * Looks up `sourceId`, resolves its platform's real MarketplaceConnector via
 * the registry, and runs a scan. Thin wrapper over scanSourceWithConnector so
 * T7's route and T8's scheduler never resolve the connector themselves.
 */
export async function scanSource(sourceId: string): Promise<ScanResult> {
  const source = await getSourceById(sourceId);
  if (!source) {
    throw new AppError(`Source ${sourceId} not found`, 404);
  }
  const connector = getConnectorForPlatform(source.platformType);
  return scanSourceWithConnector(source, connector);
}

/** Per-Source result from scanAllEligibleSources: either the scan counts, or `error` when that Source's scan failed. */
export interface SourceScanOutcome {
  sourceId: string;
  foundCount?: number;
  newCount?: number;
  error?: string;
}

/** Summary scanAllEligibleSources returns: per-Source outcomes plus totals across every Source scanned successfully. */
export interface ScanAllResult {
  sources: SourceScanOutcome[];
  totalFound: number;
  totalNew: number;
}

/**
 * Scans every active Source that has a connector configured, one at a time.
 * Contract for T8's scheduler (not in this batch). A single Source's scan
 * failure is caught and logged here without aborting the remaining Sources'
 * scans (Req 9: one Source's failure never stops the others).
 */
export async function scanAllEligibleSources(): Promise<ScanAllResult> {
  const eligibleSources = (await listSources({ activeOnly: true })).filter((source) => source.connectorConfig !== null);
  logger.info({ eligibleCount: eligibleSources.length }, 'Starting scan of all eligible sources');

  const outcomes: SourceScanOutcome[] = [];
  let totalFound = 0;
  let totalNew = 0;
  for (const source of eligibleSources) {
    try {
      const result = await scanSource(source.id);
      outcomes.push({ sourceId: source.id, foundCount: result.foundCount, newCount: result.newCount });
      totalFound += result.foundCount;
      totalNew += result.newCount;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ sourceId: source.id, err }, "Scan failed for one Source; continuing with the rest");
      outcomes.push({ sourceId: source.id, error: message });
    }
  }
  logger.info({ totalFound, totalNew, scannedCount: outcomes.length }, 'Completed scan of all eligible sources');
  return { sources: outcomes, totalFound, totalNew };
}
