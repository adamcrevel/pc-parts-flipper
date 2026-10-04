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
import { createEbayItemDetailClient } from '../src/connectors/ebayConnector.js';
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

  it('includes a price filter only when maxPrice is set', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth2/token')) {
        return new Response(JSON.stringify(TOKEN_FIXTURE), { status: 200 });
      }
      return new Response(JSON.stringify({ itemSummaries: [] }), { status: 200 });
    });

    const connector = getConnectorForPlatform('ebay');

    await connector.search({ queries: ['gaming pc'], maxPrice: 300 });
    const [withMaxPriceUrl] = fetchMock.mock.calls.find(([url]) => String(url).includes('/item_summary/search'))!;
    expect(String(withMaxPriceUrl)).toContain('filter=price%3A%5B0..300%5D%2CpriceCurrency%3AUSD');

    fetchMock.mockClear();
    await connector.search({ queries: ['gaming pc'] });
    const [withoutMaxPriceUrl] = fetchMock.mock.calls.find(([url]) => String(url).includes('/item_summary/search'))!;
    expect(String(withoutMaxPriceUrl)).not.toContain('filter=');
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
    });
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
});

describe('getConnectorForPlatform (T5, Req 7)', () => {
  it('rejects an unregistered platform type with a clear AppError', () => {
    expect(() => getConnectorForPlatform('facebook_marketplace')).toThrow(AppError);
    expect(() => getConnectorForPlatform('other')).toThrow(/no automated-scan connector/i);
  });
});
