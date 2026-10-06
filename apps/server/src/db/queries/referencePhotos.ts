// Typed CRUD for the `part_reference_photos` table (ai-visual-identification feature T1).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { logger } from '../../logger.js';
import { downloadFile } from '../download.js';
import { isDecodableImage } from '../imageSignature.js';
import type { ComponentCategory } from '../types.js';

const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// Same DUCKDB_DATA_DIR-override convention seedReferencePhotos.ts computes for itself (not
// imported from photoStorage.ts, matching that file's own choice), five `..` segments up from
// this file's one-level-deeper db/queries/ location to reach the same data/ directory root.
const DATA_DIR = process.env.DUCKDB_DATA_DIR ?? path.resolve(moduleDir, '../../../../../data');
const AUTO_SOURCED_DIR = path.join(DATA_DIR, 'reference-photos', 'auto-sourced');

// Picks a lowercase extension (including the dot) recognized as a raster-image type from a
// URL's path, ignoring any querystring; falls back to .jpg for an absent or unrecognized
// extension, same convention photoStorage.ts's own remote-image downloads use.
function resolveImageExtension(url: string): string {
  const KNOWN_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (KNOWN_EXTENSIONS.includes(ext)) return ext;
  } catch {
    // Malformed URL falls through to the default extension below.
  }
  return '.jpg';
}

/**
 * Atomically inserts one `part_reference_photos` row for (category, brand,
 * partNumber, photoPath), or reports it as already present, without ever
 * letting two overlapping callers race into a duplicate row. Shared by
 * promoteReferencePhotos (per confirmed-listing photo, source=
 * 'confirmed_listing') and insertSeedReferencePhoto (source='seed'), so the
 * null-partNumber dedup fix only has to exist in one place.
 *
 * When partNumber is null, the unique index on (category, brand, part_number,
 * photo_path) never fires — DuckDB treats every NULL as distinct from every
 * other NULL — so re-inserting the same brand-only combo would otherwise add
 * a duplicate row. A separate existence check followed by a separate INSERT
 * would race: two concurrent callers inserting the identical combo could both
 * pass the check before either inserts, producing two rows (Req 4). The
 * INSERT...SELECT...WHERE NOT EXISTS below runs as one statement, so the
 * existence check and the insert are atomic against overlapping callers the
 * same way the non-null-partNumber path below is atomic via the DB's unique
 * index — the serialized connection (client.ts) still only lets one
 * statement run at a time, but this single statement is immune to the
 * check-then-act gap a two-statement sequence would have.
 */
async function insertReferencePhotoRow(
  category: ComponentCategory,
  brand: string,
  partNumber: string | null,
  photoPath: string,
  source: 'seed' | 'confirmed_listing' | 'auto_sourced',
  listingId: string | null,
): Promise<{ inserted: boolean }> {
  const connection = await getConnection();

  if (partNumber === null) {
    const result = await connection.runAndReadAll(
      `INSERT INTO part_reference_photos
         (id, category, brand, part_number, photo_path, source, listing_id)
       SELECT $id, $category, $brand, NULL, $photo_path, $source, $listing_id
       WHERE NOT EXISTS (
         SELECT 1 FROM part_reference_photos
         WHERE category = $category AND brand = $brand AND part_number IS NULL
           AND photo_path = $photo_path
       )`,
      {
        id: newId(),
        category,
        brand,
        photo_path: photoPath,
        source,
        listing_id: listingId,
      },
    );
    const [{ Count: rowsAffected }] = result.getRowObjectsJson() as Array<{ Count: string }>;
    return { inserted: Number(rowsAffected) > 0 };
  }

  try {
    await connection.runAndReadAll(
      `INSERT INTO part_reference_photos
         (id, category, brand, part_number, photo_path, source, listing_id)
       VALUES
         ($id, $category, $brand, $part_number, $photo_path, $source, $listing_id)`,
      {
        id: newId(),
        category,
        brand,
        part_number: partNumber,
        photo_path: photoPath,
        source,
        listing_id: listingId,
      },
    );
    return { inserted: true };
  } catch (err) {
    if (err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message)) {
      return { inserted: false };
    }
    throw err;
  }
}

