// T5 proof: apps/server/src/connectors/ebayConnector.ts (Req 6 — automated
// eBay scan, one search call per configured query) and
// apps/server/src/connectors/registry.ts (Req 7 — platform lookup).
//
// Stubs global fetch directly rather than booting the real server (unlike
// T3/T4's helpers.ts-based route tests) since this connector talks to the
// outside world, not this app's own HTTP routes — no real network call is
// ever made, and no real eBay credentials are required.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/error-handler.js';
import {
  classifyEbayItemStatus,
  createEbayItemDetailClient,
  ebayConnector,
  formatEbayItemDetails,
} from '../src/connectors/ebayConnector.js';
import { getConnectorForPlatform } from '../src/connectors/registry.js';

// Fixture token response, shaped like eBay's real OAuth2 client-credentials
// grant response.
const TOKEN_FIXTURE = { access_token: 'fake-app-token', token_type: 'Application Access Token', expires_in: 7200 };

// Fixture search response for one item, shaped like a real eBay Browse API
// sandbox item_summary/search response. itemHref is deliberately a
// different URL from itemWebUrl so mapping-field tests catch using the
// wrong one.
function itemFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    itemId: 'v1|123456789|0',
    title: 'Dell OptiPlex 7090 Desktop i7',
    itemWebUrl: 'https://www.ebay.com/itm/123456789',
    itemHref: 'https://api.ebay.com/buy/browse/v1/item/v1|123456789|0',
    price: { value: '249.99', currency: 'USD' },
    itemCreationDate: '2026-09-15T18:23:41.000Z',
    ...overrides,
  };
}

