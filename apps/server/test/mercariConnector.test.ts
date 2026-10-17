// T5 proof: apps/server/src/connectors/mercariConnector.ts (Req 6 —
// automated Mercari scan via a real Chromium tab), updated for T14's
// auth-bypass fix: searchOneQuery no longer injects its own
// page.evaluate(fetch) call — it races `page.waitForResponse` against
// `page.goto`, reading the page's own already-authenticated
// `searchFacetQuery` response. Mocks browserSession.ts's launchScanBrowser
// directly, returning a fake Browser/BrowserContext/Page whose
// `waitForResponse` resolves to a fake Response-like object (`ok`/`status`/
// `json`) built from a fixture body — no real Chromium process launches and
// no real network call is ever made, matching ebayConnector.test.ts's "stub
// the outside world, never hit it" convention, adapted for Playwright's
// Page/Browser/Response shape instead of a bare fetch stub.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Mock } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/error-handler.js';
import { launchScanBrowser } from '../src/connectors/browserSession.js';
import { mercariConnector } from '../src/connectors/mercariConnector.js';
import type * as DbModule from '../src/db/index.js';
import type * as ScanServiceModule from '../src/scan/scanService.js';

vi.mock('../src/connectors/browserSession.js', () => ({
  launchScanBrowser: vi.fn(),
  SCAN_BROWSER_USER_AGENT: 'test-user-agent',
  SCAN_BROWSER_INIT_SCRIPT: '',
}));

const mockedLaunchScanBrowser = launchScanBrowser as unknown as Mock;

interface FakeResponse {
  ok: Mock;
  status: Mock;
  json: Mock;
}

interface FakePage {
  goto: Mock;
  waitForResponse: Mock;
}

interface FakeContext {
  addInitScript: Mock;
  newPage: Mock;
  close: Mock;
}

interface FakeBrowser {
  newContext: Mock;
  close: Mock;
}

// Fixture item, shaped like one `data.search.itemsList[]` entry. `price` is
// whole US cents (confirmed live during T5's capture: a card showing
// "$142.50" carried `price: 14250`).
function itemFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'm68587273171',
    name: 'RTX 3070 GPU',
    price: 14250,
    status: 'on_sale',
    photos: [{ imageUrl: 'https://static.mercdn.net/item/photo1.jpg' }],
    ...overrides,
  };
}

// Fake Playwright Response, shaped just enough for searchOneQuery's own
// response.ok()/response.status()/response.json() calls — not a real
// Response instance.
function fakeResponse(body: unknown, ok = true, status = 200): FakeResponse {
  return {
    ok: vi.fn().mockReturnValue(ok),
    status: vi.fn().mockReturnValue(status),
    json: vi.fn().mockResolvedValue(body),
  };
}

