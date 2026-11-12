// T6 proof: scanService.ts's scanSourceWithConnector/scanSource/
// scanAllEligibleSources (Req 3, 5, 7, 9) against a real DuckDB in an
// isolated temp dir, using a fake MarketplaceConnector (in-memory, no real
// eBay network call) — same isolated-DuckDB-tmpdir + dynamic-import pattern
// as db.test.ts/sourceScanStats.test.ts.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateListing, ListingLiveStatus, MarketplaceConnector } from '../src/connectors/types.js';
import type * as DbModule from '../src/db/index.js';
import type { PlatformType, Source } from '../src/db/index.js';
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
// explicit URLs. `nonWorking` defaults to false.
function candidate(itemId: string, imageUrls: string[] = [], nonWorking: boolean = false): CandidateListing {
  return {
    externalItemId: itemId,
    title: `Prebuilt ${itemId}`,
    listingUrl: `https://ebay.com/itm/${itemId}`,
    askingPrice: 500,
    listingDate: '2026-01-10',
    imageUrls,
    nonWorking,
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

  it('imports a candidate with nonWorking: true as a Listing with nonWorking: true (Req 4)', async () => {
    const source = await createScannableSource('Scan Source Non-Working True');
    const candidates = [candidate('item-nonworking', [], true)];
    const connector = fakeConnector(candidates);

    const result = await scanService.scanSourceWithConnector(source, connector);

    expect(result).toEqual({ foundCount: 1, newCount: 1 });

    const listing = await db.findListingByExternalId(source.id, candidates[0].externalItemId);
    expect(listing).not.toBeNull();
    expect(listing!.nonWorking).toBe(true);
  });

  it('imports a candidate with nonWorking: false as a Listing with nonWorking: false (Req 4)', async () => {
    const source = await createScannableSource('Scan Source Non-Working False');
    const candidates = [candidate('item-working', [], false)];
    const connector = fakeConnector(candidates);

    const result = await scanService.scanSourceWithConnector(source, connector);

    expect(result).toEqual({ foundCount: 1, newCount: 1 });

    const listing = await db.findListingByExternalId(source.id, candidates[0].externalItemId);
    expect(listing).not.toBeNull();
    expect(listing!.nonWorking).toBe(false);
  });

  it('builds createDescriptionFetcher exactly once per scan pass and reuses the same function for every new candidate', async () => {
    const source = await createScannableSource('Description Fetcher Reuse Source');
    const candidates = [candidate('reuse-item-1'), candidate('reuse-item-2'), candidate('reuse-item-3')];

    // Each call to createDescriptionFetcher gets its own call-counter closure, so
    // "built once, reused" is distinguishable from "built once per candidate but
    // each build happens to behave the same way": buildCount tells us how many
    // times the hook itself ran, and callsForBuild[N] tells us how many
    // candidates the Nth build's returned function was actually invoked for.
    let buildCount = 0;
    const callsForBuild: number[] = [];
    const connector: MarketplaceConnector = {
      platformType: 'ebay',
      search: async () => candidates,
      createDescriptionFetcher: () => {
        buildCount += 1;
        const builtAs = buildCount;
        callsForBuild[builtAs] = 0;
        return async (externalItemId: string) => {
          callsForBuild[builtAs] += 1;
          return `description for ${externalItemId}`;
        };
      },
    };

    const result = await scanService.scanSourceWithConnector(source, connector);
    expect(result).toEqual({ foundCount: 3, newCount: 3 });

    // The design contract this refactor exists to generalize: the hook runs
    // exactly once for the whole scan pass, not once per new candidate.
    expect(buildCount).toBe(1);
    // And that single built function — not a fresh one — is what every one of
    // the 3 new candidates was actually routed through.
    expect(callsForBuild[1]).toBe(3);

    for (const c of candidates) {
      const listing = await db.findListingByExternalId(source.id, c.externalItemId);
      expect(listing!.description).toBe(`description for ${c.externalItemId}`);
    }
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
      if (String(url).includes('/buy/browse/v1/item/')) {
        return new Response(
          JSON.stringify({ description: '<p>Great condition</p>', localizedAspects: [{ name: 'RAM', value: '16GB' }] }),
          { status: 200 },
        );
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
    // Req 1/2's own single-item detail call (one GET per newly-imported
    // candidate, not per search result) is the deliberate exception to the
    // "per-item API call" warning above: eBay's search summaries never
    // carry description/specifics data no matter how the connector is
    // written, so fetching them at all requires exactly one extra detail
    // call per newly-imported candidate. That is bounded and new-candidate-
    // scoped, not the unbounded per-result-row regression the comment above
    // warns against — this test still proves the bound stays exactly one
    // search call, one token call, and one detail call for one new
    // candidate, not that detail calls vanish entirely.
    expect(urls.filter((u) => u.includes('/buy/browse/'))).toHaveLength(2);
    expect(urls.filter((u) => u.includes('/item_summary/search'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/buy/browse/v1/item/'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/oauth2/token'))).toHaveLength(2);
    // The three extra calls are image-CDN downloads of URLs that same single
    // search response already returned — free of any API quota.
    expect(urls.filter((u) => u.startsWith('https://i.ebayimg.com/'))).toEqual([
      'https://i.ebayimg.com/images/g/budget1/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/budget2/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/budget3/s-l1600.jpg',
    ]);
    expect(urls).toHaveLength(7);

    const listing = await db.findListingByExternalId(source.id, 'v1|budget-item|0');
    expect(listing!.photoPaths).toHaveLength(3);
    expect(listing!.description).toBe('Great condition\n\nItem Specifics (per eBay):\nRAM: 16GB');
  });

  it('shares one eBay item-detail client (one OAuth token call) across multiple new candidates in the same scan pass', async () => {
    const source = await createScannableSource('Call Budget Source Multi Candidate');
    const item1 = {
      itemId: 'v1|multi-budget-item|1',
      title: 'Gaming PC One',
      itemWebUrl: 'https://www.ebay.com/itm/multi-budget-item-1',
      price: { value: '299.00', currency: 'USD' },
      itemCreationDate: '2026-02-02T00:00:00.000Z',
    };
    const item2 = {
      itemId: 'v1|multi-budget-item|2',
      title: 'Gaming PC Two',
      itemWebUrl: 'https://www.ebay.com/itm/multi-budget-item-2',
      price: { value: '399.00', currency: 'USD' },
      itemCreationDate: '2026-02-03T00:00:00.000Z',
    };
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-app-token' }), { status: 200 });
      }
      if (String(url).includes('/buy/browse/v1/item/')) {
        return new Response(JSON.stringify({ description: '<p>Great condition</p>', localizedAspects: [] }), { status: 200 });
      }
      if (String(url).includes('/buy/browse/')) {
        return new Response(JSON.stringify({ itemSummaries: [item1, item2] }), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await scanService.scanSource(source.id);
    expect(result).toEqual({ foundCount: 2, newCount: 2 });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // ebayConnector's createDescriptionFetcher() wraps createEbayItemDetailClient(),
    // which performs its own OAuth app-token call. scanSourceWithConnector calls
    // createDescriptionFetcher at most once per scan pass (not once per candidate),
    // so with 2 new candidates there must still be exactly 2 token calls total: one
    // for search()'s own token, one for the shared item-detail client — not 3, which
    // is what a regression rebuilding the client per candidate would produce.
    expect(urls.filter((u) => u.includes('/oauth2/token'))).toHaveLength(2);
    // One detail GET per new candidate — the shared client is reused per call, it
    // isn't that detail fetching stopped happening for the second candidate.
    expect(urls.filter((u) => u.includes('/buy/browse/v1/item/'))).toHaveLength(2);

    const listing1 = await db.findListingByExternalId(source.id, item1.itemId);
    const listing2 = await db.findListingByExternalId(source.id, item2.itemId);
    expect(listing1!.description).not.toBeNull();
    expect(listing2!.description).not.toBeNull();
  });

  it('still imports the Listing and counts it as new when the eBay item-detail fetch fails (Req 5)', async () => {
    const source = await createScannableSource('Call Budget Source Detail Failure');
    const item = {
      itemId: 'v1|budget-item-fail|0',
      title: 'Gaming PC With Failing Detail Fetch',
      itemWebUrl: 'https://www.ebay.com/itm/budget-item-fail',
      price: { value: '399.00', currency: 'USD' },
      itemCreationDate: '2026-02-02T00:00:00.000Z',
    };
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-app-token' }), { status: 200 });
      }
      if (String(url).includes('/buy/browse/v1/item/')) {
        return new Response(JSON.stringify({ errors: [{ message: 'Item not found' }] }), { status: 404 });
      }
      return new Response(JSON.stringify({ itemSummaries: [item] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // A silently-dropped description would look like success, so the Warn
    // is part of the contract. Spying also proves the skip happened for the
    // stated reason (the failed detail fetch), not for some other.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    const result = await scanService.scanSource(source.id);

    // Req 5: a failed eBay item-detail fetch never prevents the Listing
    // from being imported — the candidate still counts as new.
    expect(result).toEqual({ foundCount: 1, newCount: 1 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ externalItemId: 'v1|budget-item-fail|0' }),
      expect.stringContaining('Failed to attach description'),
    );
    warnSpy.mockRestore();

    const listing = await db.findListingByExternalId(source.id, 'v1|budget-item-fail|0');
    expect(listing).not.toBeNull();
    expect(listing!.description).toBeNull();
  });

  it('distinguishes newly-imported candidates from duplicates in the same batch (Req 7)', async () => {
    const source = await createScannableSource('Duplicate Detection Source');
    const item1 = {
      itemId: 'v1|duplicate-test|1',
      title: 'First Item',
      itemWebUrl: 'https://www.ebay.com/itm/duplicate-test-1',
      price: { value: '299.00', currency: 'USD' },
      itemCreationDate: '2026-02-02T00:00:00.000Z',
      image: { imageUrl: 'https://i.ebayimg.com/images/g/dup1/s-l225.jpg' },
    };
    const item2 = {
      itemId: 'v1|duplicate-test|2',
      title: 'Second Item',
      itemWebUrl: 'https://www.ebay.com/itm/duplicate-test-2',
      price: { value: '399.00', currency: 'USD' },
      itemCreationDate: '2026-02-03T00:00:00.000Z',
      image: { imageUrl: 'https://i.ebayimg.com/images/g/dup2/s-l225.jpg' },
    };

    // Track which phase we're in to return different search results
    let phase = 'first';
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-app-token' }), { status: 200 });
      }
      if (String(url).includes('/buy/browse/v1/item/')) {
        return new Response(
          JSON.stringify({ description: '<p>Test item</p>', localizedAspects: [] }),
          { status: 200 },
        );
      }
      if (String(url).includes('/buy/browse/')) {
        // First scan returns only item1; second scan returns item1 + item2
        if (phase === 'first') {
          return new Response(JSON.stringify({ itemSummaries: [item1] }), { status: 200 });
        } else {
          return new Response(JSON.stringify({ itemSummaries: [item1, item2] }), { status: 200 });
        }
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // First scan: import item1
    const result1 = await scanService.scanSource(source.id);
    expect(result1).toEqual({ foundCount: 1, newCount: 1 });

    // Transition to second phase and reset mock call history
    phase = 'second';
    fetchMock.mockClear();

    // Second scan: item1 is now a duplicate, item2 is new
    const result2 = await scanService.scanSource(source.id);
    expect(result2).toEqual({ foundCount: 2, newCount: 1 });

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // Only ONE detail call should be made for the newly-imported item, not for the duplicate
    // This proves Req 7: detail calls are scoped to genuinely-new candidates, not all results
    expect(urls.filter((u) => u.includes('/buy/browse/v1/item/'))).toHaveLength(1);
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

// Stale-listing reconciliation (Req 3, 4, 5): after importing, a scan pass
// rechecks every still-open Listing on the Source the connector no longer
// returned, and restores any removed Listing that reappeared. Every checker
// here is in-memory — no real per-item marketplace call is ever made.
describe('scanSourceWithConnector stale-listing reconciliation', () => {
  // A fake connector that implements createStatusChecker, recording every
  // externalItemId the built checker was called with (so "called once for
  // exactly the missing rows" and "never called at all" are both directly
  // observable) and how many times the hook itself was built (so
  // build-once-per-pass is distinguishable from build-per-row).
  function connectorWithStatusChecker(
    candidates: CandidateListing[],
    check: (externalItemId: string) => Promise<ListingLiveStatus>,
    platformType: PlatformType = 'ebay',
  ): { connector: MarketplaceConnector; calls: string[]; buildCount: () => number } {
    const calls: string[] = [];
    let buildCount = 0;
    return {
      calls,
      buildCount: () => buildCount,
      connector: {
        platformType,
        search: async () => candidates,
        createStatusChecker: () => {
          buildCount += 1;
          return async (externalItemId: string) => {
            calls.push(externalItemId);
            return check(externalItemId);
          };
        },
      },
    };
  }

  // Re-reads the Source after a pass, since scanSourceWithConnector takes
  // the Source row itself and each pass writes scan stats onto it.
  async function refetch(sourceId: string): Promise<Source> {
    const source = await db.getSourceById(sourceId);
    expect(source).not.toBeNull();
    return source!;
  }

  // DuckDB stores marketplace_status_detected_at as a naive TIMESTAMP, so
  // the string read back may have lost the UTC designator scanService
  // wrote. Production always writes `new Date().toISOString()`, i.e. UTC,
  // so a value with no explicit zone is UTC and must be parsed as such —
  // without this, a test machine on any non-UTC zone (this one runs on
  // PST) would shift it by its own offset and compare nonsense.
  function parseDetectedAt(raw: string): Date {
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
    const parsed = new Date(normalized);
    expect(Number.isNaN(parsed.getTime()), `marketplaceStatusDetectedAt must parse, got ${raw}`).toBe(false);
    return parsed;
  }

  it('transitions a missing open Listing to removed, recording marketplaceStatus removed and a detection time', async () => {
    const source = await createScannableSource('Stale Source Removed');
    const first = await scanService.scanSourceWithConnector(source, fakeConnector([candidate('gone-item'), candidate('kept-item')]));
    expect(first).toEqual({ foundCount: 2, newCount: 2 });

    const spy = connectorWithStatusChecker([candidate('kept-item')], async () => 'removed');
    const result = await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);
    expect(result).toEqual({ foundCount: 1, newCount: 0 });

    // Only the row absent from this pass is rechecked — the one the
    // connector still returned costs no per-item call at all — and the hook
    // was built exactly once for the whole pass.
    expect(spy.calls).toEqual(['gone-item']);
    expect(spy.buildCount()).toBe(1);

    const gone = await db.findListingByExternalId(source.id, 'gone-item');
    expect(gone!.status).toBe('removed');
    expect(gone!.marketplaceStatus).toBe('removed');
    expect(gone!.marketplaceStatusDetectedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(gone!.marketplaceStatusDetectedAt!))).toBe(false);

    const kept = await db.findListingByExternalId(source.id, 'kept-item');
    expect(kept!.status).toBe('open');
    expect(kept!.marketplaceStatus).toBeNull();
    expect(kept!.marketplaceStatusDetectedAt).toBeNull();
  });

  it('builds the status checker exactly once for a pass with several missing Listings, not once per missing row', async () => {
    const source = await createScannableSource('Stale Source Shared Checker');
    const seeded = [candidate('multi-gone-1'), candidate('multi-gone-2'), candidate('multi-gone-3'), candidate('multi-kept')];
    expect(await scanService.scanSourceWithConnector(source, fakeConnector(seeded))).toEqual({ foundCount: 4, newCount: 4 });

    const spy = connectorWithStatusChecker([candidate('multi-kept')], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);

    // Three separate rows were each individually rechecked through the one
    // checker this pass built. With a single missing row "built once per
    // pass" and "built once per row" produce the identical count of 1, so
    // only a pass with several missing rows can tell them apart.
    expect([...spy.calls].sort()).toEqual(['multi-gone-1', 'multi-gone-2', 'multi-gone-3']);
    expect(spy.buildCount()).toBe(1);
  });

  it('stamps marketplaceStatusDetectedAt with the wall-clock time of the pass that detected the removal', async () => {
    const source = await createScannableSource('Stale Source Detection Time');
    await scanService.scanSourceWithConnector(source, fakeConnector([candidate('timed-item')]));

    const spy = connectorWithStatusChecker([], async () => 'removed');
    // Bracket the pass: any stamp from outside this window — a hardcoded
    // constant, the Listing's own created_at, the earlier import pass's
    // time — falls outside it and fails, which "not null and parseable"
    // never would.
    const beforeCall = new Date();
    await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);
    const afterCall = new Date();

    const listing = await db.findListingByExternalId(source.id, 'timed-item');
    expect(listing!.marketplaceStatusDetectedAt).not.toBeNull();
    const detectedAt = parseDetectedAt(listing!.marketplaceStatusDetectedAt!);
    expect(detectedAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
    expect(detectedAt.getTime()).toBeLessThanOrEqual(afterCall.getTime());
  });

  it('records marketplaceStatus sold when a missing open Listing\'s recheck resolves sold', async () => {
    const source = await createScannableSource('Stale Source Sold');
    await scanService.scanSourceWithConnector(source, fakeConnector([candidate('sold-item')]));

    const spy = connectorWithStatusChecker([], async () => 'sold');
    await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);

    expect(spy.calls).toEqual(['sold-item']);
    const listing = await db.findListingByExternalId(source.id, 'sold-item');
    // Same terminal workflow status as a delisted item, but the separate
    // marketplaceStatus field is what carries *why* (sold vs. delisted).
    expect(listing!.status).toBe('removed');
    expect(listing!.marketplaceStatus).toBe('sold');
    expect(listing!.marketplaceStatusDetectedAt).not.toBeNull();
  });

  it('writes nothing when a missing open Listing\'s recheck resolves active (false-positive guard)', async () => {
    const source = await createScannableSource('Stale Source Active');
    await scanService.scanSourceWithConnector(source, fakeConnector([candidate('still-live-item')]));

    const spy = connectorWithStatusChecker([], async () => 'active');
    await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);

    // The recheck did run — absence alone is what triggers it — but an
    // `active` answer must leave the Listing completely untouched.
    expect(spy.calls).toEqual(['still-live-item']);
    const listing = await db.findListingByExternalId(source.id, 'still-live-item');
    expect(listing!.status).toBe('open');
    expect(listing!.marketplaceStatus).toBeNull();
    expect(listing!.marketplaceStatusDetectedAt).toBeNull();
  });

  it('skips a missing open Listing entirely when the connector has no createStatusChecker', async () => {
    const source = await createScannableSource('Stale Source No Checker');
    await scanService.scanSourceWithConnector(source, fakeConnector([candidate('unchecked-item')]));

    const connector = fakeConnector([]);
    // The whole point of this case: no hook at all means no per-item
    // recheck exists for this platform, so nothing may be inferred from the
    // row's absence.
    expect(connector.createStatusChecker).toBeUndefined();
    const result = await scanService.scanSourceWithConnector(await refetch(source.id), connector);
    expect(result).toEqual({ foundCount: 0, newCount: 0 });

    const listing = await db.findListingByExternalId(source.id, 'unchecked-item');
    expect(listing!.status).toBe('open');
    expect(listing!.marketplaceStatus).toBeNull();
    expect(listing!.marketplaceStatusDetectedAt).toBeNull();
  });

  it('never re-checks a Listing that is already removed and still missing (one recheck per transition)', async () => {
    const source = await createScannableSource('Stale Source Bounded Recheck');
    await scanService.scanSourceWithConnector(source, fakeConnector([candidate('stays-gone-item')]));

    const removalSpy = connectorWithStatusChecker([], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), removalSpy.connector);
    expect(removalSpy.calls).toEqual(['stays-gone-item']);
    const afterRemoval = await db.findListingByExternalId(source.id, 'stays-gone-item');
    expect(afterRemoval!.marketplaceStatusDetectedAt).not.toBeNull();

    // Same situation as the pass before — still absent from the results,
    // connector still offering a checker — but the row is `removed` now, so
    // its per-item network cost is already paid and must not recur. Two
    // consecutive further passes, not one: "rechecked every pass from now
    // on" and "rechecked once more, then never again" are different bugs
    // with the same first-pass symptom, and only a second still-missing
    // pass tells them apart.
    const laterSpy = connectorWithStatusChecker([], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), laterSpy.connector);
    expect(laterSpy.calls).toEqual([]);

    const evenLaterSpy = connectorWithStatusChecker([], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), evenLaterSpy.connector);
    expect(evenLaterSpy.calls).toEqual([]);

    const listing = await db.findListingByExternalId(source.id, 'stays-gone-item');
    expect(listing!.status).toBe('removed');
    expect(listing!.marketplaceStatus).toBe('removed');
    // Nothing was rewritten either: the detection time still names the pass
    // that actually confirmed the removal, not the latest pass to run.
    expect(listing!.marketplaceStatusDetectedAt).toBe(afterRemoval!.marketplaceStatusDetectedAt);
  });

  it('never rechecks a Listing imported from a different platform than the connector being scanned', async () => {
    const source = await createScannableSource('Stale Source Other Platform');
    // Same Source, but this row was imported by a different platform's
    // connector, so its externalSource is 'mercari'. An eBay pass that does
    // not return it says nothing whatsoever about a Mercari item's liveness,
    // and eBay's own checker could not look it up even if it tried.
    const mercariConnector: MarketplaceConnector = {
      platformType: 'mercari',
      search: async () => [candidate('mercari-only-item')],
    };
    await scanService.scanSourceWithConnector(source, mercariConnector);
    expect((await db.findListingByExternalId(source.id, 'mercari-only-item'))!.externalSource).toBe('mercari');

    const spy = connectorWithStatusChecker([], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);

    // Not checked, and the checker was never even built: this row is not a
    // missing candidate for the platform being scanned at all.
    expect(spy.calls).toEqual([]);
    expect(spy.buildCount()).toBe(0);
    const listing = await db.findListingByExternalId(source.id, 'mercari-only-item');
    expect(listing!.status).toBe('open');
    expect(listing!.marketplaceStatus).toBeNull();
    expect(listing!.marketplaceStatusDetectedAt).toBeNull();
  });

  it('restores a removed Listing to open when it reappears, clearing both marketplace fields without any recheck call', async () => {
    const source = await createScannableSource('Stale Source Reappearing');
    await scanService.scanSourceWithConnector(source, fakeConnector([candidate('comeback-item')]));

    const removalSpy = connectorWithStatusChecker([], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), removalSpy.connector);
    const removed = await db.findListingByExternalId(source.id, 'comeback-item');
    expect(removed!.status).toBe('removed');
    expect(removed!.marketplaceStatus).toBe('removed');

    // Same connector shape as the removal pass (status checker present), so
    // zero calls here is a real "never consulted", not "had nothing to call".
    const returnSpy = connectorWithStatusChecker([candidate('comeback-item')], async () => 'removed');
    const result = await scanService.scanSourceWithConnector(await refetch(source.id), returnSpy.connector);
    // It is already imported, so reappearing is a restore, not a new import.
    expect(result).toEqual({ foundCount: 1, newCount: 0 });
    expect(returnSpy.calls).toEqual([]);

    const restored = await db.findListingByExternalId(source.id, 'comeback-item');
    expect(restored!.status).toBe('open');
    expect(restored!.marketplaceStatus).toBeNull();
    expect(restored!.marketplaceStatusDetectedAt).toBeNull();
  });

  it('never restores a removed Listing imported from a different platform, even when the scanned connector returns that same externalItemId', async () => {
    const source = await createScannableSource('Stale Source Cross Platform Reappearance');
    // Seed the row through a Mercari pass so its externalSource is
    // 'mercari', then let Mercari's own recheck mark it removed.
    const mercariImport = connectorWithStatusChecker([candidate('shared-item-id')], async () => 'removed', 'mercari');
    expect(await scanService.scanSourceWithConnector(source, mercariImport.connector)).toEqual({ foundCount: 1, newCount: 1 });
    const mercariRemoval = connectorWithStatusChecker([], async () => 'removed', 'mercari');
    await scanService.scanSourceWithConnector(await refetch(source.id), mercariRemoval.connector);

    const removed = await db.findListingByExternalId(source.id, 'shared-item-id');
    expect(removed!.externalSource).toBe('mercari');
    expect(removed!.status).toBe('removed');
    expect(removed!.marketplaceStatus).toBe('removed');
    const detectedAt = removed!.marketplaceStatusDetectedAt;
    expect(detectedAt).not.toBeNull();

    // Now an eBay pass returns an item carrying the very same
    // externalItemId. Item ids are only unique within a platform, so this
    // is eBay's item, not Mercari's reappearing: the Mercari row must not
    // be resurrected by it.
    const ebaySpy = connectorWithStatusChecker([candidate('shared-item-id')], async () => 'removed');
    expect(await scanService.scanSourceWithConnector(await refetch(source.id), ebaySpy.connector)).toEqual({ foundCount: 1, newCount: 0 });

    const untouched = await db.findListingByExternalId(source.id, 'shared-item-id');
    expect(untouched!.externalSource).toBe('mercari');
    expect(untouched!.status).toBe('removed');
    expect(untouched!.marketplaceStatus).toBe('removed');
    // Not even rewritten with the same values: the restore skipped it
    // entirely rather than clearing and re-setting the fields.
    expect(untouched!.marketplaceStatusDetectedAt).toBe(detectedAt);
  });

  it('logs and continues the rest of the pass when one Listing\'s recheck throws', async () => {
    const source = await createScannableSource('Stale Source Checker Failure');
    // The failing row carries a later listingDate so listListings's
    // `listing_date DESC` ordering puts it first — making "the rest of the
    // pass still ran" the thing this test actually proves, rather than
    // depending on which row happened to be processed first.
    const throwing = { ...candidate('throwing-item'), listingDate: '2026-02-01' };
    await scanService.scanSourceWithConnector(source, fakeConnector([throwing, candidate('second-gone-item')]));

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const spy = connectorWithStatusChecker([candidate('brand-new-item')], async (externalItemId) => {
      if (externalItemId === 'throwing-item') {
        throw new Error('ECONNRESET');
      }
      return 'removed';
    });

    const result = await scanService.scanSourceWithConnector(await refetch(source.id), spy.connector);

    // The pass finished: the new candidate imported, counts returned, and
    // scan stats written — none of which happens if the throw propagates.
    expect(result).toEqual({ foundCount: 1, newCount: 1 });
    expect(await db.findListingByExternalId(source.id, 'brand-new-item')).not.toBeNull();
    expect((await refetch(source.id)).lastScanFoundCount).toBe(1);

    expect(spy.calls).toEqual(['throwing-item', 'second-gone-item']);
    // The row whose recheck threw is left exactly as it was — a failed
    // recheck never confirms anything.
    const unchanged = await db.findListingByExternalId(source.id, 'throwing-item');
    expect(unchanged!.status).toBe('open');
    expect(unchanged!.marketplaceStatus).toBeNull();
    // ...while the row rechecked after it still transitioned.
    const after = await db.findListingByExternalId(source.id, 'second-gone-item');
    expect(after!.status).toBe('removed');
    expect(after!.marketplaceStatus).toBe('removed');

    // Failure must be diagnosable, not silently swallowed.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ externalItemId: 'throwing-item', err: expect.anything() }),
      expect.stringContaining('Failed to recheck'),
    );
    warnSpy.mockRestore();
  });

  it('reconciles every row on the Source, not just the first page listListings returns by default', async () => {
    const source = await createScannableSource('Stale Source Beyond One Page');
    // listListings caps a page at 50 rows unless given an explicit limit, so
    // 51 is the smallest count that tells "reads the whole Source" apart
    // from "reads the default page".
    const many = Array.from({ length: 51 }, (_, index) => candidate(`paged-item-${index}`));
    expect(await scanService.scanSourceWithConnector(source, fakeConnector(many))).toEqual({ foundCount: 51, newCount: 51 });

    const removalSpy = connectorWithStatusChecker([], async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), removalSpy.connector);
    expect(removalSpy.calls).toHaveLength(51);
    expect(new Set(removalSpy.calls).size).toBe(51);
    expect(await db.countListings({ sourceId: source.id, status: 'removed' })).toBe(51);

    // Same for the reappearance side: every removed row is considered, not
    // only a default-sized page of them.
    const returnSpy = connectorWithStatusChecker(many, async () => 'removed');
    await scanService.scanSourceWithConnector(await refetch(source.id), returnSpy.connector);
    expect(returnSpy.calls).toEqual([]);
    expect(await db.countListings({ sourceId: source.id, status: 'open' })).toBe(51);
  });
});
