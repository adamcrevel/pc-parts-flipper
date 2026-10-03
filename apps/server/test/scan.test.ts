// T7 proof: POST /api/sources/:id/scan (Req 2, 7) as implemented by
// apps/server/src/routes/scan.ts on top of T6's scanService.ts.
//
// Boots a *real* Fastify server in-process (Fastify() + registerErrorHandler
// + registerScanRoutes, listening on a real local port) rather than
// sources.test.ts/listings.test.ts's child-process helpers.ts pattern.
// scanSource resolves the REAL eBay connector via the registry (not an
// injectable fake, per scanService.ts's own design — see its T7/T8 comment),
// so the only seam available to control what a scan "finds" is global
// fetch, the same technique scanService.test.ts's scanAllEligibleSources
// suite and ebayConnector.test.ts already use. Stubbing fetch only works
// when the HTTP client making the real eBay calls lives in this same
// process, which rules out helpers.ts's spawn()-based real server (a
// separate OS process has its own, unstubbed global fetch) — so this suite
// boots its own minimal in-process server instead, following db.test.ts/
// scanService.test.ts's isolated-DuckDB-tmpdir + dynamic-import pattern for
// the database half, and delegating every non-eBay fetch call (i.e. this
// suite's own requests to its local server) straight through to the real
// fetch implementation, captured before stubbing.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type { Source } from '../src/db/index.js';
import type * as ScanRoutesModule from '../src/routes/scan.js';
import type * as ErrorHandlerModule from '../src/error-handler.js';
import type { FastifyInstance } from 'fastify';

// Arbitrary high port distinct from every other suite's TEST_PORT
// (concurrency.test.ts's 34_591, sources.test.ts's 34_597, app-shell.test.ts's
// 34_601, listings.test.ts's 34_602) so this suite can run standalone or
// alongside the rest of the matrix without a port collision.
const TEST_PORT = 34_610;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Real, unstubbed fetch, captured before vi.stubGlobal replaces
// globalThis.fetch below — the mock delegates every non-eBay URL (i.e. this
// suite's own requests against its local server) back through this, so
// stubbing the eBay boundary doesn't also break the HTTP calls the tests
// themselves make.
const realFetch = globalThis.fetch;

let dataDir: string;
let db: typeof DbModule;
let app: FastifyInstance;

// Items the stubbed eBay Browse API search call returns for the *next*
// scan; reset to empty before each test so one test's fixture can never
// leak into another's.
let currentItems: Array<Record<string, unknown>> = [];
let fetchMock = vi.fn();

// Builds one eBay Browse API item_summary fixture, shaped like
// ebayConnector.test.ts's itemFixture, so the connector's mapItemSummary
// has every field it reads.
function itemFixture(itemId: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    itemId,
    title: `Prebuilt ${itemId}`,
    itemWebUrl: `https://www.ebay.com/itm/${itemId}`,
    price: { value: '249.99', currency: 'USD' },
    itemCreationDate: '2026-09-15T18:23:41.000Z',
    ...overrides,
  };
}

// Creates a Source configured for eBay scanning, with a distinct name per
// call so tests never collide on the same row.
async function createScannableSource(name: string): Promise<Source> {
  return db.createSource({
    name,
    platformType: 'ebay',
    url: 'https://example.com/source',
    notes: null,
    connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
  });
}

interface ScanResponse {
  foundCount: number;
  newCount: number;
}

interface ErrorResponse {
  error: { message: string; statusCode: number };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-scan-route-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Dynamic import (same exception as db.test.ts/scanService.test.ts):
  // client.ts's DATA_DIR is computed once, at module-evaluation time, from
  // DUCKDB_DATA_DIR — a static top-of-file import would evaluate before this
  // beforeAll sets the env var and would open the shared dev database
  // instead of this temp dir.
  db = await import('../src/db/index.js');
  const { registerScanRoutes }: typeof ScanRoutesModule = await import('../src/routes/scan.js');
  const { registerErrorHandler }: typeof ErrorHandlerModule = await import('../src/error-handler.js');
  const Fastify = (await import('fastify')).default;

