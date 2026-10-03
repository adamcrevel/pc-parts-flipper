// Runs an automated marketplace scan for a Source (Req 3, 5, 7, 9): calls its
// connector's search(), imports every candidate not already seen as a
// Listing on this Source, and records scan-recency stats on the Source even
// when nothing new was found. T7 (route) and T8 (scheduler, neither in this
// batch) call scanSource/scanAllEligibleSources; scanSourceWithConnector
// takes the connector explicitly so tests can inject a fake one instead of
// hitting the real eBay API.
import type { EbayConnectorConfig } from '@pc-parts-flipper/shared';
import { getConnectorForPlatform } from '../connectors/registry.js';
import type { CandidateListing, MarketplaceConnector } from '../connectors/types.js';
import { createListing, findListingByExternalId, getSourceById, listSources, updateSourceScanStats } from '../db/index.js';
import type { Source } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
import { isUniqueConstraintViolation } from './duplicateDetection.js';

/** Outcome of one scan pass: how many candidates the connector returned and how many became new Listings. */
export interface ScanResult {
  foundCount: number;
  newCount: number;
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
): Promise<boolean> {
  const existing = await findListingByExternalId(source.id, candidate.externalItemId);
  if (existing) {
    return false;
  }
  try {
    await createListing({
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
    });
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
 */
export async function scanSourceWithConnector(source: Source, connector: MarketplaceConnector): Promise<ScanResult> {
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
      if (await importCandidateIfNew(source, connector, candidate)) {
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