/**
 * Inserts one row per photo path from a confirmed listing, relying on
 * insertReferencePhotoRow's atomic insert-or-skip to treat an already-present
 * combo as "already promoted, skip" (same pattern as the eBay connector's
 * duplicate-listing insert). Logs at Info when a row is skipped as a
 * duplicate.
 */
export async function promoteReferencePhotos(
  listingId: string,
  photoPaths: readonly string[],
  category: ComponentCategory,
  brand: string,
  partNumber: string | null,
): Promise<void> {
  for (const photoPath of photoPaths) {
    const { inserted } = await insertReferencePhotoRow(
      category,
      brand,
      partNumber,
      photoPath,
      'confirmed_listing',
      listingId,
    );
    if (!inserted) {
      logger.info(
        { category, brand, partNumber, photoPath, listingId },
        'Skipped reference photo already in database',
      );
    }
  }
}

/**
 * Inserts one seed reference photo row (source='seed', listing_id=null),
 * reusing promoteReferencePhotos's atomic insert-or-skip so the seed script
 * can't reopen the null-partNumber dedup race by re-implementing its own
 * raw SQL insert. Returns `{ inserted: false }` rather than throwing when the
 * row already exists, so the caller (the seed script) can log and tally the
 * skip the same way it tallies a successful insert.
 */
export async function insertSeedReferencePhoto(
  category: ComponentCategory,
  brand: string,
  partNumber: string | null,
  photoPath: string,
): Promise<{ inserted: boolean }> {
  return insertReferencePhotoRow(category, brand, partNumber, photoPath, 'seed', null);
}

/**
 * Downloads `url`, verifies it is both a successful HTTP download and a genuine decodable
 * raster image (JPEG/PNG/GIF/WebP magic bytes — Requirement 3: the server never trusts the
 * model's own claim that a URL is a real product photo), and on success inserts one
 * part_reference_photos row via insertReferencePhotoRow with source='auto_sourced',
 * listing_id=null. `partNumber` is always a real string here (Requirement 1 only triggers
 * sourcing once brand and partNumber are both already known), so this always takes
 * insertReferencePhotoRow's non-null-partNumber branch. On any failure — failed download, or
 * a 200 response whose bytes aren't a decodable image — returns `{ inserted: false }` without
 * touching the DB and without leaving a partial/unverified file on disk.
 */
export async function insertSourcedReferencePhoto(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
  url: string,
): Promise<{ inserted: boolean }> {
  if (!fs.existsSync(AUTO_SOURCED_DIR)) {
    fs.mkdirSync(AUTO_SOURCED_DIR, { recursive: true });
  }

  // Collision-safe AND deterministic-per-URL filename (a SHA-256 hex digest of the URL plus
  // its own extension): the latter matters because insertReferencePhotoRow's non-null-
  // partNumber dedup is keyed on (category, brand, part_number, photo_path) together, so two
  // calls that download the identical URL for the identical combo must also land on the
  // identical photo_path for that unique index to recognize the repeat and skip it.
  const filename = `${createHash('sha256').update(url).digest('hex')}${resolveImageExtension(url)}`;
  const targetPath = path.join(AUTO_SOURCED_DIR, filename);

  const downloaded = await downloadFile(url, targetPath);
  if (!downloaded) {
    return { inserted: false };
  }

  if (!(await isDecodableImage(targetPath))) {
    // HTTP 200 doesn't prove real image bytes; clean up rather than leaving orphaned,
    // unverified bytes on disk for a row that will never be inserted.
    await fs.promises.unlink(targetPath).catch(() => {});
    logger.warn({ url, targetPath }, 'Downloaded reference photo failed real-image verification');
    return { inserted: false };
  }

  return insertReferencePhotoRow(
    category,
    brand,
    partNumber,
    `reference-photos/auto-sourced/${filename}`,
    'auto_sourced',
    null,
  );
}
