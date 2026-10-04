// Shared local photo storage for Listing images (Req 2): where photo files
// live on disk, and how a remote marketplace image URL becomes one of those
// files. Both the manual upload route (routes/listingPhotos.ts) and the
// automated scan/backfill paths (scan/scanService.ts, photos/photoBackfill.ts)
// go through here so there is exactly one definition of PHOTOS_DIR, one
// filename convention, and one size cap — previously all three lived only
// inside the upload route.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

// apps/server/src/photos/photoStorage.ts -> apps/server/src/photos ->
// apps/server/src -> apps/server -> apps -> <worktree root>. The compiled
// apps/server/dist/photos/ tree mirrors this same depth, so the same four
// `..` segments resolve correctly whether this runs via tsx (from src) or
// node (from dist) — identical reasoning to db/client.ts's DEFAULT_DATA_DIR.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(moduleDir, '../../../../data');

// Shares db/client.ts's DUCKDB_DATA_DIR override deliberately: a test (or a
// throwaway tool run) that redirects the database to an isolated directory
// must get the photos that database references redirected with it, or its
// rows would point at files written into the real shared data/ directory.
// One variable moves both halves of the data directory together.
const DATA_DIR = process.env.DUCKDB_DATA_DIR ?? DEFAULT_DATA_DIR;

/** Absolute directory every stored listing photo is written into. */
export const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

// Guards against an unbounded file size filling local disk; generous for
// phone-camera photos of used PC hardware, and well above eBay's own
// full-resolution images (~100-400KB each).
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Image extensions trusted straight from a remote URL's path. Anything else
// (including no extension at all, or a querystring-only URL) falls back to
// .jpg, which is what eBay's CDN actually serves.
const KNOWN_IMAGE_EXTENSIONS: Record<string, true> = {
  '.jpg': true,
  '.jpeg': true,
  '.png': true,
  '.gif': true,
  '.webp': true,
  '.avif': true,
};

// Derives a file extension from a remote image URL's path, ignoring any
// querystring (URL parsing drops it) and rejecting anything that isn't a
// recognized image extension so a URL like `.../image.php` can't produce a
// nonsense `.php` file on disk.
function resolveExtension(imageUrl: string): string {
  try {
    const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
    return KNOWN_IMAGE_EXTENSIONS[ext] ? ext : '.jpg';
  } catch {
    // Not a parseable absolute URL — the fetch below will fail too, but this
    // function must not be the thing that throws.
    return '.jpg';
  }
}

/**
 * Downloads one remote image into PHOTOS_DIR and returns its `photos/<file>`
 * relative path, or null when the image could not be stored. Every failure
 * mode — network error, non-200 response, oversized payload — is logged at
 * Warn and reported as null rather than thrown: a missing photo degrades a
 * scan or backfill, it never fails one, so a single bad image can't cost the
 * caller the listing it belongs to.
 */
export async function downloadImageToFile(imageUrl: string, idPrefix: string): Promise<string | null> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      logger.warn({ imageUrl, idPrefix, status: response.status }, 'Skipped listing photo: image download returned a non-200 response');
      return null;
    }

    // Checked before buffering so an oversized image is rejected on its
    // advertised length where the server provides one, instead of being
    // fully read into memory first.
    const declaredLength = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
      logger.warn({ imageUrl, idPrefix, declaredLength, maxBytes: MAX_FILE_BYTES }, 'Skipped listing photo: declared size exceeds the per-file cap');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    // Re-checked on the real payload: content-length is advisory and absent
    // on chunked responses, so it cannot be the only size guard.
    if (buffer.byteLength > MAX_FILE_BYTES) {
      logger.warn({ imageUrl, idPrefix, bytes: buffer.byteLength, maxBytes: MAX_FILE_BYTES }, 'Skipped listing photo: downloaded size exceeds the per-file cap');
      return null;
    }

    // Same filename convention as the manual upload route: the Listing id, a
    // UUID so two photos of one Listing can never collide, and the extension.
    const storedName = `${idPrefix}-${randomUUID()}${resolveExtension(imageUrl)}`;
    await mkdir(PHOTOS_DIR, { recursive: true });
    await writeFile(path.join(PHOTOS_DIR, storedName), buffer);
    logger.debug({ imageUrl, idPrefix, storedName, bytes: buffer.byteLength }, 'Stored listing photo from remote image URL');
    // Stored relative to data/ (not absolute), matching photoPaths' existing
    // convention so paths stay portable across machines.
    return path.join('photos', storedName);
  } catch (err) {
    logger.warn({ imageUrl, idPrefix, err }, 'Skipped listing photo: image download failed');
    return null;
  }
}

/**
 * Downloads every URL in `imageUrls` for `idPrefix`, sequentially (a scan
 * pass is not latency-sensitive, and serial downloads keep this app a polite
 * client of the image CDN), and returns the relative paths of the ones that
 * succeeded. Partial success is normal and expected: the returned array may
 * be shorter than the input, or empty, and never throws.
 */
export async function downloadImagesToFiles(imageUrls: string[], idPrefix: string): Promise<string[]> {
  const storedPaths: string[] = [];
  for (const imageUrl of imageUrls) {
    const stored = await downloadImageToFile(imageUrl, idPrefix);
    if (stored !== null) {
      storedPaths.push(stored);
    }
  }
  if (storedPaths.length < imageUrls.length) {
    logger.warn(
      { idPrefix, requested: imageUrls.length, stored: storedPaths.length },
      'Some listing photos could not be downloaded and were skipped',
    );
  }
  return storedPaths;
}