describe('ebayConnector.search (T5, Req 6)', () => {
  // No explicit type annotation: mockImplementation below narrows fetchMock's
  // inferred type on its own, and vi.fn()'s own return type already
  // documents this shape.
  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues one search HTTP call per configured query', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [itemFixture()] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');
    await connector.search({ queries: ['gaming pc', 'desktop tower', 'ryzen build'] });

    // 1 token call + 3 search calls (one per query) = 4 total.
    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/item_summary/search'));
    expect(searchCalls).toHaveLength(3);
    expect(String(searchCalls[0][0])).toContain('q=gaming+pc');
    expect(String(searchCalls[1][0])).toContain('q=desktop+tower');
    expect(String(searchCalls[2][0])).toContain('q=ryzen+build');
  });

  it('always includes condition filter, combined with price filter when maxPrice is set', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');

    // With maxPrice: filter should have both conditionIds and price segments
    await connector.search({ queries: ['gaming pc'], maxPrice: 300 });
    const [withMaxPriceUrl] = fetchMock.mock.calls.find(([url]) => String(url).includes('/item_summary/search'))!;
    const withMaxPriceStr = String(withMaxPriceUrl);
    expect(withMaxPriceStr).toContain('filter=conditionIds%3A%7B3000%7C4000%7C5000%7C6000%7C7000%7D%2Cprice%3A%5B0..300%5D%2CpriceCurrency%3AUSD');

    // Without maxPrice: filter should have only conditionIds segment
    fetchMock.mockClear();
    await connector.search({ queries: ['gaming pc'] });
    const [withoutMaxPriceUrl] = fetchMock.mock.calls.find(([url]) => String(url).includes('/item_summary/search'))!;
    const withoutMaxPriceStr = String(withoutMaxPriceUrl);
    expect(withoutMaxPriceStr).toContain('filter=conditionIds%3A%7B3000%7C4000%7C5000%7C6000%7C7000%7D');
    expect(withoutMaxPriceStr).not.toContain('price%3A');
  });

  it('throws an AppError carrying eBay\'s own error message on a failed token call', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify({ errors: [{ message: 'invalid_client' }] }), { status: 401 });
      }
      throw new Error('search should never be called when the token request fails');
    });

    const connector = getConnectorForPlatform('ebay');
    await expect(connector.search({ queries: ['gaming pc'] })).rejects.toMatchObject(
      expect.objectContaining({ message: 'invalid_client' }),
    );
    // Confirms the thrown value is genuinely an AppError, not just something
    // that happens to carry a matching .message property.
    await expect(connector.search({ queries: ['gaming pc'] })).rejects.toBeInstanceOf(AppError);
  });

  // Token call succeeds but the Browse API search call itself 401s — a
  // distinct code path (searchOneQuery's own error branch) from the token
  // failure above. Without this test, deleting searchOneQuery's `!response.ok`
  // guard would pass every other test in this file.
  it('throws an AppError carrying eBay\'s own error message on a failed search call', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'rate_limit_exceeded' }] }), { status: 429 });
    });

    const connector = getConnectorForPlatform('ebay');
    await expect(connector.search({ queries: ['gaming pc'] })).rejects.toMatchObject(
      expect.objectContaining({ message: 'rate_limit_exceeded' }),
    );
    await expect(connector.search({ queries: ['gaming pc'] })).rejects.toBeInstanceOf(AppError);
  });

  // The connector's own validateEbayConnectorConfig guard (Req 1's
  // defense-in-depth beyond T3's route-level sourceValidation.ts) had zero
  // coverage: every other test in this file passes a valid config. Each case
  // below also asserts fetch was never called, proving the rejection happens
  // before any network call rather than failing later for an unrelated
  // reason.
  it('rejects an empty queries array without making any HTTP call', async () => {
    const connector = getConnectorForPlatform('ebay');
    await expect(connector.search({ queries: [] })).rejects.toMatchObject(
      expect.objectContaining({ message: expect.stringMatching(/non-empty array/i) }),
    );
    await expect(connector.search({ queries: [] })).rejects.toBeInstanceOf(AppError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a blank query string without making any HTTP call', async () => {
    const connector = getConnectorForPlatform('ebay');
    await expect(connector.search({ queries: ['gaming pc', '   '] })).rejects.toMatchObject(
      expect.objectContaining({ message: expect.stringMatching(/non-blank query/i) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a negative maxPrice without making any HTTP call', async () => {
    const connector = getConnectorForPlatform('ebay');
    await expect(connector.search({ queries: ['gaming pc'], maxPrice: -5 })).rejects.toMatchObject(
      expect.objectContaining({ message: expect.stringMatching(/maxPrice must be a non-negative number/i) }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });


  it('maps itemWebUrl (not itemHref) to listingUrl and truncates listingDate to a date', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [itemFixture()] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');
    const results = await connector.search({ queries: ['gaming pc'] });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      externalItemId: 'v1|123456789|0',
      title: 'Dell OptiPlex 7090 Desktop i7',
      listingUrl: 'https://www.ebay.com/itm/123456789',
      askingPrice: 249.99,
      listingDate: '2026-09-15',
      // The base fixture carries no image fields at all — an item eBay
      // returns without photos must still map to an empty array, never
      // undefined, so callers never branch on its presence.
      imageUrls: [],
      // Base fixture has no conditionId, so defaults to false
      nonWorking: false,
    });
  });

  it('sets nonWorking to true only when conditionId is "7000", false for others or undefined', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      // Test three items with different condition IDs
      const items = [
        itemFixture({ conditionId: '3000' }), // New — should be false
        itemFixture({ conditionId: '7000' }), // Parts only / non-working — should be true
        itemFixture(), // No conditionId — should be false
      ];
      return new Response(JSON.stringify({ itemSummaries: items }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');
    const results = await connector.search({ queries: ['gaming pc'] });

    expect(results).toHaveLength(3);
    expect(results[0].nonWorking).toBe(false); // conditionId '3000'
    expect(results[1].nonWorking).toBe(true); // conditionId '7000'
    expect(results[2].nonWorking).toBe(false); // no conditionId
  });

  // Photo capture (Req 2): the search response already carries every image
  // URL, so these prove the connector extracts and upsizes them without
  // issuing any additional eBay call.
  it('builds imageUrls from the primary image plus every additionalImages entry, upsized to full resolution', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      const item = itemFixture({
        image: { imageUrl: 'https://i.ebayimg.com/images/g/ROUAAeSwDJpqwcxR/s-l225.jpg' },
        additionalImages: [
          { imageUrl: 'https://i.ebayimg.com/images/g/AAAAAeSwDJpqwcxR/s-l500.jpg' },
          { imageUrl: 'https://i.ebayimg.com/images/g/BBBAAeSwDJpqwcxR/s-l140.jpg' },
        ],
      });
      return new Response(JSON.stringify({ itemSummaries: [item] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');
    const results = await connector.search({ queries: ['gaming pc'] });

    // Primary first, then additionalImages in order, every one rewritten to
    // the 1600px variant of its own image id — the size segment is the only
    // part of the URL that may change.
    expect(results[0].imageUrls).toEqual([
      'https://i.ebayimg.com/images/g/ROUAAeSwDJpqwcxR/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/AAAAAeSwDJpqwcxR/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/BBBAAeSwDJpqwcxR/s-l1600.jpg',
    ]);

    // Upsizing must stay free: exactly one token call and one search call,
    // no per-item lookup smuggled in to fetch bigger images.
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it('keeps an image URL that does not match eBay\'s size-segment pattern exactly as received', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      const item = itemFixture({
        image: { imageUrl: 'https://i.ebayimg.com/thumbs/images/g/ROUAAeSwDJpqwcxR/s-l225.jpg?set_id=8800005007' },
        additionalImages: [{ imageUrl: 'https://cdn.example.com/legacy-photo-format' }],
      });
      return new Response(JSON.stringify({ itemSummaries: [item] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');
    const results = await connector.search({ queries: ['gaming pc'] });

    // Neither URL ends in the `/s-l<digits>.jpg` segment the swap is proven
    // safe for (the first has a querystring after it), so both are used
    // as-is: a smaller photo beats a dropped one, and a blind rewrite could
    // produce a URL that 404s.
    expect(results[0].imageUrls).toEqual([
      'https://i.ebayimg.com/thumbs/images/g/ROUAAeSwDJpqwcxR/s-l225.jpg?set_id=8800005007',
      'https://cdn.example.com/legacy-photo-format',
    ]);
  });

  it('de-duplicates repeated image URLs and caps the total at 8', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      const item = itemFixture({
        image: { imageUrl: 'https://i.ebayimg.com/images/g/primary/s-l225.jpg' },
        additionalImages: [
          // Same image as the primary at a different advertised size: after
          // upsizing both collapse onto one URL and must not be stored twice.
          { imageUrl: 'https://i.ebayimg.com/images/g/primary/s-l500.jpg' },
          // 11 further distinct images — more than eBay ever returns — so the
          // defensive cap is what limits the result, not the input length.
          ...Array.from({ length: 11 }, (_unused, i) => ({
            imageUrl: `https://i.ebayimg.com/images/g/extra${i}/s-l225.jpg`,
          })),
        ],
      });
      return new Response(JSON.stringify({ itemSummaries: [item] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');
    const results = await connector.search({ queries: ['gaming pc'] });

    expect(results[0].imageUrls).toHaveLength(8);
    // The duplicate appears once, as the first entry.
    expect(results[0].imageUrls.filter((u) => u === 'https://i.ebayimg.com/images/g/primary/s-l1600.jpg')).toHaveLength(1);
    expect(results[0].imageUrls[0]).toBe('https://i.ebayimg.com/images/g/primary/s-l1600.jpg');
    // The cap keeps the first 8 distinct images: extra0..extra6 fill the
    // remaining 7 slots, and extra7 onwards is dropped.
    expect(results[0].imageUrls[7]).toBe('https://i.ebayimg.com/images/g/extra6/s-l1600.jpg');
    expect(results[0].imageUrls).not.toContain('https://i.ebayimg.com/images/g/extra7/s-l1600.jpg');
  });
});

// HTML description + item specifics formatting (Req 1-3): formatEbayItemDetails
// wraps the module-private stripHtml internally (stripHtml itself is not
// exported), so these exercise it indirectly through the description field.
describe('formatEbayItemDetails (Req 1-3)', () => {
  it('strips HTML (paragraphs, bold, <br>) to plain text and drops a <script> block entirely', () => {
    const description =
      "<p>This is a <b>great</b> laptop.</p><script>alert('xss');</script><p>Works perfectly.<br>No issues.</p>";

    const result = formatEbayItemDetails({ description });

    expect(result).toBe('This is a great laptop.\nWorks perfectly.\nNo issues.');
    // Not just "no literal <script> tag": the script's *content* must also
    // be gone, not merely unwrapped by the generic tag-strip step.
    expect(result).not.toContain('alert');
  });

  it('decodes named and numeric HTML entities', () => {
    const description =
      "AT&amp;T certified &#33; 15&quot; display &lt;like new&gt; seller&#39;s item &nbsp; ready";

    const result = formatEbayItemDetails({ description });

    expect(result).toBe('AT&T certified ! 15" display <like new> seller\'s item ready');
  });

  it('includes both description and specifics, description first, separated by a blank line', () => {
    const result = formatEbayItemDetails({
      description: '<p>Barely used gaming desktop.</p>',
      localizedAspects: [
        { name: 'Brand', value: 'ASUS' },
        { name: 'Processor', value: 'Intel Core i7-10700' },
      ],
    });

    expect(result).toBe(
      'Barely used gaming desktop.\n\nItem Specifics (per eBay):\nBrand: ASUS\nProcessor: Intel Core i7-10700',
    );
  });

  it('omits the specifics block when localizedAspects is absent, returning only the description', () => {
    const result = formatEbayItemDetails({ description: '<p>Barely used gaming desktop.</p>' });

    expect(result).toBe('Barely used gaming desktop.');
  });

  it('omits the description when it is absent, returning only the specifics block', () => {
    const result = formatEbayItemDetails({
      localizedAspects: [{ name: 'Brand', value: 'ASUS' }],
    });

    expect(result).toBe('Item Specifics (per eBay):\nBrand: ASUS');
  });

  it('returns null, not an empty string, when neither description nor specifics produced content', () => {
    expect(formatEbayItemDetails({})).toBeNull();
    // A description that is blank only after HTML-stripping (whitespace-only
    // markup) plus an explicit empty aspects array must fall through to null
    // too, not just an outright-absent detail object.
    expect(formatEbayItemDetails({ description: '<p>   </p>', localizedAspects: [] })).toBeNull();
  });

  it('returns the combined text unchanged at exactly the 5000-character cap', () => {
    const description = 'X'.repeat(5000);

    const result = formatEbayItemDetails({ description });

    expect(result).toBe(description);
    expect(result).toHaveLength(5000);
  });

  it('truncates with the trailing marker and caps the result at 5000 chars when just over the limit', () => {
    const description = 'Y'.repeat(5001);

    const result = formatEbayItemDetails({ description });

    expect(result).toBe('Y'.repeat(4985) + '... [truncated]');
    expect(result).toHaveLength(5000);
  });
});

// Photo backfill support (Req 2): the single-item detail endpoint is the
// only way to reach a specific already-imported item, since search cannot be
// queried by item id and its ranking shifts between runs.
describe('createEbayItemDetailClient', () => {
  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches one item\'s images by url-encoded item id over a single shared token', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          image: { imageUrl: 'https://i.ebayimg.com/images/g/ROUAAeSwDJpqwcxR/s-l1600.jpg' },
          additionalImages: [{ imageUrl: 'https://i.ebayimg.com/images/g/AAAAAeSwDJpqwcxR/s-l1600.jpg' }],
        }),
        { status: 200 },
      );
    });

    const client = await createEbayItemDetailClient();
    const first = await client.fetchItemImageUrls('v1|227551136880|0');
    const second = await client.fetchItemImageUrls('v1|227551136881|0');

    expect(first).toEqual([
      'https://i.ebayimg.com/images/g/ROUAAeSwDJpqwcxR/s-l1600.jpg',
      'https://i.ebayimg.com/images/g/AAAAAeSwDJpqwcxR/s-l1600.jpg',
    ]);
    expect(second).toEqual(first);

    // The `|` separators in an eBay item id must be percent-encoded to
    // survive the URL path, or eBay rejects the request.
    const detailCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/buy/browse/v1/item/'));
    expect(String(detailCalls[0][0])).toContain('/buy/browse/v1/item/v1%7C227551136880%7C0');

    // One token for the whole client, not one per item: a backfill visiting
    // hundreds of listings must not make hundreds of OAuth round-trips.
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('throws an AppError carrying eBay\'s own error message when the item is gone', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'The specified item ID was not found.' }] }), { status: 404 });
    });

    const client = await createEbayItemDetailClient();

    // Asserted on the message, not just the AppError type: several guards in
    // this module throw AppError, so a type-only assertion would still pass
    // if the detail call's own error branch were deleted and some other
    // failure surfaced instead.
    await expect(client.fetchItemImageUrls('v1|000000000000|0')).rejects.toThrow('The specified item ID was not found.');
    await expect(client.fetchItemImageUrls('v1|000000000000|0')).rejects.toBeInstanceOf(AppError);
  });

  it('returns an empty array for an item eBay holds no images for', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ itemId: 'v1|1|0' }), { status: 200 });
    });

    const client = await createEbayItemDetailClient();
    await expect(client.fetchItemImageUrls('v1|1|0')).resolves.toEqual([]);
  });

  // fetchItemDescription (Req 1-3): same shared-token client, same endpoint,
  // distinct method — these prove it round-trips eBay's description/aspects
  // fields through formatEbayItemDetails rather than just re-proving
  // fetchItemImageUrls's own behavior.
  it('fetches and formats one item\'s description and specifics via formatEbayItemDetails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          description: '<p>Barely used gaming desktop.<br>No issues, ships fast!</p>',
          localizedAspects: [
            { name: 'Brand', value: 'ASUS' },
            { name: 'Processor', value: 'Intel Core i7-10700' },
          ],
        }),
        { status: 200 },
      );
    });

    const client = await createEbayItemDetailClient();
    const result = await client.fetchItemDescription('v1|227551136880|0');

    expect(result).toBe(
      'Barely used gaming desktop.\nNo issues, ships fast!\n\nItem Specifics (per eBay):\nBrand: ASUS\nProcessor: Intel Core i7-10700',
    );
  });

  it('fetchItemDescription throws an AppError carrying eBay\'s own error message when the item is gone', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'The specified item ID was not found.' }] }), { status: 404 });
    });

    const client = await createEbayItemDetailClient();

    // Asserted on the message, not just the AppError type, for the same
    // reason as the equivalent fetchItemImageUrls case above: the message
    // assertion is what proves this is the detail-fetch error branch and
    // not some other AppError this module happens to also throw.
    await expect(client.fetchItemDescription('v1|000000000000|0')).rejects.toThrow('The specified item ID was not found.');
    await expect(client.fetchItemDescription('v1|000000000000|0')).rejects.toBeInstanceOf(AppError);
  });

  it('resolves null for an item with neither a description nor specifics, rather than throwing', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ itemId: 'v1|1|0' }), { status: 200 });
    });

    const client = await createEbayItemDetailClient();
    await expect(client.fetchItemDescription('v1|1|0')).resolves.toBeNull();
  });
});

