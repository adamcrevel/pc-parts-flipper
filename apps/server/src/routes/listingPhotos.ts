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
import { fileURLToPath } from 'node:url';
import { getListingById, updateListing } from '../db/index.js';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';

// apps/server/src/routes/listingPhotos.ts -> apps/server/src/routes ->
// apps/server/src -> apps/server -> apps -> <worktree root>, the same depth
// client.ts resolves data/ from (see db/client.ts's comment for why four
// `..` segments is correct for both tsx-from-src and node-from-dist runs).
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.resolve(moduleDir, '../../../../data/photos');

// Guards against an unbounded upload size filling local disk; generous for
// phone-camera photos of used PC hardware.
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
