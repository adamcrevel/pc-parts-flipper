// Shared "real bytes over HTTP" download helper (ai-visual-identification feature T3,
// extracted for reuse by ai-reference-autosourcing feature T4). Originally a private function
// inside seedReferencePhotos.ts; now its one real implementation, imported by both
// seedReferencePhotos.ts (the one-time curated seed) and db/queries/referencePhotos.ts's
// insertSourcedReferencePhoto (the runtime download of a model-found manufacturer photo), so a
// second copy of this logic never has to be kept in sync with this one.
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { logger } from '../logger.js';

/**
 * Downloads a file from the given URL and saves it to the target path.
 * Uses event-based I/O with callback-based promise. Logs at Info on success,
 * Warn on failure. Returns true if successful.
 */
// Uses a `new Promise` executor rather than `Promise.withResolvers` deliberately: this
// package's tsconfig pins `lib: ["ES2022"]` (tsconfig.base.json), which doesn't declare
// `Promise.withResolvers` (ES2024) and fails `tsc` build even though vitest's transpile-only
// runner doesn't catch it.
export async function downloadFile(url: string, targetPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const client = url.startsWith('https') ? https : http;

    client
      .get(url, { timeout: 10000, headers: { 'User-Agent': 'pc-parts-flipper-reference-seed/1.0 (internal personal-use tool; local)' } }, response => {
        if (response.statusCode === 200) {
          const file = fs.createWriteStream(targetPath);
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            logger.info({ url, targetPath }, 'Downloaded reference photo');
            resolve(true);
          });
          file.on('error', err => {
            fs.unlink(targetPath, () => {});
            logger.warn(
              { url, targetPath, error: (err as Error).message },
              'Failed to save reference photo',
            );
            resolve(false);
          });
        } else {
          logger.warn(
            { url, statusCode: response.statusCode },
            'Reference photo download returned non-200 status',
          );
          resolve(false);
        }
      })
      .on('error', err => {
        logger.warn(
          { url, error: (err as Error).message },
          'Failed to download reference photo',
        );
        resolve(false);
      });
  });
}
