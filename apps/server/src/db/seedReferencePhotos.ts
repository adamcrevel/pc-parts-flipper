/**
 * One-time seed download+insert logic for reference photos (ai-visual-identification feature
 * T3). Downloads a curated set of 10 real product photos, each individually verified
 * (HTTP 200 + real decoded JPEG bytes, confirmed with a direct download) before
 * being wired in here, and inserts them into part_reference_photos with
 * source='seed'.
 *
 * Source: Wikimedia Commons (commons.wikimedia.org) — real, freely-licensed
 * photos, not a manufacturer's own CDN. This is deliberate, not a downgrade:
 * Commons content is explicitly licensed for this kind of reuse (each file's
 * own page carries its CC-BY/CC-BY-SA/public-domain terms), which sidesteps
 * any hotlinking/ToS ambiguity a manufacturer or retailer's own image CDN
 * would carry. Each entry below is labeled with exactly what the photographed
 * item actually is — a few are a different specific model than this feature's
 * original planning example named (e.g. AMD Wraith Spire rather than Wraith
 * Stealth, NZXT H500i rather than H510) because that is what a real, verified
 * photo was actually available for; nothing here is mislabeled to match a
 * wish list.
 *
 * Run manually: `npm run seed-reference-photos -w @pc-parts-flipper/server`
 * or directly: `tsx src/scripts/seed-reference-photos.ts` from the server directory.
 * Does not run automatically during npm test or server boot.
 *
 * The work itself lives here, not in the CLI entry point
 * (src/scripts/seed-reference-photos.ts), so it can be tested by importing
 * runSeed directly instead of spawning a process (same split as
 * photos/photoBackfill.ts / scripts/backfill-photos.ts).
 *
 * Logs at Info for each action and Warn for any failed download.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadFile } from './download.js';
import { insertSeedReferencePhoto } from './queries/referencePhotos.js';
import { logger } from '../logger.js';
import { SEED_PHOTOS } from './seedReferencePhotosData.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// Honors the same DUCKDB_DATA_DIR override db/client.ts and photoStorage.ts's
// PHOTOS_DIR already do, so a run redirected at an isolated data directory
// (a test, or a throwaway verification run) writes its photos there too,
// never into the real shared data/ directory.
const DATA_DIR = process.env.DUCKDB_DATA_DIR ?? path.resolve(moduleDir, '../../../../data');
const SEED_DIR = path.join(DATA_DIR, 'reference-photos', 'seed');

/**
 * Main seed operation: for each photo spec, download if missing,
 * then inserts one row into part_reference_photos via the query layer
 * (insertSeedReferencePhoto), which atomically skips a combo already
 * present rather than this file re-implementing its own unique-constraint
 * catch. Returns a summary of succeeded and failed operations. Has no CLI
 * side effects — the CLI wrapper (scripts/seed-reference-photos.ts) is the
 * only place this is invoked with process.exit semantics.
 */
export async function runSeed(): Promise<{ succeeded: number; failed: number }> {
  // Ensure seed directory exists
  if (!fs.existsSync(SEED_DIR)) {
    fs.mkdirSync(SEED_DIR, { recursive: true });
  }

  let succeeded = 0;
  let failed = 0;

  for (const spec of SEED_PHOTOS) {
    const localPath = path.join(SEED_DIR, spec.filename);

    // Download if not already present
    if (!fs.existsSync(localPath)) {
      const downloaded = await downloadFile(spec.url, localPath);
      if (!downloaded) {
        failed += 1;
        continue;
      }
    } else {
      logger.info({ filename: spec.filename }, 'Reference photo already cached');
    }

    // Insert into database via the query layer, which atomically treats an
    // already-present combo as a skip rather than throwing.
    try {
      const { inserted } = await insertSeedReferencePhoto(
        spec.category,
        spec.brand,
        spec.partNumber,
        `reference-photos/seed/${spec.filename}`,
      );
      if (inserted) {
        logger.info(
          { category: spec.category, brand: spec.brand, partNumber: spec.partNumber },
          'Inserted reference photo row',
        );
      } else {
        logger.info(
          {
            category: spec.category,
            brand: spec.brand,
            partNumber: spec.partNumber,
            filename: spec.filename,
          },
          'Skipped reference photo row already in database',
        );
      }
      succeeded += 1;
    } catch (err) {
      if (err instanceof Error) {
        logger.warn(
          {
            category: spec.category,
            brand: spec.brand,
            partNumber: spec.partNumber,
            error: err.message,
          },
          'Failed to insert reference photo row',
        );
      } else {
        logger.warn(
          { category: spec.category, brand: spec.brand, error: err },
          'Failed to insert reference photo row (unknown error)',
        );
      }
      failed += 1;
    }
  }

  return { succeeded, failed };
}
