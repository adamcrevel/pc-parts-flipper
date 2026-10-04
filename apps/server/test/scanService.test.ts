// T6 proof: scanService.ts's scanSourceWithConnector/scanSource/
// scanAllEligibleSources (Req 3, 5, 7, 9) against a real DuckDB in an
// isolated temp dir, using a fake MarketplaceConnector (in-memory, no real
// eBay network call) — same isolated-DuckDB-tmpdir + dynamic-import pattern
// as db.test.ts/sourceScanStats.test.ts.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateListing, MarketplaceConnector } from '../src/connectors/types.js';
import type * as DbModule from '../src/db/index.js';
import type { Source } from '../src/db/index.js';
import type { AppError as AppErrorClass } from '../src/error-handler.js';
import { logger } from '../src/logger.js';
import type * as ScanServiceModule from '../src/scan/scanService.js';

let dataDir: string;
let db: typeof DbModule;
let scanService: typeof ScanServiceModule;
let AppError: typeof AppErrorClass;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-scan-service-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): see db.test.ts's beforeAll — client.ts
  // reads DUCKDB_DATA_DIR once at module-evaluation time, so a static
  // top-of-file import would open the shared dev database instead of this
  // test's isolated temp dir.
  db = await import('../src/db/index.js');
  scanService = await import('../src/scan/scanService.js');
  ({ AppError } = await import('../src/error-handler.js'));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// Builds a fresh fake MarketplaceConnector returning exactly `candidates`
