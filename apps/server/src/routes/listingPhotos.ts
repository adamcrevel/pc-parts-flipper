// HTTP route for uploading photo(s) onto an existing Listing (Req 2;
// assumption A4: local disk storage under the gitignored data/ directory,
// referenced by path in DuckDB). The multipart parsing itself is the only
// filesystem access here — DuckDB access still goes exclusively through
// updateListing (apps/server/src/db), per the standing check.
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyTypeProvider,
  FastifyTypeProviderDefault,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerBase,
  RawServerDefault,
} from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getListingById, updateListing } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';
// PHOTOS_DIR and the per-file size cap now live in the shared photo-storage
// module, so this upload route and the scan/backfill download path cannot
// drift apart on where photos go or how large one may be. The resolution
// rule is unchanged from what was inlined here before (same four `..`
// segments to the worktree root, same 10MB cap) — it additionally honors
// db/client.ts's DUCKDB_DATA_DIR override so a redirected database and its
// photos stay together.
import { MAX_FILE_BYTES, PHOTOS_DIR } from '../photos/photoStorage.js';

/**
 * Registers `POST /api/listings/:id/photos` on the given Fastify instance.
 * Called once from registerListingsRoutes (listings.ts), which registers
 * the `@fastify/multipart` plugin here rather than globally in index.ts
 * since no other route in this app accepts file uploads.
 */
export async function registerListingPhotoRoutes<
  RawServer extends RawServerBase = RawServerDefault,
  RawRequestType extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
  RawReplyType extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
  Logger extends FastifyBaseLogger = FastifyBaseLogger,
  TypeProvider extends FastifyTypeProvider = FastifyTypeProviderDefault,
>(server: FastifyInstance<RawServer, RawRequestType, RawReplyType, Logger, TypeProvider>): Promise<void> {
  await server.register(multipart, { limits: { fileSize: MAX_FILE_BYTES } });

  server.post('/api/listings/:id/photos', async (request) => {
    const { id } = request.params as { id: string };
    logger.info({ route: 'POST /api/listings/:id/photos', id }, 'Uploading listing photo(s)');
    const listing = await getListingById(id);
    if (!listing) {
      throw new AppError(`Listing ${id} not found`, 404);
    }

    await mkdir(PHOTOS_DIR, { recursive: true });

    const storedPaths: string[] = [];
    // request.files() yields every file part of a multipart/form-data body,
    // so a single request may upload one or several photos (Req 2).
    for await (const part of request.files()) {
      const ext = path.extname(part.filename);
      // UUID-prefixed filename avoids collisions between two uploads that
      // share an original filename (e.g. two phones both naming a shot IMG_0001).
      const storedName = `${id}-${randomUUID()}${ext}`;
      const buffer = await part.toBuffer();
      await writeFile(path.join(PHOTOS_DIR, storedName), buffer);
      // Stored relative to data/ (not absolute), matching photoPaths'
      // existing convention so paths stay portable across machines.
      storedPaths.push(path.join('photos', storedName));
    }

    if (storedPaths.length === 0) {
      throw new AppError('At least one photo file is required', 400);
    }

    return updateListing(id, { photoPaths: [...listing.photoPaths, ...storedPaths] });
  });
}
