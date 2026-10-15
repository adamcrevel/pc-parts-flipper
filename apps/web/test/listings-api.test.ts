import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentifyPartsBulkResult } from '@pc-parts-flipper/shared';
import { fetchListingIds, fetchListings, enqueueBulkIdentifyParts } from '../src/features/listings/listings-api';

// Proves listings-api.ts's two bulk-identify-parts wrappers (T4) send the
// exact routes, verbs, query params and body the backend's new endpoints
// (T2's GET /api/listings/ids, T3's POST
// /api/listings/identify-parts/bulk — see apps/server/test/listings.test.ts
// and identifyPartsRoute.test.ts) actually expect, and that each wrapper
// unwraps the envelope (`{ ids }` / `{ results }`) rather than handing the
// caller the raw response body. The bulk-select UI (bulk-identify-parts-ui
// tests) stubs this whole module away, so a wrong path/verb/param here
// would go unnoticed by all of them while breaking against the real
// backend. Mirrors api-client.test.ts's "identify-parts job wrapper
// request shapes" describe block: stub global fetch with a real `Response`
// instead of hitting a server.
describe('bulk identify-parts wrapper request shapes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchListingIds GETs /api/listings/ids with the column-filter query params and resolves with the unwrapped ids array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ids: ['listing-1', 'listing-2'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchListingIds({ statuses: ['open'], sourceIds: ['source-1'] })).resolves.toEqual([
      'listing-1',
      'listing-2',
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings/ids?sourceIds=source-1&statuses=open');
    expect(init.method).toBe('GET');
  });

  it('fetchListingIds sends every one of the 11 column-filter fields under its own name, multi-value ones comma-joined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ids: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchListingIds({
      title: 'gpu',
      sourceIds: ['source-1', 'source-2'],
      statuses: ['open', 'accepted'],
      askingPriceMin: 10,
      askingPriceMax: 20,
      expectedResaleMin: 30,
      expectedResaleMax: 40,
      differenceMin: -5,
      differenceMax: 50,
      identifyPartsStages: ['none', 'completed'],
      pricingStatuses: ['not_priced', 'fully_priced'],
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3001/api/listings/ids?title=gpu&sourceIds=source-1%2Csource-2&statuses=open%2Caccepted&askingPriceMin=10&askingPriceMax=20&expectedResaleMin=30&expectedResaleMax=40&differenceMin=-5&differenceMax=50&identifyPartsStages=none%2Ccompleted&pricingStatuses=not_priced%2Cfully_priced',
    );
  });

  it('fetchListingIds omits an empty-array or empty-string filter field rather than sending an empty param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ids: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchListingIds({ title: '', statuses: [], askingPriceMin: 0 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    // A zero bound is a real bound, unlike an empty string/array.
    expect(url).toBe('http://localhost:3001/api/listings/ids?askingPriceMin=0');
  });

  it('fetchListingIds omits the query string entirely when no filters are given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ids: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchListingIds()).resolves.toEqual([]);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings/ids');
  });

  it('enqueueBulkIdentifyParts POSTs to /api/listings/identify-parts/bulk with { listingIds } and resolves with the unwrapped results array', async () => {
    const results: IdentifyPartsBulkResult[] = [
      { listingId: 'listing-1', outcome: 'queued' },
      { listingId: 'listing-2', outcome: 'already_active' },
      { listingId: 'listing-3', outcome: 'not_found' },
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(enqueueBulkIdentifyParts(['listing-1', 'listing-2', 'listing-3'])).resolves.toEqual(results);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings/identify-parts/bulk');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ listingIds: ['listing-1', 'listing-2', 'listing-3'] });
  });
});

// T3: the sortable column headers drive `sortBy`/`sortDirection` query
// params on GET /api/listings. The page/component tests stub this whole
// module away, so nothing else would catch a param that never reaches the
// URL (leaving the server on its default order while the header shows an
// arrow) or one that is sent as `undefined` when no column is sorted.
describe('fetchListings sort query params', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubListingsFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ listings: [], total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sends sortBy and sortDirection alongside the column-filter/pagination params', async () => {
    const fetchMock = stubListingsFetch();

    await fetchListings({ statuses: ['open'], sourceIds: ['source-1'], limit: 20, offset: 40, sortBy: 'expectedResale', sortDirection: 'desc' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings?sourceIds=source-1&statuses=open&limit=20&offset=40&sortBy=expectedResale&sortDirection=desc');
  });

  it('sends every one of the 11 column-filter fields on GET /api/listings under the same names fetchListingIds uses', async () => {
    const fetchMock = stubListingsFetch();

    await fetchListings({
      title: 'Ryzen',
      sourceIds: ['source-2'],
      statuses: ['rejected'],
      askingPriceMin: 1.5,
      askingPriceMax: 2.5,
      expectedResaleMin: 3,
      expectedResaleMax: 4,
      differenceMin: 5,
      differenceMax: 6,
      identifyPartsStages: ['queued', 'identifying', 'sourcing_references', 'comparing', 'completed', 'failed'],
      pricingStatuses: ['partially_priced'],
      limit: 20,
      offset: 0,
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://localhost:3001/api/listings?title=Ryzen&sourceIds=source-2&statuses=rejected&askingPriceMin=1.5&askingPriceMax=2.5&expectedResaleMin=3&expectedResaleMax=4&differenceMin=5&differenceMax=6&identifyPartsStages=queued%2Cidentifying%2Csourcing_references%2Ccomparing%2Ccompleted%2Cfailed&pricingStatuses=partially_priced&limit=20&offset=0',
    );
  });

  it('omits both sort params when no column is sorted, leaving the server on its default ordering', async () => {
    const fetchMock = stubListingsFetch();

    await fetchListings({ limit: 20, offset: 0 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings?limit=20&offset=0');
    expect(url).not.toContain('sort');
  });

  it('omits sortDirection on its own when only a field is given, rather than sending an empty value', async () => {
    const fetchMock = stubListingsFetch();

    await fetchListings({ sortBy: 'title' });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings?sortBy=title');
  });
});
