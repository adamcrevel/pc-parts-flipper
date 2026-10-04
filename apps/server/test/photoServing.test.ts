// Integration proof for GET /photos/<file> (the @fastify/static registration
// in apps/server/src/index.ts). This route previously did not exist at all —
// photo-upload.tsx rendered a bare filename list because nothing served the
// files it referenced. Two contracts matter here: (1) a real uploaded photo
// is actually fetchable at its stored photoPaths value, with the right
// bytes; and (2) the registration is scoped tightly enough to PHOTOS_DIR
// that a path-traversal attempt can never reach the sibling
// pc-parts-flipper.duckdb file one directory up in DATA_DIR — downloading
// the entire application database over plain HTTP would otherwise be one
// `..` away.
//
// Follows the same real-server-via-child-process pattern as
// listingPhotos.test.ts (helpers.ts's startTestServer): boots the actual
// Fastify app against an isolated temp DuckDB (+ photos) directory and
// exercises the real HTTP route end to end.
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import { postJson, startTestServer, type TestServer } from './helpers.js';

// Distinct from every other suite's TEST_PORT (see e.g. listingPhotos.test.ts's
// 34_626) so this suite can run standalone or alongside the others without a
// port collision.
const TEST_PORT = 34_627;

interface SourceResponse {
  id: string;
}

// Builds a valid create-Listing request body; mirrors listingPhotos.test.ts's
// listingBody helper (kept local for the same reason it is there: the two
// files run concurrently and neither shares test-only fixtures via
// helpers.ts).
function listingBody(sourceId: string): CreateListingInput {
  return {
    sourceId,
    title: 'Photo serving test listing',
    description: 'Used to exercise GET /photos/:file',
    listingUrl: 'https://example.com/listing/photo-serving-test',
    askingPrice: 50,
    listingDate: '2026-01-15',
    acquisitionFees: 0,
    expectedParts: [],
  };
}

// Sends a raw HTTP GET with `rawPath` placed on the wire exactly as given,
// bypassing fetch()/the URL class entirely. Both collapse dot-segments
// (literal `..` and percent-encoded `%2e%2e`) client-side before a request
// ever leaves the process, which would make a traversal assertion sent via
// fetch() pass for the wrong reason (a bare `/pc-parts-flipper.duckdb`
// request 404ing) regardless of whether @fastify/static's server-side
// traversal guard exists at all. node:http's ClientRequest performs no such
// normalization — the `path` option is written to the socket literally —
// so this is the only way from this process to genuinely exercise that
// guard. Mirrors `curl --path-as-is`, used to verify this independently.
function rawPathGet(baseUrl: string, rawPath: string): Promise<{ status: number; text: string }> {
  const url = new URL(baseUrl);
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
  const req = http.request(
    { hostname: url.hostname, port: url.port, path: rawPath, method: 'GET' },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    },
  );
  req.on('error', reject);
  req.end();
  return promise;
}

describe('GET /photos/:file', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Photo Serving Test Source',
      platformType: 'ebay',
      url: 'https://example.com/photo-serving-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('serves a real uploaded photo at its stored photoPaths value with the correct bytes and content-type', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    const listingId = created.body.id;

    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const form = new FormData();
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'original-name.jpg');

    const uploadRes = await fetch(`${server.baseUrl}/api/listings/${listingId}/photos`, { method: 'POST', body: form });
    const uploadBody = (await uploadRes.json()) as ListingDetail;
    expect(uploadRes.status, `upload failed: ${JSON.stringify(uploadBody)}`).toBe(200);
    const storedPath = uploadBody.photoPaths[uploadBody.photoPaths.length - 1];
    expect(storedPath).toMatch(/^photos\//);

    // The actual contract under test: fetching the stored photoPaths value
    // (as-is, the same string the frontend will build a URL from) via GET
    // returns the exact bytes written to disk during upload.
    const getRes = await fetch(`${server.baseUrl}/${storedPath}`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toBe('image/jpeg');
    const returnedBytes = new Uint8Array(await getRes.arrayBuffer());
    expect(returnedBytes).toEqual(bytes);
  });

  it('never serves the sibling DuckDB database file, directly or via traversal', async () => {
    // Proves the database file actually exists where both attempts below
    // would target it — without this, a 404 would be meaningless (nothing
    // to accidentally succeed at reaching).
    const dbPath = path.join(server.dataDir, 'pc-parts-flipper.duckdb');
    await writeFile(dbPath, 'not a real duckdb file, just a marker for this test');

    // The real exposure this scoping guards against: @fastify/static's own
    // traversal guard already blocks `../` regardless of how wide `root` is
    // (confirmed by falsifying this test against a `root: DATA_DIR`
    // registration — the traversal-encoded requests below stayed green,
    // i.e. did NOT catch that regression). What a wrong, wider `root`
    // actually exposes is a *direct*, non-traversal request: with
    // `root: DATA_DIR` and `prefix: '/photos/'`, GET
    // /photos/pc-parts-flipper.duckdb resolves straight to
    // DATA_DIR/pc-parts-flipper.duckdb — no `..` needed at all, since the
    // prefix is simply stripped before resolving inside root. This is the
    // assertion that actually goes red under the wrong `root` and is the
    // one this PR's directory scoping exists to prevent.
    const directRes = await fetch(`${server.baseUrl}/photos/pc-parts-flipper.duckdb`);
    expect(directRes.status, `direct request for the DB filename under /photos/ returned ${directRes.status}`).not.toBe(200);
    expect(await directRes.text()).not.toContain('not a real duckdb file');

    // Belt-and-suspenders: traversal-encoded attempts are also asserted,
    // since @fastify/static's own guard should reject these regardless of
    // root breadth — a regression in that guard (not just in this PR's
    // scoping) should still be caught here. Sent via rawPathGet (not
    // fetch()): fetch()/the URL class collapse `..` and `%2e%2e`
    // client-side before the request leaves the process, so a fetch()-based
    // version of this assertion would 404 on a harmless bare
    // `/pc-parts-flipper.duckdb` request and never actually reach
    // @fastify/static's traversal guard at all.
    const traversalPaths = ['/photos/../pc-parts-flipper.duckdb', '/photos/%2e%2e/pc-parts-flipper.duckdb'];
    for (const traversalPath of traversalPaths) {
      const res = await rawPathGet(server.baseUrl, traversalPath);
      expect(res.status, `traversal path ${traversalPath} returned ${res.status}`).not.toBe(200);
      expect(res.text).not.toContain('not a real duckdb file');
    }
  });
});