// checkItemStatus / createStatusChecker (T3/T10, Req 6): eBay's Browse API
// does NOT 404 for a sold or ended item -- observed live against the
// production API during feature UAT, a gone item still answers HTTP 200
// with real `estimatedAvailabilities[0]` and `itemEndDate` fields, so the
// status is classified from that body (see checkItemStatus's own doc
// comment and classifyEbayItemStatus in ebayConnector.ts). The fixtures
// below are the four real shapes UAT observed across 166 production
// listings, plus the 404 branch. These also prove a genuine failure
// response rethrows rather than silently resolving to a status, the same
// lesson this project already learned from the Mercari connector's own
// auth-bypass bug (an unexpected failure response read as a mundane
// outcome instead of a real failure).

// Fixed dates either side of the real "now" so the itemEndDate comparison
// is unambiguous no matter when this suite runs.
const PAST_END_DATE = '2026-10-16T17:03:12.000Z';
const FUTURE_END_DATE = '2099-01-01T00:00:00.000Z';

// Item-detail body shaped like eBay's real `GET /buy/browse/v1/item/{id}`
// response. `sold`/`quantity`/`endDate` are omitted from the body entirely
// when not given, mirroring eBay leaving those fields out.
function itemDetailFixture(fields: { status: string; quantity?: number; sold?: number; endDate?: string }) {
  const availability: Record<string, unknown> = { estimatedAvailabilityStatus: fields.status };
  if (fields.quantity !== undefined) availability.estimatedAvailableQuantity = fields.quantity;
  if (fields.sold !== undefined) availability.estimatedSoldQuantity = fields.sold;
  return {
    itemId: 'v1|1|0',
    title: 'Dell OptiPlex 7090 Desktop i7',
    estimatedAvailabilities: [availability],
    ...(fields.endDate === undefined ? {} : { itemEndDate: fields.endDate }),
  };
}

