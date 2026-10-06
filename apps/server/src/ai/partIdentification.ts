// Orchestrates AI part identification for a Listing in two passes:
// (1) First pass: resolve photos to absolute paths, build a prompt, run the
//     model, and parse the answer.
// (2) Second pass (visual comparison): for parts not fully settled (missing
//     brand, missing partNumber, or carrying identityCandidates), look up
//     reference photos and run a visual-comparison prompt to refine the
//     initial identification. Same omp runner, same logging conventions.
//
// The three core steps live in sibling modules (identificationPrompt.ts,
// ompRunner.ts, identificationParser.ts, visualComparisonPrompt.ts,
// visualComparisonParser.ts) so each stays small; this file sequences them.
//
// On-demand only. Two passes together take ~15–45s depending on reference
// photo availability, so this is never run automatically during a scan.
import path from 'node:path';
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import type { Listing, ReferencePhoto } from '../db/index.js';
import { findReferencePhotosForLeads } from '../db/index.js';
import { logger } from '../logger.js';
import { DATA_DIR, PHOTOS_DIR } from '../photos/photoStorage.js';
import { buildIdentificationPrompt } from './identificationPrompt.js';
import { parseIdentificationResponse } from './identificationParser.js';
import { buildVisualComparisonPrompt } from './visualComparisonPrompt.js';
import { parseVisualComparisonResponse } from './visualComparisonParser.js';
import { getOmpRunner, type OmpRunOptions } from './ompRunner.js';

/** Maximum reference photos to fetch per eligible part. */
export const MAX_REFERENCE_PHOTOS_PER_PART = 3;

/** Maximum total reference photos across all eligible parts in one second pass. */
export const MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL = 12;

/**
 * Resolves a Listing's stored photo paths to absolute paths the CLI can
 * attach. Stored entries are always relative and shaped `photos/<filename>`;
 * path.basename strips that leading segment, and PHOTOS_DIR (which already
 * honors the DUCKDB_DATA_DIR override) supplies the directory — so a test
 * running against a redirected data directory resolves to its own photos, not
 * the shared development ones.
 */
export function resolvePhotoPaths(photoPaths: readonly string[]): string[] {
  return photoPaths.map((photoPath) => path.join(PHOTOS_DIR, path.basename(photoPath)));
}

/**
 * Applies per-part and total reference photo caps, using round-robin trimming
 * when the combined total exceeds the limit. Trims references grouped by part
 * index in-place until the total is at most maxTotal, cycling through each
 * part in turn and skipping any whose list is already exhausted.
 */
function trimReferencePhotosRoundRobin(
  referencesByPart: Map<number, ReferencePhoto[]>,
  maxTotal: number,
): void {
  let totalCount = Array.from(referencesByPart.values()).reduce((sum, refs) => sum + refs.length, 0);

  if (totalCount <= maxTotal) {
    return;
  }

  const partIndices = Array.from(referencesByPart.keys()).sort((a, b) => a - b);
  let currentIndex = 0;

  while (totalCount > maxTotal && partIndices.length > 0) {
    // Skip parts whose lists are already empty
    let skipped = 0;
    while (skipped < partIndices.length) {
      const partIndex = partIndices[currentIndex];
      const refs = referencesByPart.get(partIndex)!;
      if (refs.length > 0) {
        refs.pop();
        totalCount -= 1;
        break;
      }
      currentIndex = (currentIndex + 1) % partIndices.length;
      skipped += 1;
    }

    // If all parts are exhausted, stop
    if (skipped === partIndices.length) {
      break;
    }

    currentIndex = (currentIndex + 1) % partIndices.length;
  }
}

/**
 * Identifies the components likely contained in `listing`, from its title,
 * description and photos, using a two-pass approach:
 * (1) First pass identifies parts from listing content.
 * (2) Second pass (visual comparison) refines unsettled parts using reference
 *     photos, if any are available.
 *
 * Resolves to the parsed, validated model response (with optional refinements
 * from the second pass); rejects with an AppError carrying a real message (CLI
 * missing, not logged in, timed out, unparseable output) — never with a silent
 * empty result standing in for a failure.
 *
 * `options` exists for the test suite (short timeout, fake spawn) and is
 * passed straight through to the runner; production callers omit it.
 */