// Builds a fake Browser whose newContext() returns a fresh fake
// context/page pair each call (so per-query isolation is observable), with
// waitForResponse() resolving to a fake Response wrapping `itemsList` in the
// real response shape — the same object searchOneQuery's
// `page.waitForResponse(...)` race against `page.goto(...)` would resolve
// to for a real, successfully authenticated searchFacetQuery call.
function fakeBrowserReturning(itemsByCall: Array<Record<string, unknown>[]>): { browser: FakeBrowser; pages: FakePage[] } {
  let call = 0;
  const pages: FakePage[] = [];
  const newContext = vi.fn().mockImplementation(async (): Promise<FakeContext> => {
    const items = itemsByCall[call] ?? [];
    call += 1;
    const page: FakePage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForResponse: vi.fn().mockResolvedValue(fakeResponse({ data: { search: { itemsList: items } } })),
    };
    pages.push(page);
    return {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { browser: { newContext, close: vi.fn().mockResolvedValue(undefined) }, pages };
}

describe('mercariConnector.search (T5, Req 6)', () => {
  beforeEach(() => {
    mockedLaunchScanBrowser.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a config missing a non-empty queries array', async () => {
    await expect(mercariConnector.search({})).rejects.toMatchObject({
      message: expect.stringContaining('non-empty array of non-blank query strings'),
      statusCode: 400,
    });
    await expect(mercariConnector.search({ queries: [] })).rejects.toBeInstanceOf(AppError);
    await expect(mercariConnector.search({ queries: ['  '] })).rejects.toMatchObject({
      message: expect.stringContaining('non-blank query strings'),
    });
  });

  it('rejects a negative maxPrice with a distinct message from the queries guard', async () => {
    await expect(mercariConnector.search({ queries: ['gpu'], maxPrice: -1 })).rejects.toMatchObject({
      message: expect.stringContaining('maxPrice must be a non-negative number'),
      statusCode: 400,
    });
  });

  it('issues one search per configured query, mapping itemsList into CandidateListing and excluding non on_sale items', async () => {
    const { browser } = fakeBrowserReturning([
      [itemFixture({ id: 'm111', name: 'GPU one' }), itemFixture({ id: 'm222', name: 'GPU two', status: 'sold_out' })],
      [itemFixture({ id: 'm333', name: 'CPU one' })],
    ]);
    mockedLaunchScanBrowser.mockResolvedValue(browser);

    const results = await mercariConnector.search({ queries: ['rtx 3070', 'ryzen 5800x'] });

    expect(browser.newContext).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.externalItemId)).toEqual(['m111', 'm333']);

    const first = results[0];
    expect(first.title).toBe('GPU one');
    expect(first.askingPrice).toBe(142.5);
    expect(first.listingUrl).toBe('https://www.mercari.com/us/item/m111/');
    expect(first.imageUrls).toEqual(['https://static.mercdn.net/item/photo1.jpg']);
    expect(first.nonWorking).toBe(false);
  });

  it('keeps an item priced exactly at maxPrice and drops one $0.01 over it', async () => {
    const { browser } = fakeBrowserReturning([
      [
        itemFixture({ id: 'm-at-ceiling', price: 15000 }), // $150.00, exactly at ceiling
        itemFixture({ id: 'm-over-ceiling', price: 15001 }), // $150.01, one cent over
      ],
    ]);
    mockedLaunchScanBrowser.mockResolvedValue(browser);

    const results = await mercariConnector.search({ queries: ['gaming pc'], maxPrice: 150 });

    expect(results.map((r) => r.externalItemId)).toEqual(['m-at-ceiling']);
  });

  it('wraps a non-ok searchFacetQuery response in AppError(502)', async () => {
    const page: FakePage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForResponse: vi.fn().mockResolvedValue(fakeResponse({}, false, 403)),
    };
    const context: FakeContext = {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser: FakeBrowser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    mockedLaunchScanBrowser.mockResolvedValue(browser);

    await expect(mercariConnector.search({ queries: ['gpu'] })).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('403'),
    });
    expect(browser.close).toHaveBeenCalled();
  });

  // Auth-bypass regression guard (T14): Mercari rejects an unauthenticated
  // searchFacetQuery call with HTTP 200 and a top-level `errors` array
  // (`{"errors":[{"status":401,"message":"Unauthorized"}]}`), confirmed live
  // against the real site — `response.ok()` alone can't catch this, since
  // the HTTP status is 200. Before this fix, `body.data?.search?.itemsList
  // ?? []` silently read that body as zero results instead of surfacing the
  // failure.
  it('throws AppError(502) with Mercari\'s own message when the response body carries a top-level errors array, instead of returning an empty result', async () => {
    const page: FakePage = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForResponse: vi.fn().mockResolvedValue(fakeResponse({ errors: [{ status: 401, message: 'Unauthorized' }] })),
    };
    const context: FakeContext = {
      addInitScript: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser: FakeBrowser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    mockedLaunchScanBrowser.mockResolvedValue(browser);

    await expect(mercariConnector.search({ queries: ['gpu'] })).rejects.toMatchObject({
      statusCode: 502,
      message: 'Unauthorized',
    });
    expect(browser.close).toHaveBeenCalled();
  });
});

// Req 1's dedup claim ("deduplicated against Listings already imported for
// that Source exactly the way eBay-sourced candidates are deduplicated
// today") is implemented once, generically, in scanService.ts — not inside
// this connector. This proves the Mercari wiring actually rides that same
// generic mechanism end to end: the real mercariConnector (browser mocked,
// same as every test above) run through the real scanSourceWithConnector
// against a real isolated DuckDB, against a Source that already has a
// Listing for one of the two items search() is about to return.
describe('mercariConnector dedup against already-imported externalItemIds (Req 1)', () => {
  let dataDir: string;
  let db: typeof DbModule;
  let scanService: typeof ScanServiceModule;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-mercari-dedup-test-'));
    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): same reason as scanService.test.ts's
    // beforeAll — db/client.ts reads DUCKDB_DATA_DIR once at module-evaluation
    // time, so a static top-of-file import would open the shared dev database
    // instead of this test's isolated temp dir.
    db = await import('../src/db/index.js');
    scanService = await import('../src/scan/scanService.js');
  }, 30000);

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockedLaunchScanBrowser.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('imports only the new candidate when one of two found items is already a Listing on this Source', async () => {
    const source = await db.createSource({
      name: 'Mercari Dedup Source',
      platformType: 'mercari',
      url: null,
      notes: null,
      connectorConfig: JSON.stringify({ queries: ['rtx 3070'] }),
    });

    // Pre-seed exactly the row a prior scan pass would have left behind for
    // 'm111' — same shape importCandidateIfNew itself writes.
    await db.createListing({
      sourceId: source.id,
      title: 'GPU one (already imported)',
      description: null,
      listingUrl: 'https://www.mercari.com/us/item/m111/',
      askingPrice: 142.5,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: 'mercari',
      externalItemId: 'm111',
      nonWorking: false,
    });

    // photos: [] avoids attachCandidatePhotos making a real network call to
    // Mercari's CDN during this test — irrelevant to the dedup behavior
    // being proven here.
    const { browser } = fakeBrowserReturning([
      [itemFixture({ id: 'm111', name: 'GPU one', photos: [] }), itemFixture({ id: 'm222', name: 'GPU two', photos: [] })],
    ]);
    mockedLaunchScanBrowser.mockResolvedValue(browser);

    const result = await scanService.scanSourceWithConnector(source, mercariConnector);

    expect(result).toEqual({ foundCount: 2, newCount: 1 });

    const listings = await db.listListings({ sourceId: source.id });
    expect(listings.map((l) => l.externalItemId).sort()).toEqual(['m111', 'm222']);
    expect(listings.find((l) => l.externalItemId === 'm111')!.title).toBe('GPU one (already imported)');
  });
});
