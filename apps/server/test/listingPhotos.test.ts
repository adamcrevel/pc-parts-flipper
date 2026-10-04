// Integration proof for POST /api/listings/:id/photos
// (apps/server/src/routes/listingPhotos.ts). This route previously had zero
// test coverage anywhere in the repo; this file is the regression guard for
// both the route's own contract (stored filename convention, 400 on zero
// files) and this PR's refactor that moved PHOTOS_DIR/MAX_FILE_BYTES out of
// the route and into the shared apps/server/src/photos/photoStorage.ts
// module — a future change to that module's path-join order or exports
// would otherwise go uncaught until a manual upload broke in the field.
//
// Follows the same real-server-via-child-process pattern as listings.test.ts
// / concurrency.test.ts (helpers.ts's startTestServer): boots the actual
// Fastify app against an isolated temp DuckDB (+ photos) directory and
// exercises the real HTTP route end to end, including the actual file
// written to disk, rather than importing the handler function directly.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from every other suite's TEST_PORT (see e.g. teardown.test.ts's
// 34_625) so this suite can run standalone or alongside the others without a
// port collision.
const TEST_PORT = 34_626;

interface SourceResponse {
  id: string;
}

// Builds a valid create-Listing request body; mirrors listings.test.ts's
// listingBody helper (kept local since the two files run concurrently and
// neither currently shares test-only fixtures via helpers.ts).
function listingBody(sourceId: string): CreateListingInput {
  return {
    sourceId,
    title: 'Photo upload test listing',
    description: 'Used to exercise POST /api/listings/:id/photos',
    listingUrl: 'https://example.com/listing/photo-test',
    askingPrice: 50,
    listingDate: '2026-01-15',
    acquisitionFees: 0,
    expectedParts: [],
  };
}

describe('POST /api/listings/:id/photos', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Listing Photos Test Source',
      platformType: 'ebay',
      url: 'https://example.com/listing-photos-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('stores an uploaded photo under photos/<id>-<uuid>.<ext>, on disk and in photoPaths', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    const listingId = created.body.id;

    const form = new FormData();
    form.append('photo', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), 'original-name.jpg');

    const res = await fetch(`${server.baseUrl}/api/listings/${listingId}/photos`, { method: 'POST', body: form });
    const body = (await res.json()) as ListingDetail;
    expect(res.status, `upload failed: ${JSON.stringify(body)}`).toBe(200);

    // UUID-prefixed-by-listing-id filename convention from listingPhotos.ts:
    // `${id}-${randomUUID()}${ext}`, stored relative as `photos/<that>`.
    const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    const expectedPathPattern = new RegExp(`^photos/${listingId}-${uuidPattern}\\.jpg$`);
    const storedPath = body.photoPaths.find((p) => expectedPathPattern.test(p));
    expect(storedPath, `no photoPaths entry matched ${expectedPathPattern} in ${JSON.stringify(body.photoPaths)}`).toBeDefined();

    // The response claiming success is not proof the file is actually on
    // disk (e.g. a write to the wrong directory would still echo the path
    // back) — this is exactly what this PR's PHOTOS_DIR refactor needs a
    // regression guard for, so assert the file's real location too.
    const onDiskPath = path.join(server.dataDir, storedPath as string);
    const stats = await stat(onDiskPath);
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBe(4);

    // GET round-trip confirms the path was actually persisted via
    // updateListing, not merely returned in this one response.
    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.photoPaths).toEqual(body.photoPaths);
  });

  it('rejects a request with zero photo files with 400, never silently accepting', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    const listingId = created.body.id;

    // A multipart body with a text field but no file part — @fastify/
    // multipart's request.files() yields zero parts for this, driving the
    // route's `storedPaths.length === 0` branch.
    const form = new FormData();
    form.append('note', 'no files attached');

    const res = await fetch(`${server.baseUrl}/api/listings/${listingId}/photos`, { method: 'POST', body: form });
    const body = (await res.json()) as { error: { message: string } };
    expect(res.status).toBe(400);
    expect(body.error.message).toBe('At least one photo file is required');

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${listingId}`);
    expect(fetched.body.photoPaths).toEqual([]);
  });
});
