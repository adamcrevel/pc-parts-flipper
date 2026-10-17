// Runs an automated marketplace scan for a Source (Req 3, 5, 7, 9): calls its
// connector's search(), imports every candidate not already seen as a
// Listing on this Source, and records scan-recency stats on the Source even
// when nothing new was found. T7 (route) and T8 (scheduler, neither in this
// batch) call scanSource/scanAllEligibleSources; scanSourceWithConnector
// takes the connector explicitly so tests can inject a fake one instead of
// hitting the real eBay API.
import { getConnectorForPlatform } from '../connectors/registry.js';
import type { CandidateListing, DescriptionFetcher, MarketplaceConnector } from '../connectors/types.js';
import { createListing, findListingByExternalId, getSourceById, listSources, updateListing, updateSourceScanStats } from '../db/index.js';
import type { Source } from '../db/index.js';
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