describe('EbayItemDetailClient.checkItemStatus (T3/T10, Req 6)', () => {
  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function checkStatusFor(body: unknown, httpStatus = 200) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify(body), { status: httpStatus });
    });
    const client = await createEbayItemDetailClient();
    return client.checkItemStatus('v1|1|0');
  }

  it('resolves \'sold\' for OUT_OF_STOCK + past itemEndDate + estimatedSoldQuantity > 0 (the common real sold shape, 118 of 166 in UAT)', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'OUT_OF_STOCK', quantity: 0, sold: 1, endDate: PAST_END_DATE }))).toBe('sold');
  });

  it('resolves \'sold\' for OUT_OF_STOCK + no itemEndDate + quantity 0 + estimatedSoldQuantity > 0 (19 of 166 in UAT)', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'OUT_OF_STOCK', quantity: 0, sold: 3 }))).toBe('sold');
  });

  it('resolves \'removed\' for OUT_OF_STOCK + past itemEndDate with estimatedSoldQuantity 0', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'OUT_OF_STOCK', quantity: 0, sold: 0, endDate: PAST_END_DATE }))).toBe('removed');
  });

  it('resolves \'removed\' for OUT_OF_STOCK + past itemEndDate with estimatedSoldQuantity absent', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'OUT_OF_STOCK', quantity: 0, endDate: PAST_END_DATE }))).toBe('removed');
  });

  it('resolves \'removed\' for IN_STOCK + past itemEndDate with estimatedSoldQuantity 0 (ended unsold, 6 of the 8 ended-IN_STOCK rows in UAT)', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'IN_STOCK', quantity: 1, sold: 0, endDate: PAST_END_DATE }))).toBe('removed');
  });

  it('resolves \'sold\' for IN_STOCK + past itemEndDate with estimatedSoldQuantity > 0 (a multi-quantity listing that sold some, then ended -- the other 2 ended-IN_STOCK rows in UAT)', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'IN_STOCK', quantity: 2, sold: 1, endDate: PAST_END_DATE }))).toBe('sold');
  });

  it('resolves \'active\' for IN_STOCK with a future itemEndDate (genuinely live, ~20 of 166 in UAT)', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'IN_STOCK', quantity: 1, sold: 0, endDate: FUTURE_END_DATE }))).toBe('active');
  });

  it('resolves \'active\' for IN_STOCK with no itemEndDate, even with prior sales (a live multi-quantity listing)', async () => {
    expect(await checkStatusFor(itemDetailFixture({ status: 'IN_STOCK', quantity: 4, sold: 2 }))).toBe('active');
  });

  it('resolves \'active\' for a 2xx body carrying no availability block or end date at all -- absence of data never retires an item', async () => {
    expect(await checkStatusFor({ itemId: 'v1|1|0' })).toBe('active');
  });

  it('resolves \'removed\' for a 404 response', async () => {
    expect(await checkStatusFor({ errors: [{ message: 'The specified item ID was not found.' }] }, 404)).toBe('removed');
  });

  it('rethrows an AppError carrying eBay\'s own error message for a genuine non-2xx/non-404 failure, rather than resolving to any status', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'Internal server error.' }] }), { status: 500 });
    });

    const client = await createEbayItemDetailClient();

    // Asserted on the message, not just the AppError type: checkItemStatus
    // has its own single throw site distinct from fetchItemImageUrls'/
    // fetchItemDescription's, so this proves it's that branch specifically,
    // not merely that *some* AppError surfaced.
    await expect(client.checkItemStatus('v1|1|0')).rejects.toThrow('Internal server error.');
    await expect(client.checkItemStatus('v1|1|0')).rejects.toBeInstanceOf(AppError);
  });
});

