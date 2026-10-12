// One-time description backfill for eBay Listings imported before scans
// started capturing eBay's description and item specifics (Req 4, 5). Scans
// only ever capture description text for items they import going forward, so
// already-imported rows need their text fetched from eBay's single-item
// detail endpoint — the only lookup that can be targeted at a specific known
// item id.
//
// The work itself lives here, not in the CLI entry point
// (src/scripts/backfill-descriptions.ts), so it can be tested with injected
// fetch/save seams instead of by running a script end to end.
import type { EbayItemDetailClient } from '../connectors/ebayConnector.js';
import { createEbayItemDetailClient } from '../connectors/ebayConnector.js';
import { listListingsMissingDescription, updateListing } from '../db/index.js';
import type { Listing } from '../db/index.js';
import { logger } from '../logger.js';

/** Tallies of one backfill run, one Listing counted in exactly one bucket. */
export interface BackfillSummary {
  /** Listings that ended the run with a description stored. */
  succeeded: number;
  /** Listings eBay returned no description/specifics for — nothing to store, nothing wrong. */
  skipped: number;
  /** Listings whose detail lookup or update failed outright. */
  failed: number;
}

/**
 * The outside-world operations backfillListingDescriptions depends on,
 * grouped so tests can substitute in-memory fakes for both the eBay call
 * and the database write without stubbing globals.
 */
export interface BackfillDeps {
  /** Resolves the formatted description/specifics text eBay holds for one item id. */
  fetchItemDescription(externalItemId: string): Promise<string | null>;
  /** Persists the fetched description onto the Listing. */
  saveDescription(listingId: string, description: string): Promise<void>;
}

/** Which bucket of BackfillSummary one processed Listing fell into. */
export type BackfillOutcome = 'succeeded' | 'skipped' | 'failed';

/**
 * Backfills the description for exactly one Listing and reports which
 * bucket it fell into. Never throws: a single item's failure — eBay 404 for
 * a listing since removed, a database error — is logged and reported as
 * 'failed' so the caller's loop continues through the rest of the batch
 * rather than losing every remaining Listing to one bad row.
 */
export async function backfillOneListing(listing: Listing, deps: BackfillDeps): Promise<BackfillOutcome> {
  // listListingsMissingDescription only returns rows with an external item
  // id, but backfillOneListing is exported and must not hand `null` to eBay
  // if some other caller passes a manually-entered Listing.
  if (listing.externalItemId === null) {
    logger.warn({ listingId: listing.id }, 'Backfill skipped Listing: no external item id to look up');
    return 'skipped';
  }

  try {
    const description = await deps.fetchItemDescription(listing.externalItemId);
    if (description === null) {
      logger.warn(
        { listingId: listing.id, externalItemId: listing.externalItemId },
        'Backfill skipped Listing: eBay returned no description or specifics',
      );
      return 'skipped';
    }

    await deps.saveDescription(listing.id, description);
    logger.debug({ listingId: listing.id }, 'Backfilled description onto Listing');
    return 'succeeded';
  } catch (err) {
    logger.error({ listingId: listing.id, externalItemId: listing.externalItemId, err }, 'Backfill failed for Listing');
    return 'failed';
  }
}

/**
 * Runs the backfill across `listings` sequentially, logging per-Listing
 * progress at Info and returning the run's tallies. Sequential rather than
 * parallel so the run stays a polite client of eBay's API and so the
 * progress log reads in order.
 */
export async function backfillListingDescriptions(listings: Listing[], deps: BackfillDeps): Promise<BackfillSummary> {
  const summary: BackfillSummary = { succeeded: 0, skipped: 0, failed: 0 };

  for (const [index, listing] of listings.entries()) {
    logger.info(
      { listingId: listing.id, externalItemId: listing.externalItemId },
      `Backfilling descriptions: ${index + 1}/${listings.length}`,
    );
    summary[await backfillOneListing(listing, deps)] += 1;
  }

  return summary;
}

/**
 * Entry point for the real run: finds every eBay Listing still missing a
 * description, wires the real eBay detail client, and backfills them.
 * Returns the run summary; the CLI wrapper only reports it.
 */
export async function runDescriptionBackfill(): Promise<BackfillSummary> {
  const listings = await listListingsMissingDescription('ebay');
  logger.info({ listingCount: listings.length }, 'Starting eBay description backfill');

  if (listings.length === 0) {
    return { succeeded: 0, skipped: 0, failed: 0 };
  }

  // Built only when there is actual work: creating the client costs an eBay
  // OAuth call, which a no-op run should not make.
  const client: EbayItemDetailClient = await createEbayItemDetailClient();
  const summary = await backfillListingDescriptions(listings, {
    fetchItemDescription: (externalItemId) => client.fetchItemDescription(externalItemId),
    saveDescription: async (listingId, description) => {
      await updateListing(listingId, { description });
    },
  });

  logger.info({ ...summary, listingCount: listings.length }, 'Finished eBay description backfill');
  return summary;
}