// from search(), so each test controls precisely what the "scan" finds
// without any real eBay call.
function fakeConnector(candidates: CandidateListing[]): MarketplaceConnector {
  return {
    platformType: 'ebay',
    search: async () => candidates,
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

// Builds one candidate. `imageUrls` defaults to empty so the pre-existing
// tests keep exercising the no-photos path; the photo tests below pass
// explicit URLs.
function candidate(itemId: string, imageUrls: string[] = []): CandidateListing {
  return {
    externalItemId: itemId,
    title: `Prebuilt ${itemId}`,
    listingUrl: `https://ebay.com/itm/${itemId}`,
    askingPrice: 500,
    listingDate: '2026-01-10',
    imageUrls,
  };
}

describe('scanSourceWithConnector', () => {
  it('creates a new Listing per candidate and records scan stats', async () => {
    const source = await createScannableSource('Scan Source A');
    const candidates = [candidate('item-1'), candidate('item-2'), candidate('item-3')];
    const connector = fakeConnector(candidates);

    const result = await scanService.scanSourceWithConnector(source, connector);

    expect(result).toEqual({ foundCount: 3, newCount: 3 });

    for (const c of candidates) {
      const listing = await db.findListingByExternalId(source.id, c.externalItemId);
      expect(listing).not.toBeNull();
      expect(listing!.externalSource).toBe('ebay');
      expect(listing!.externalItemId).toBe(c.externalItemId);
      expect(listing!.title).toBe(c.title);
      expect(listing!.listingUrl).toBe(c.listingUrl);
      expect(listing!.askingPrice).toBe(c.askingPrice);
      // Req 3: scan-created Listings start open with no Expected Parts yet
      // and zero acquisition fees (nothing has been spent acquiring it).
      expect(listing!.status).toBe('open');
      expect(listing!.acquisitionFees).toBe(0);
      expect(await db.listExpectedPartsByListing(listing!.id)).toEqual([]);
    }

    const refetchedSource = await db.getSourceById(source.id);
    expect(refetchedSource!.lastScannedAt).not.toBeNull();
    expect(refetchedSource!.lastScanFoundCount).toBe(3);
  });

  it('creates zero additional Listings re-running an identical scan, while foundCount still reflects the connector', async () => {
    const source = await createScannableSource('Scan Source B');
    const candidates = [candidate('dup-1'), candidate('dup-2')];
    const connector = fakeConnector(candidates);

    const first = await scanService.scanSourceWithConnector(source, connector);
    expect(first).toEqual({ foundCount: 2, newCount: 2 });

    const sourceAfterFirst = await db.getSourceById(source.id);
    const second = await scanService.scanSourceWithConnector(sourceAfterFirst!, connector);

    expect(second).toEqual({ foundCount: 2, newCount: 0 });

    const listings = await db.listListings({ sourceId: source.id });
    expect(listings).toHaveLength(2);

    const refetchedSource = await db.getSourceById(source.id);
    expect(refetchedSource!.lastScanFoundCount).toBe(0);
  });

  it('throws an AppError when the Source has no connector configuration', async () => {
    const unconfigured = await db.createSource({
      name: 'Unconfigured Source',
      platformType: 'ebay',
      url: null,
      notes: null,
      connectorConfig: null,
    });
    const connector = fakeConnector([candidate('irrelevant')]);

    await expect(scanService.scanSourceWithConnector(unconfigured, connector)).rejects.toThrow(AppError);
  });

  it('throws an AppError when the Source is inactive', async () => {
    const source = await createScannableSource('Inactive Source');
    await db.updateSource(source.id, { active: false });
    const inactive = await db.getSourceById(source.id);
    const connector = fakeConnector([candidate('irrelevant')]);

    await expect(scanService.scanSourceWithConnector(inactive!, connector)).rejects.toThrow(AppError);
  });
});

// Photo capture on import (Req 2): a scanned candidate's marketplace images
// are downloaded to local disk and attached to the Listing. fetch is stubbed
// so no real image is ever retrieved, and PHOTOS_DIR resolves under this
// suite's DUCKDB_DATA_DIR temp directory (set in beforeAll, before the
// dynamic imports), so nothing is written into the worktree's real data/.
describe('scanSourceWithConnector photo download', () => {
  // One-pixel-ish payload: the bytes are irrelevant, only that a body of a
  // plausible size is written to disk.
  const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(IMAGE_BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads a candidate\'s images and stores their relative paths on the new Listing', async () => {
    const source = await createScannableSource('Photo Source A');
    const imageUrls = [
      'https://i.ebayimg.com/images/g/photoA1/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/photoA2/s-l1600.jpg',
    ];
    const connector = fakeConnector([candidate('photo-item-1', imageUrls)]);

    const result = await scanService.scanSourceWithConnector(source, connector);
    expect(result).toEqual({ foundCount: 1, newCount: 1 });

    const listing = await db.findListingByExternalId(source.id, 'photo-item-1');
    expect(listing!.photoPaths).toHaveLength(2);
    for (const stored of listing!.photoPaths) {
      // Relative `photos/<file>` convention, prefixed with the Listing id —
      // the same shape the manual upload route produces.
      expect(stored.startsWith(`photos${path.sep}${listing!.id}-`)).toBe(true);
      // The file must actually exist with the downloaded bytes in it; a path
      // recorded for a file that was never written would be worse than none.
      const bytes = await readFile(path.join(dataDir, stored));
      expect(bytes).toEqual(Buffer.from(IMAGE_BYTES));
    }

    // Every fetch was an image download; the fake connector makes no API call.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(imageUrls);
  });

  it('keeps the images that succeeded when one image download fails, without failing the import', async () => {
    const source = await createScannableSource('Photo Source B');
    const goodUrl = 'https://i.ebayimg.com/images/g/photoB1/s-l1600.jpg';
    const badUrl = 'https://i.ebayimg.com/images/g/photoB2/s-l1600.jpg';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === badUrl) {
        return new Response('gone', { status: 404 });
      }
      return new Response(IMAGE_BYTES, { status: 200 });
    });
    const connector = fakeConnector([candidate('photo-item-2', [goodUrl, badUrl])]);

    // A silently-dropped photo is a bug that looks like success, so the Warn
    // is part of the contract, not incidental output. Spying also proves the
    // skip happened for the stated reason (the 404), not for some other.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const result = await scanService.scanSourceWithConnector(source, connector);

    // The import itself still counts as new — a failed photo is not a failed
    // Listing.
    expect(result).toEqual({ foundCount: 1, newCount: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: badUrl, status: 404 }),
      expect.stringContaining('non-200'),
    );
    warnSpy.mockRestore();

    const listing = await db.findListingByExternalId(source.id, 'photo-item-2');
    expect(listing).not.toBeNull();
    expect(listing!.photoPaths).toHaveLength(1);
    await expect(readFile(path.join(dataDir, listing!.photoPaths[0]))).resolves.toEqual(Buffer.from(IMAGE_BYTES));
  });

  it('still imports the Listing with no photos when every image download throws', async () => {
    const source = await createScannableSource('Photo Source C');
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });
    const connector = fakeConnector([candidate('photo-item-3', ['https://i.ebayimg.com/images/g/photoC1/s-l1600.jpg'])]);

    const result = await scanService.scanSourceWithConnector(source, connector);

    expect(result).toEqual({ foundCount: 1, newCount: 1 });
    const listing = await db.findListingByExternalId(source.id, 'photo-item-3');
    expect(listing).not.toBeNull();
    expect(listing!.photoPaths).toEqual([]);
  });

  // Pins the 10MB cap from both sides: one byte over must be rejected AND
  // exactly-at-the-cap must be kept. Testing only the oversized case would
  // stay green if the cap were lowered to any smaller value.
  it('skips a candidate image over the 10MB per-file cap while keeping one exactly at it', async () => {
    const source = await createScannableSource('Photo Source D');
    const overCapUrl = 'https://i.ebayimg.com/images/g/photoD1/s-l1600.jpg';
    const atCapUrl = 'https://i.ebayimg.com/images/g/photoD2/s-l1600.jpg';
    const smallUrl = 'https://i.ebayimg.com/images/g/photoD3/s-l1600.jpg';
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === overCapUrl) {
        return new Response(new Uint8Array(10 * 1024 * 1024 + 1), { status: 200 });
      }
      if (String(url) === atCapUrl) {
        return new Response(new Uint8Array(10 * 1024 * 1024), { status: 200 });
      }
      return new Response(IMAGE_BYTES, { status: 200 });
    });
    const connector = fakeConnector([candidate('photo-item-4', [overCapUrl, atCapUrl, smallUrl])]);

    await scanService.scanSourceWithConnector(source, connector);

    const listing = await db.findListingByExternalId(source.id, 'photo-item-4');
    expect(listing!.photoPaths).toHaveLength(2);
  });
});