  app = Fastify();
  registerErrorHandler(app);
  await registerScanRoutes(app);
  await app.listen({ port: TEST_PORT, host: '127.0.0.1' });
}, 30_000);

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  currentItems = [];
  fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url instanceof Request ? url.url : url);
    if (urlStr.includes('ebay.com')) {
      if (urlStr.includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-app-token' }), { status: 200 });
      }
      if (urlStr.includes('/buy/browse/v1/item_summary/search')) {
        return new Response(JSON.stringify({ itemSummaries: currentItems }), { status: 200 });
      }
    }
    // Not an eBay call — this suite's own request to its local server.
    // Delegate to the real fetch so the HTTP route under test actually runs.
    return realFetch(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/sources/:id/scan (T7, Req 2, 7)', () => {
  it('scans an eligible Source, creates new Listings, records scan stats, and returns the counts', async () => {
    const source = await createScannableSource('Eligible Source A');
    currentItems = [itemFixture('item-scan-a-1'), itemFixture('item-scan-a-2')];

    const res = await realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' });
    const body = (await res.json()) as ScanResponse;

    expect(res.status).toBe(200);
    expect(body).toEqual({ foundCount: 2, newCount: 2 });

    for (const item of currentItems) {
      const listing = await db.findListingByExternalId(source.id, item.itemId as string);
      expect(listing).not.toBeNull();
      expect(listing!.externalSource).toBe('ebay');
      expect(listing!.title).toBe(item.title);
    }

    const refetchedSource = await db.getSourceById(source.id);
    expect(refetchedSource!.lastScannedAt).not.toBeNull();
    expect(refetchedSource!.lastScanFoundCount).toBe(2);
  });

  it('creates zero additional Listings re-running an identical scan', async () => {
    const source = await createScannableSource('Eligible Source B');
    currentItems = [itemFixture('item-scan-b-1')];

    const first = await realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' });
    expect((await first.json()) as ScanResponse).toEqual({ foundCount: 1, newCount: 1 });

    const second = await realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' });
    const secondBody = (await second.json()) as ScanResponse;

    expect(second.status).toBe(200);
    expect(secondBody).toEqual({ foundCount: 1, newCount: 0 });

    const listings = await db.listListings({ sourceId: source.id });
    expect(listings).toHaveLength(1);
  });

  it('returns 400 for a Source with no connectorConfig', async () => {
    const source = await db.createSource({
      name: 'No Connector Config Source',
      platformType: 'ebay',
      url: null,
      notes: null,
      connectorConfig: null,
    });

    const res = await realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/connector configuration/i);
  });

  it('returns 400 for an inactive Source', async () => {
    const source = await createScannableSource('Inactive Source');
    await db.updateSource(source.id, { active: false });

    const res = await realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/not active/i);
  });

  it('returns 400 for a non-ebay platformType Source', async () => {
    const source = await db.createSource({
      name: 'Facebook Marketplace Source',
      platformType: 'facebook_marketplace',
      url: null,
      notes: null,
      connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
    });

    const res = await realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/no automated-scan connector/i);
  });

  it('returns 404 for a nonexistent Source id', async () => {
    const res = await realFetch(`${BASE_URL}/api/sources/00000000-0000-0000-0000-000000000000/scan`, {
      method: 'POST',
    });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(404);
    expect(body.error.message).toMatch(/not found/i);
  });

  it('never creates two Listings for the same external item id under genuinely concurrent scans', async () => {
    const source = await createScannableSource('Concurrent Scan Source');
    // Both concurrent scans see the same single candidate item id, exactly
    // the race importCandidateIfNew's unique-constraint-violation catch
    // (scanService.ts) exists to close.
    currentItems = [itemFixture('item-concurrent-1')];

    // Fired together via Promise.all — genuine concurrency, not two
    // sequential awaits dressed up as parallel (per T14's concurrency.test.ts
    // standing-check convention).
    const [resA, resB] = await Promise.all([
      realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' }),
      realFetch(`${BASE_URL}/api/sources/${source.id}/scan`, { method: 'POST' }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const listings = await db.listListings({ sourceId: source.id });
    const matching = listings.filter((l) => l.externalItemId === 'item-concurrent-1');
    expect(matching).toHaveLength(1);

    // Standing check: two racing scans must never corrupt the Source's own
    // scan-recency bookkeeping either — both concurrent calls to
    // updateSourceScanStats race on the same row, so confirm the row still
    // lands on one coherent, well-formed pair of values (a real ISO
    // timestamp and a small non-negative count) rather than null/NaN from a
    // torn write.
    const refetchedSource = await db.getSourceById(source.id);
    expect(refetchedSource!.lastScannedAt).not.toBeNull();
    expect(() => new Date(refetchedSource!.lastScannedAt as string).toISOString()).not.toThrow();
    expect([0, 1]).toContain(refetchedSource!.lastScanFoundCount);
  });
});
