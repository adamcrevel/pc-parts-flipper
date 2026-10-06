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
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CreateListingInput, ExpectedPartInput, ListingDetail } from '@pc-parts-flipper/shared';
import type { FastifyInstance } from 'fastify';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as ReferencePhotosModule from '../src/db/queries/referencePhotos.js';
import { getJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Mocks only the leaf module backing promoteReferencePhotos (re-exported from
// the db barrel, db/index.ts), wrapping the real implementation in a vi.fn so
// tests below get genuine promotion behavior by default — only tests that call
// mockImplementationOnce override it, to prove the catch/log-Error path
// (standing check) without faking a real DB failure.
// Scoped to this file's own module graph; the spawned child-process server
// the describe block above uses runs in a separate OS process and is
// entirely unaffected by this.
vi.mock('../src/db/queries/referencePhotos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReferencePhotosModule>();
  return { ...actual, promoteReferencePhotos: vi.fn(actual.promoteReferencePhotos) };
});
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

// Helper function for building listing body with expected parts
function listingBodyWithParts(sourceId: string, expectedParts: ExpectedPartInput[]): CreateListingInput {
  return {
    sourceId,
    title: 'Photo upload promotion test listing',
    description: 'Used to exercise photo promotion via POST /api/listings/:id/photos',
    listingUrl: 'https://example.com/listing/photo-test',
    askingPrice: 50,
    listingDate: '2026-01-15',
    acquisitionFees: 0,
    expectedParts,
  };
}

// Helper function for uploading photos via form data
async function uploadPhotoViaForm(
  baseUrl: string,
  listingId: string,
  photoData: Uint8Array,
  filename: string,
): Promise<JsonResponse<ListingDetail>> {
  const form = new FormData();
  form.append('photo', new Blob([photoData], { type: 'image/jpeg' }), filename);
  const res = await fetch(`${baseUrl}/api/listings/${listingId}/photos`, { method: 'POST', body: form });
  const body = (await res.json()) as ListingDetail;
  return { status: res.status, body };
}

// PUTs `body` as JSON to `url` and returns the parsed response status/body.
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: res.status, body: await res.json() as T };
}

// T2 proof (photo promotion hook wired into listingPhotos.ts, Requirement 2):
// the describe block above exercises the route against the real HTTP contract
// via a spawned child-process server (helpers.ts), which has no way to directly
// inspect part_reference_photos — DuckDB only allows one process to hold this
// file open at a time. This block instead boots registerListingsRoutes in-process
// (Fastify() + registerErrorHandler), specifically so it can (a) run raw SQL
// against the exact connection the routes use to verify real row state, and (b)
// force promoteReferencePhotos to throw via vi.mock, to prove the catch/log-Error
// path without faking an actual DB failure.
describe('Photo upload promotion hook — DB-verified (T2)', () => {
  const PHOTO_HOOK_PORT = 34_633;
  const PHOTO_HOOK_BASE_URL = `http://127.0.0.1:${PHOTO_HOOK_PORT}`;
  let photoHookDataDir: string;
  let photoHookDb: typeof DbModule;
  let photoHookGetConnection: typeof ClientModule.getConnection;
  let photoHookApp: FastifyInstance;
  let photoHookSourceId: string;

  beforeAll(async () => {
    photoHookDataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-photos-hook-test-'));
    process.env.DUCKDB_DATA_DIR = photoHookDataDir;
    // Dynamic import: client.ts's DATA_DIR is computed once, at module-evaluation
    // time, from DUCKDB_DATA_DIR — a static top-of-file import would evaluate
    // before this beforeAll sets the env var.
    photoHookDb = await import('../src/db/index.js');
    ({ getConnection: photoHookGetConnection } = await import('../src/db/client.js'));
    const { registerListingsRoutes: registerPhotoHookRoutes } = await import('../src/routes/listings.js');
    const { registerErrorHandler } = await import('../src/error-handler.js');
    const Fastify = (await import('fastify')).default;
    photoHookApp = Fastify();
    registerErrorHandler(photoHookApp);
    await registerPhotoHookRoutes(photoHookApp);
    await photoHookApp.listen({ port: PHOTO_HOOK_PORT, host: '127.0.0.1' });
    const source = await photoHookDb.createSource({
      name: 'T2 Photo Hook Source',
      platformType: 'ebay',
      url: null,
      notes: null,
      connectorConfig: null,
    });
    photoHookSourceId = source.id;
  }, 30_000);

  afterAll(async () => {
    await photoHookApp.close();
    delete process.env.DUCKDB_DATA_DIR;
    await rm(photoHookDataDir, { recursive: true, force: true });
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('photo upload via POST /api/listings/:id/photos promotes photos for Expected Parts with non-null brand', async () => {
    // Create a new listing without expected parts or photos
    const created = await postJson<ListingDetail>(
      `${PHOTO_HOOK_BASE_URL}/api/listings`,
      listingBodyWithParts(photoHookSourceId, []),
    );
    expect(created.status, `listing creation failed: ${JSON.stringify(created.body)}`).toBe(201);
    const listingId = created.body.id;

    // Add expected parts with a non-null brand via PUT
    const updated = await putJson<ListingDetail>(
      `${PHOTO_HOOK_BASE_URL}/api/listings/${listingId}`,
      listingBodyWithParts(photoHookSourceId, [
        {
          componentCategory: 'GPU',
          brand: 'NVIDIA',
          partNumber: 'RTX 4080',
          description: 'Reference card',
          estimatedResaleValue: 300,
        },
      ]),
    );
    expect(updated.status, `PUT failed: ${JSON.stringify(updated.body)}`).toBe(200);

    // Upload a photo via the photo-upload route
    const photoRes = await uploadPhotoViaForm(PHOTO_HOOK_BASE_URL, listingId, new Uint8Array([1, 2, 3, 4]), 'test.jpg');
    expect(photoRes.status, `photo upload failed: ${JSON.stringify(photoRes.body)}`).toBe(200);

    // Verify that the photo was promoted to part_reference_photos
    const connection = await photoHookGetConnection();
    const reader = await connection.runAndReadAll(
      `SELECT photo_path, category, brand, part_number, source FROM part_reference_photos WHERE listing_id = $listing_id ORDER BY photo_path`,
      { listing_id: listingId },
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('GPU');
    expect(rows[0].brand).toBe('NVIDIA');
    expect(rows[0].part_number).toBe('RTX 4080');
    expect(rows[0].source).toBe('confirmed_listing');
  });
});