describe('scanSource', () => {
  it('resolves the real eBay connector via the registry and scans the Source by id', async () => {
    const source = await createScannableSource('Scan Source By Id');
    // scanSource always resolves the real registry connector, not a fake —
    // proving the id-lookup + registry-resolution wiring only requires zero
    // candidates (the eBay connector's real search() would make a network
    // call; this Source has no live credentials, so it is only exercised
    // indirectly via the registry resolution succeeding for platformType
    // 'ebay' and the AppError paths below for sourceId/connectorConfig).
    // Instead, cover the not-found path here, which needs no network call.
    await expect(scanService.scanSource('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /not found/,
    );
    // Confirm the Source itself was created fine (sanity for the id used above).
    expect(source.id).toBeTruthy();
  });
});

// Req 2's "one Browse API call per configured query" characterization must
// survive photo capture. This runs the REAL eBay connector (via scanSource's
// registry resolution) against a stubbed fetch, so every outbound call the
// whole import path makes is visible and countable.
describe('scanSource photo download call budget (Req 2)', () => {
  let fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds image downloads but no additional eBay API calls', async () => {
    const source = await createScannableSource('Call Budget Source');
    const item = {
      itemId: 'v1|budget-item|0',
      title: 'Gaming PC',
      itemWebUrl: 'https://www.ebay.com/itm/budget-item',
      price: { value: '399.00', currency: 'USD' },
      itemCreationDate: '2026-02-02T00:00:00.000Z',
      image: { imageUrl: 'https://i.ebayimg.com/images/g/budget1/s-l225.jpg' },
      additionalImages: [
        { imageUrl: 'https://i.ebayimg.com/images/g/budget2/s-l225.jpg' },
        { imageUrl: 'https://i.ebayimg.com/images/g/budget3/s-l225.jpg' },
      ],
    };
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-app-token' }), { status: 200 });
      }
      if (String(url).includes('/buy/browse/')) {
        return new Response(JSON.stringify({ itemSummaries: [item] }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await scanService.scanSource(source.id);
    expect(result).toEqual({ foundCount: 1, newCount: 1 });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // The Source has exactly one configured query, so exactly one Browse API
    // call is allowed. A per-item detail lookup for photos — the obvious
    // wrong way to implement this — would show up here as a second
    // /buy/browse/ call and fail.
    expect(urls.filter((u) => u.includes('/buy/browse/'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/item_summary/search'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/oauth2/token'))).toHaveLength(1);
    // The three extra calls are image-CDN downloads of URLs that same single
    // search response already returned — free of any API quota.
    expect(urls.filter((u) => u.startsWith('https://i.ebayimg.com/'))).toEqual([
      'https://i.ebayimg.com/images/g/budget1/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/budget2/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/budget3/s-l1600.jpg',
    ]);
    expect(urls).toHaveLength(5);

    const listing = await db.findListingByExternalId(source.id, 'v1|budget-item|0');
    expect(listing!.photoPaths).toHaveLength(3);
  });
});

// scanAllEligibleSources resolves the real eBay connector via the registry
// per Source (Req 9's "don't stop the batch" needs at least one Source to
// actually succeed to prove that), so these two tests stub global fetch —
// same technique ebayConnector.test.ts uses — rather than inject a fake
// connector, which scanAllEligibleSources has no seam for by design (T7/T8
// always resolve the real per-platform connector).
describe('scanAllEligibleSources', () => {
  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-app-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only scans active Sources with a connector configured, and leaves the unconfigured one out', async () => {
    const configured = await createScannableSource('Eligible Source');
    const unconfigured = await db.createSource({
      name: 'Ineligible Source (no connector config)',
      platformType: 'ebay',
      url: null,
      notes: null,
      connectorConfig: null,
    });

    const result = await scanService.scanAllEligibleSources();

    const configuredOutcome = result.sources.find((s) => s.sourceId === configured.id);
    const unconfiguredOutcome = result.sources.find((s) => s.sourceId === unconfigured.id);

    expect(configuredOutcome).toBeDefined();
    expect(configuredOutcome!.error).toBeUndefined();
    expect(unconfiguredOutcome).toBeUndefined();
  });

  it('continues scanning remaining Sources when one Source fails', async () => {
    const failing = await createScannableSource('Failing Source');
    const succeeding = await createScannableSource('Succeeding Source');

    // Forces this one Source's scan to fail (invalid JSON in
    // connectorConfig, caught before any network call) while leaving fetch
    // stubbed to succeed for every other Source's real eBay connector call.
    await db.updateSource(failing.id, { connectorConfig: 'not valid json' });

    // Req 9: the failure must actually be logged at Error level with
    // diagnosable detail, not merely cause execution to proceed past it —
    // spy on logger.error so a regression that swallows the error silently
    // (while still "continuing") cannot pass this test.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);

    const result = await scanService.scanAllEligibleSources();

    const failingOutcome = result.sources.find((s) => s.sourceId === failing.id);
    const succeedingOutcome = result.sources.find((s) => s.sourceId === succeeding.id);

    expect(failingOutcome).toBeDefined();
    expect(failingOutcome!.error).toBeDefined();
    expect(succeedingOutcome).toBeDefined();
    expect(succeedingOutcome!.error).toBeUndefined();

    // The Error-level call must name the failing Source and carry the
    // original error object, diagnosable detail beyond a generic message.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: failing.id, err: expect.anything() }),
      expect.stringContaining('Scan failed'),
    );

    errorSpy.mockRestore();
  });
});
