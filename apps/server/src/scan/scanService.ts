// Runs an automated marketplace scan for a Source (Req 3, 5, 7, 9): calls its
// connector's search(), imports every candidate not already seen as a
// Listing on this Source, and records scan-recency stats on the Source even
// when nothing new was found. T7 (route) and T8 (scheduler, neither in this
// batch) call scanSource/scanAllEligibleSources; scanSourceWithConnector
// takes the connector explicitly so tests can inject a fake one instead of
// hitting the real eBay API.
import type { EbayConnectorConfig } from '@pc-parts-flipper/shared';
import type { EbayItemDetailClient } from '../connectors/ebayConnector.js';
import { createEbayItemDetailClient } from '../connectors/ebayConnector.js';
import { getConnectorForPlatform } from '../connectors/registry.js';
import type { CandidateListing, MarketplaceConnector } from '../connectors/types.js';
import { createListing, findListingByExternalId, getSourceById, listSources, updateListing, updateSourceScanStats } from '../db/index.js';
import type { Source } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { downloadImagesToFiles } from '../photos/photoStorage.js';
import { isUniqueConstraintViolation } from './duplicateDetection.js';

/**
 * Outside-world dependencies scanSourceWithConnector can be handed beyond
 * its connector, so tests never gain a new network call just by exercising
 * the scan path. Only one member today: `fetchEbayItemDescription`, which
 * is never called unless the Source's connector is eBay's
 * (`connector.platformType === 'ebay'`) and never called for a candidate
 * that turns out to already be an existing Listing — a duplicate makes no
 * detail call at all, not even a wasted one. Every existing test here
 * injects a fake MarketplaceConnector and leaves this field `undefined`, so
 * none of them gain a new network call either.
 */
export interface ScanServiceDeps {
  fetchEbayItemDescription?: (externalItemId: string) => Promise<string | null>;
}

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
 * Fetches an eBay item's description/item-specifics text via
 * `fetchEbayItemDescription` and attaches it to a freshly-imported
 * candidate's Listing (Req 1, 5). No-ops immediately — without calling
 * `fetchEbayItemDescription` at all — when `connector.platformType` is not
 * `'ebay'` or `fetchEbayItemDescription` is undefined, so a non-eBay
 * connector or a test injecting no deps never triggers a detail call.
 *
 * Mirrors attachCandidatePhotos's best-effort shape exactly: every failure
 * here is logged and swallowed rather than thrown, because a detail-fetch
 * failure must never fail the Listing's own import (Req 5).
 */
async function attachCandidateDescription(
  listingId: string,
  candidate: CandidateListing,
  connector: MarketplaceConnector,
  fetchEbayItemDescription: ScanServiceDeps['fetchEbayItemDescription'],
): Promise<void> {
  if (connector.platformType !== 'ebay' || fetchEbayItemDescription === undefined) {
    return;
  }
  try {
    const description = await fetchEbayItemDescription(candidate.externalItemId);
    if (description !== null) {
      await updateListing(listingId, { description });
      logger.debug({ listingId }, 'Attached eBay description/specifics to imported Listing');
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
  fetchEbayItemDescription: ScanServiceDeps['fetchEbayItemDescription'],
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
    await attachCandidateDescription(listing.id, candidate, connector, fetchEbayItemDescription);
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
 * Runs one scan pass for `source` using `connector` (passed in explicitly so
 * callers/tests can inject a fake connector without touching the registry).
 * Refuses to scan an inactive Source or one with no connector configuration
 * (Req 7). Always records scan stats on the Source after processing every
 * candidate, even when zero are new (Req 5).
 *
 * `deps` is optional, omitted entirely by every existing test here, which
 * calls this with just the two required arguments — leaving
 * `fetchEbayItemDescription` `undefined` and gaining no new network call.
 */
export async function scanSourceWithConnector(
  source: Source,
  connector: MarketplaceConnector,
  deps?: ScanServiceDeps,
): Promise<ScanResult> {
  if (!source.active) {
    throw new AppError(`Source ${source.id} is not active, cannot scan`, 400);
  }
  if (source.connectorConfig === null) {
    throw new AppError(`Source ${source.id} has no connector configuration, cannot scan`, 400);
  }
  // T3's sourceValidation.ts already validated this JSON at write time; this
  // parse only decodes it back for the connector to consume.
  const config = JSON.parse(source.connectorConfig) as EbayConnectorConfig;
  logger.info({ sourceId: source.id, queryCount: config.queries.length }, 'Starting scan');

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
      if (await importCandidateIfNew(source, connector, candidate, deps?.fetchEbayItemDescription)) {
        newCount += 1;
      }
    } catch (err) {
      logger.error({ sourceId: source.id, externalItemId: candidate.externalItemId, err }, 'Failed to import scan candidate');
      throw err;
    }
  }

  const lastScannedAt = new Date().toISOString();
  await updateSourceScanStats(source.id, { lastScannedAt, lastScanFoundCount: newCount });
  logger.info({ sourceId: source.id, foundCount: candidates.length, newCount }, 'Scan completed');
  return { foundCount: candidates.length, newCount };
}

/**
 * Builds a lazily-initialized `fetchEbayItemDescription` for scanSource's
 * real-connector deps. `createEbayItemDetailClient()` performs its own
 * OAuth app-token call, so it must not run on a scan that imports zero new
 * candidates; this helper defers that call to the returned function's own
 * first invocation, memoizes the in-flight/resolved client promise, and
 * reuses it for every later candidate in the same scan — one shared OAuth
 * token per scan rather than one per candidate.
 */
function createLazyEbayDescriptionFetcher(): (externalItemId: string) => Promise<string | null> {
  let clientPromise: Promise<EbayItemDetailClient> | undefined;
  return async (externalItemId: string): Promise<string | null> => {
    if (clientPromise === undefined) {
      clientPromise = createEbayItemDetailClient();
    }
    const client = await clientPromise;
    return client.fetchItemDescription(externalItemId);
  };
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
  const deps: ScanServiceDeps =
    connector.platformType === 'ebay' ? { fetchEbayItemDescription: createLazyEbayDescriptionFetcher() } : {};
  return scanSourceWithConnector(source, connector, deps);
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
