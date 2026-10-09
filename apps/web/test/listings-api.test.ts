import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentifyPartsBulkResult } from '@pc-parts-flipper/shared';
import { fetchListingIds, enqueueBulkIdentifyParts } from '../src/features/listings/listings-api';

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

  it('fetchListingIds GETs /api/listings/ids with status and sourceId query params and resolves with the unwrapped ids array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ids: ['listing-1', 'listing-2'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchListingIds({ status: 'open', sourceId: 'source-1' })).resolves.toEqual([
      'listing-1',
      'listing-2',
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings/ids?status=open&sourceId=source-1');
    expect(init.method).toBe('GET');
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