export async function identifyListingParts(listing: Listing, options?: OmpRunOptions): Promise<IdentifyPartsResponse> {
  const imagePaths = resolvePhotoPaths(listing.photoPaths);
  logger.info({ listingId: listing.id, photoCount: imagePaths.length }, 'Starting AI part identification');

  const prompt = buildIdentificationPrompt(listing);

  try {
    const rawStdout = await getOmpRunner()(prompt, imagePaths, options);
    const response = parseIdentificationResponse(rawStdout);
    logger.info({ listingId: listing.id, partCount: response.parts.length }, 'AI part identification complete');

    // Determine which parts are eligible for visual comparison: not fully settled
    // (brand is null, OR partNumber is null, OR identityCandidates is non-empty).
    const eligibleIndices: number[] = [];
    for (let i = 0; i < response.parts.length; i += 1) {
      const part = response.parts[i];
      if (part.brand === null || part.partNumber === null || part.identityCandidates.length > 0) {
        eligibleIndices.push(i);
      }
    }

    // If no eligible parts, return first pass result unchanged.
    if (eligibleIndices.length === 0) {
      return response;
    }

    // Look up reference photos for each eligible part.
    const referencesByPart = new Map<number, ReferencePhoto[]>();
    for (const partIndex of eligibleIndices) {
      const part = response.parts[partIndex];
      const leads = [
        { brand: part.brand, partNumber: part.partNumber },
        ...part.identityCandidates,
      ];
      const references = await findReferencePhotosForLeads(
        part.category,
        leads,
        MAX_REFERENCE_PHOTOS_PER_PART,
      );
      if (references.length > 0) {
        referencesByPart.set(partIndex, references);
      }
    }

    // If no references found for any eligible part, return first pass result unchanged.
    if (referencesByPart.size === 0) {
      logger.info(
        { listingId: listing.id },
        'No reference photos available for eligible parts; skipping visual comparison',
      );
      return response;
    }

    // Apply round-robin trimming to respect total cap.
    trimReferencePhotosRoundRobin(referencesByPart, MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL);

    // Build eligible parts array (only those with references after trimming).
    const eligibleParts = Array.from(referencesByPart.entries())
      .filter(([, refs]) => refs.length > 0)
      .map(([partIndex, references]) => ({
        partIndex,
        category: response.parts[partIndex].category,
        description: response.parts[partIndex].description,
        references,
      }));

    // Run second pass with the comparison prompt and combined image list.
    // Reference photos are NOT resolved via resolvePhotoPaths: that helper
    // strips to basename and re-homes under PHOTOS_DIR, which is correct
    // only for a listing's own flat-layout photos. A reference photo's
    // photoPath is already a full path relative to DATA_DIR by construction
    // (covering both the photos/<file> and reference-photos/seed/<file>
    // conventions), so it is joined against DATA_DIR directly instead.
    const referencePhotoPaths = Array.from(referencesByPart.values())
      .flat()
      .map((ref) => path.join(DATA_DIR, ref.photoPath));

    const combinedImagePaths = [...imagePaths, ...referencePhotoPaths];
    const comparisonPrompt = buildVisualComparisonPrompt(listing, eligibleParts);

    logger.info(
      { listingId: listing.id, eligibleCount: eligibleParts.length },
      'Starting AI visual comparison pass',
    );

    const comparisonRawStdout = await getOmpRunner()(comparisonPrompt, combinedImagePaths, options);
    const comparisonUpdates = parseVisualComparisonResponse(comparisonRawStdout);

    // Filter comparison updates to only include entries whose partIndex was
    // actually sent to the model in this prompt — the post-trim eligibleParts
    // set, not referencesByPart (which can still hold a key with an
    // empty array after round-robin trimming zeroes a part out, even though
    // that part was then excluded from eligibleParts and never shown to the
    // model). Any hallucinated or out-of-range partIndex is silently dropped,
    // preventing mutation of fully-settled parts or array out-of-bounds errors.
    const eligiblePartIndices = new Set(eligibleParts.map((part) => part.partIndex));
    const validUpdates = comparisonUpdates.filter(
      (update) => eligiblePartIndices.has(update.partIndex)
    );

    // Merge comparison results back into response: only partIndices present in
    // validUpdates are modified; all other parts stay exactly as the first
    // pass reported them.
    for (const update of validUpdates) {
      response.parts[update.partIndex].brand = update.brand;
      response.parts[update.partIndex].partNumber = update.partNumber;
      response.parts[update.partIndex].identityCandidates = update.identityCandidates;
    }

    logger.info(
      { listingId: listing.id, updatedCount: comparisonUpdates.length },
      'AI visual comparison complete',
    );

    return response;
  } catch (err) {
    // Logged here with the listing context the central error handler does not
    // have, then rethrown unchanged so the route's AppError status survives.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ listingId: listing.id, err, message }, 'AI part identification failed');
    throw err;
  }
}
