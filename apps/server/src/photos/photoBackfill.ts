// One-time photo backfill for eBay Listings imported before scans started
// downloading marketplace images (Req 2). Scans only ever capture photos for
// items they import going forward, so already-imported rows need their images
// fetched from eBay's single-item detail endpoint — the only lookup that can
// be targeted at a specific known item id — and downloaded through the same
// shared storage helper the scan path uses.
//
// The work itself lives here, not in the CLI entry point
// (src/scripts/backfill-photos.ts), so it can be tested with injected
// fetch/download seams instead of by running a script end to end.
import type { EbayItemDetailClient } from '../connectors/ebayConnector.js';
import { createEbayItemDetailClient } from '../connectors/ebayConnector.js';
import { listListingsMissingPhotos, updateListing } from '../db/index.js';
import type { Listing } from '../db/index.js';
import { logger } from '../logger.js';
import { downloadImagesToFiles } from './photoStorage.js';

/** Tallies of one backfill run, one Listing counted in exactly one bucket. */
export interface BackfillSummary {
  /** Listings that ended the run with at least one photo stored. */
  succeeded: number;
  /** Listings eBay returned no images for — nothing to store, nothing wrong. */
  skipped: number;
  /** Listings whose detail lookup, download, or update failed outright. */
  failed: number;
}

/**
 * The outside-world operations backfillListingPhotos depends on, grouped so
 * tests can substitute in-memory fakes for both the eBay call and the image
 * download without stubbing globals.
 */
export interface BackfillDeps {
  /** Resolves the full-resolution photo URLs eBay holds for one item id. */
  fetchItemImageUrls(externalItemId: string): Promise<string[]>;
  /** Downloads those URLs, returning the relative paths that stored successfully. */
  downloadImages(imageUrls: string[], listingId: string): Promise<string[]>;
  /** Persists the stored paths onto the Listing. */
  savePhotoPaths(listingId: string, photoPaths: string[]): Promise<void>;
}

/** Which bucket of BackfillSummary one processed Listing fell into. */
export type BackfillOutcome = 'succeeded' | 'skipped' | 'failed';

/**
 * Backfills photos for exactly one Listing and reports which bucket it fell
 * into. Never throws: a single item's failure — eBay 404 for a listing since
 * removed, a download error, a database error — is logged and reported as
 * 'failed' so the caller's loop continues through the rest of the batch
 * rather than losing every remaining Listing to one bad row.
 */
export async function backfillOneListing(listing: Listing, deps: BackfillDeps): Promise<BackfillOutcome> {
  // listListingsMissingPhotos only returns rows with an external item id, but
  // backfillOneListing is exported and must not hand `null` to eBay if some
  // other caller passes a manually-entered Listing.
  if (listing.externalItemId === null) {
    logger.warn({ listingId: listing.id }, 'Backfill skipped Listing: no external item id to look up');
    return 'skipped';
  }

  try {
    const imageUrls = await deps.fetchItemImageUrls(listing.externalItemId);
    if (imageUrls.length === 0) {
      logger.warn({ listingId: listing.id, externalItemId: listing.externalItemId }, 'Backfill skipped Listing: eBay returned no images');
      return 'skipped';
    }

    const photoPaths = await deps.downloadImages(imageUrls, listing.id);
    if (photoPaths.length === 0) {
      logger.warn(
        { listingId: listing.id, externalItemId: listing.externalItemId, imageCount: imageUrls.length },
        'Backfill failed for Listing: every image download failed',
      );
      return 'failed';
    }

    await deps.savePhotoPaths(listing.id, photoPaths);
    logger.debug({ listingId: listing.id, photoCount: photoPaths.length }, 'Backfilled photos onto Listing');
    return 'succeeded';
  } catch (err) {
    logger.error({ listingId: listing.id, externalItemId: listing.externalItemId, err }, 'Backfill failed for Listing');
    return 'failed';
  }
}

/**
 * Runs the backfill across `listings` sequentially, logging per-Listing
 * progress at Info and returning the run's tallies. Sequential rather than
 * parallel so the run stays a polite client of both eBay's API and its image
 * CDN, and so the progress log reads in order.
 */
export async function backfillListingPhotos(listings: Listing[], deps: BackfillDeps): Promise<BackfillSummary> {
  const summary: BackfillSummary = { succeeded: 0, skipped: 0, failed: 0 };

  for (const [index, listing] of listings.entries()) {
    logger.info(
      { listingId: listing.id, externalItemId: listing.externalItemId },
      `Backfilling photos: ${index + 1}/${listings.length}`,
    );
    summary[await backfillOneListing(listing, deps)] += 1;
  }

  return summary;
}

/**
 * Entry point for the real run: finds every eBay Listing still missing
 * photos, wires the real eBay detail client and the real downloader, and
 * backfills them. Returns the run summary; the CLI wrapper only reports it.
 */
export async function runPhotoBackfill(): Promise<BackfillSummary> {
  const listings = await listListingsMissingPhotos('ebay');
  logger.info({ listingCount: listings.length }, 'Starting eBay photo backfill');

  if (listings.length === 0) {
    return { succeeded: 0, skipped: 0, failed: 0 };
  }

  // Built only when there is actual work: creating the client costs an eBay
  // OAuth call, which a no-op run should not make.
  const client: EbayItemDetailClient = await createEbayItemDetailClient();
  const summary = await backfillListingPhotos(listings, {
    fetchItemImageUrls: (externalItemId) => client.fetchItemImageUrls(externalItemId),
    downloadImages: downloadImagesToFiles,
    savePhotoPaths: async (listingId, photoPaths) => {
      await updateListing(listingId, { photoPaths });
    },
  });

  logger.info({ ...summary, listingCount: listings.length }, 'Finished eBay photo backfill');
  return summary;
}
