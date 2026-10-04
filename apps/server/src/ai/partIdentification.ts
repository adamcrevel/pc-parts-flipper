// Orchestrates one AI part identification for a Listing: resolve its photos
// to absolute paths, build the prompt, run the model, parse the answer. The
// three steps either side of it live in sibling modules
// (identificationPrompt.ts, ompRunner.ts, identificationParser.ts) so each
// stays small enough to read and test on its own; this file is only the
// sequence that joins them.
//
// On-demand only. A single call takes ~9s for one photo and ~34s for eight, so
// this is never run automatically during a scan — it happens when the user
// presses "Identify Parts" on a Listing, and nowhere else.
import path from 'node:path';
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import type { Listing } from '../db/index.js';
import { logger } from '../logger.js';
import { PHOTOS_DIR } from '../photos/photoStorage.js';
import { buildIdentificationPrompt } from './identificationPrompt.js';
import { parseIdentificationResponse } from './identificationParser.js';
import { getOmpRunner, type OmpRunOptions } from './ompRunner.js';

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
 * Identifies the components likely contained in `listing`, from its title,
 * description and photos. Resolves to the parsed, validated model response;
 * rejects with an AppError carrying a real message (CLI missing, not logged
 * in, timed out, unparseable output) — never with a silent empty result
 * standing in for a failure.
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
    return response;
  } catch (err) {
    // Logged here with the listing context the central error handler does not
    // have, then rethrown unchanged so the route's AppError status survives.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ listingId: listing.id, err, message }, 'AI part identification failed');
    throw err;
  }
}