// classifyEbayItemStatus's end-date comparison, pinned against an injected
// clock so the boundary itself is proven, not just dates far either side.
describe('classifyEbayItemStatus (T10, Req 6)', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');

  it('treats an itemEndDate one second before now as ended, and one second after as still live', () => {
    const live = { estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedSoldQuantity: 0 }] };
    expect(classifyEbayItemStatus({ ...live, itemEndDate: '2026-11-11T11:59:59.000Z' }, now)).toBe('removed');
    expect(classifyEbayItemStatus({ ...live, itemEndDate: '2026-11-11T12:00:01.000Z' }, now)).toBe('active');
  });

  it('ignores an unparseable itemEndDate rather than reading it as ended', () => {
    const live = { estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }] };
    expect(classifyEbayItemStatus({ ...live, itemEndDate: 'not-a-date' }, now)).toBe('active');
  });

  it('does not read LIMITED_STOCK as gone', () => {
    expect(classifyEbayItemStatus({ estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'LIMITED_STOCK', estimatedSoldQuantity: 9 }] }, now)).toBe('active');
  });
});

describe('ebayConnector.createStatusChecker (T3/T10, Req 6)', () => {
  let fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds one shared client/OAuth token and reuses it across every missing-candidate lookup in the pass, mirroring createDescriptionFetcher', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      if (url.includes('v1%7C1%7C0')) {
        return new Response(JSON.stringify({ itemId: 'v1|1|0' }), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 });
    });

    const checkStatus = ebayConnector.createStatusChecker!();
    const first = await checkStatus('v1|1|0');
    const second = await checkStatus('v1|2|0');

    expect(first).toBe('active');
    expect(second).toBe('removed');

    // One OAuth token for the whole pass, not one per lookup -- the same
    // shared-resource proof scanService.test.ts already runs against
    // createDescriptionFetcher.
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('resolves \'sold\' through the full factory for a real OUT_OF_STOCK + past-itemEndDate + estimatedSoldQuantity > 0 body', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify(itemDetailFixture({ status: 'OUT_OF_STOCK', sold: 1, endDate: PAST_END_DATE })), {
        status: 200,
      });
    });

    const checkStatus = ebayConnector.createStatusChecker!();
    expect(await checkStatus('v1|1|0')).toBe('sold');
  });

  it('resolves \'removed\' through the full factory for a real IN_STOCK + past-itemEndDate body (ended unsold)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify(itemDetailFixture({ status: 'IN_STOCK', quantity: 1, sold: 0, endDate: PAST_END_DATE })), {
        status: 200,
      });
    });

    const checkStatus = ebayConnector.createStatusChecker!();
    expect(await checkStatus('v1|1|0')).toBe('removed');
  });

  it('rethrows an AppError for a genuine non-2xx/non-404 failure via the full createStatusChecker factory, rather than resolving to any status', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: 'Internal server error.' }] }), { status: 500 });
    });

    const checkStatus = ebayConnector.createStatusChecker!();

    // Asserted on the message, not just the AppError type, for the same
    // reason as checkItemStatus's own equivalent case directly above: proves
    // this is the genuine-failure branch specifically, not merely that
    // *some* AppError surfaced from somewhere else in the factory's
    // delegation to the shared client.
    await expect(checkStatus('v1|1|0')).rejects.toThrow('Internal server error.');
    await expect(checkStatus('v1|1|0')).rejects.toBeInstanceOf(AppError);
  });
});

describe('getConnectorForPlatform (T5, Req 7)', () => {
  it('rejects an unregistered platform type with a clear AppError', () => {
    expect(() => getConnectorForPlatform('other')).toThrow(AppError);
    expect(() => getConnectorForPlatform('other')).toThrow(/no automated-scan connector/i);
  });
});
