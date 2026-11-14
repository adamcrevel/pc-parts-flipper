// Proof for the comp link-liveness verifier
// (apps/server/src/ai/compLinkVerifier.ts): live/archived/dropped/
// inconclusive outcomes and per-comp failure isolation.
//
// The real archive.org/marketplace network is NEVER hit here —
// setLinkCheckFetchOverride installs a fake `fetch` instead, mirroring
// ompSourcingRunner.test.ts's own override-seam pattern (setOmpSourcing-
// RunnerOverride / getOmpSourcingRunner).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PriceComp } from '@pc-parts-flipper/shared';
import { setLinkCheckFetchOverride, verifyAndResolveComps } from '../src/ai/compLinkVerifier.js';

// A baseline comp; tests override only the fields they care about so each
// case stays focused on what it's actually proving.
function comp(overrides: Partial<PriceComp> = {}): PriceComp {
  return {
    title: 'Test comp',
    url: 'https://example.com/listing/1',
    priceUsd: 100,
    condition: 'used',
    saleType: 'sold',
    linkStatus: null,
    ...overrides,
  };
}

// Routes the fake `fetch` by exact URL string to a per-URL handler. A URL
// with no registered handler throws rather than silently resolving, so a
// test that expects a given endpoint to never be called (e.g. the Wayback
// lookup in the inconclusive cases) can prove it by never registering a
// handler for it.
function routedFetch(handlers: Record<string, () => Promise<Response> | Response | Promise<never>>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = handlers[url];
    if (handler === undefined) {
      throw new Error(`unexpected fetch call: ${url}`);
    }
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const WAYBACK_URL = (url: string): string => `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;

afterEach(() => {
  setLinkCheckFetchOverride(null);
});

describe('verifyAndResolveComps', () => {
  it('marks a comp live on a clean 200, leaving its url unchanged', async () => {
    const input = comp({ url: 'https://example.com/live' });
    setLinkCheckFetchOverride(routedFetch({ [input.url]: () => new Response(null, { status: 200 }) }));

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([{ ...input, linkStatus: 'live' }]);
  });

  it('marks a comp live on a clean 3xx (a redirect the stub resolves to), leaving its url unchanged', async () => {
    const input = comp({ url: 'https://example.com/redirected' });
    setLinkCheckFetchOverride(routedFetch({ [input.url]: () => new Response(null, { status: 301 }) }));

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([{ ...input, linkStatus: 'live' }]);
  });

  it('swaps url for the Wayback Machine snapshot and marks archived on a confirmed-dead 404 with an available snapshot', async () => {
    const input = comp({ url: 'https://example.com/dead-404' });
    const snapshotUrl = 'https://web.archive.org/web/20200101000000/https://example.com/dead-404';
    setLinkCheckFetchOverride(
      routedFetch({
        [input.url]: () => new Response(null, { status: 404 }),
        [WAYBACK_URL(input.url)]: () =>
          jsonResponse(200, { archived_snapshots: { closest: { available: true, url: snapshotUrl } } }),
      }),
    );

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([{ ...input, url: snapshotUrl, linkStatus: 'archived' }]);
  });

  it('swaps url for the Wayback Machine snapshot and marks archived on a confirmed-dead 410 with an available snapshot', async () => {
    const input = comp({ url: 'https://example.com/dead-410' });
    const snapshotUrl = 'https://web.archive.org/web/20200101000000/https://example.com/dead-410';
    setLinkCheckFetchOverride(
      routedFetch({
        [input.url]: () => new Response(null, { status: 410 }),
        [WAYBACK_URL(input.url)]: () =>
          jsonResponse(200, { archived_snapshots: { closest: { available: true, url: snapshotUrl } } }),
      }),
    );

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([{ ...input, url: snapshotUrl, linkStatus: 'archived' }]);
  });

  it('drops a confirmed-dead comp entirely when no Wayback Machine snapshot is available', async () => {
    const input = comp({ url: 'https://example.com/dead-no-snapshot' });
    setLinkCheckFetchOverride(
      routedFetch({
        [input.url]: () => new Response(null, { status: 404 }),
        [WAYBACK_URL(input.url)]: () => jsonResponse(200, { archived_snapshots: {} }),
      }),
    );

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([]);
  });

  it('drops a confirmed-dead comp entirely when the Wayback Machine lookup itself answers non-ok (not a snapshot-not-found case)', async () => {
    const input = comp({ url: 'https://example.com/dead-wayback-non-ok' });
    setLinkCheckFetchOverride(
      routedFetch({
        [input.url]: () => new Response(null, { status: 404 }),
        [WAYBACK_URL(input.url)]: () => new Response('Service Unavailable', { status: 503 }),
      }),
    );

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([]);
  });

  it('drops a confirmed-dead comp entirely when the Wayback Machine lookup itself throws (not a snapshot-not-found case)', async () => {
    const input = comp({ url: 'https://example.com/dead-wayback-throws' });
    setLinkCheckFetchOverride(
      routedFetch({
        [input.url]: () => new Response(null, { status: 404 }),
        [WAYBACK_URL(input.url)]: () => {
          throw new Error('archive.org is down');
        },
      }),
    );

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([]);
  });

  it('leaves a comp unchanged with linkStatus null on a network error, without calling the Wayback lookup', async () => {
    const input = comp({ url: 'https://example.com/network-error' });
    const fetchMock = vi.fn(async (urlArg: string | URL | Request) => {
      const url = typeof urlArg === 'string' ? urlArg : urlArg instanceof URL ? urlArg.href : urlArg.url;
      if (url === input.url) {
        throw new TypeError('fetch failed');
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    setLinkCheckFetchOverride(fetchMock as unknown as typeof fetch);

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([{ ...input, linkStatus: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a comp unchanged with linkStatus null on a timeout, without calling the Wayback lookup', async () => {
    const input = comp({ url: 'https://example.com/timeout' });
    const fetchMock = vi.fn(async (urlArg: string | URL | Request) => {
      const url = typeof urlArg === 'string' ? urlArg : urlArg instanceof URL ? urlArg.href : urlArg.url;
      if (url === input.url) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    setLinkCheckFetchOverride(fetchMock as unknown as typeof fetch);

    const result = await verifyAndResolveComps([input]);

    expect(result).toEqual([{ ...input, linkStatus: null }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429, 500, 503])(
    'leaves a comp unchanged with linkStatus null on a blocking %i, without calling the Wayback lookup',
    async (status) => {
      const input = comp({ url: `https://example.com/blocked-${status}` });
      const fetchMock = routedFetch({ [input.url]: () => new Response(null, { status }) });
      setLinkCheckFetchOverride(fetchMock);

      const result = await verifyAndResolveComps([input]);

      expect(result).toEqual([{ ...input, linkStatus: null }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('isolates one comp\'s unexpected failure from a sibling comp in the same call', async () => {
    const failing = comp({ title: 'Failing comp', url: 'https://example.com/throws' });
    const succeeding = comp({ title: 'Succeeding comp', url: 'https://example.com/ok' });
    const fetchMock = vi.fn(async (urlArg: string | URL | Request) => {
      const url = typeof urlArg === 'string' ? urlArg : urlArg instanceof URL ? urlArg.href : urlArg.url;
      if (url === failing.url) {
        throw new Error('completely unexpected failure');
      }
      if (url === succeeding.url) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    setLinkCheckFetchOverride(fetchMock as unknown as typeof fetch);

    const result = await verifyAndResolveComps([failing, succeeding]);

    expect(result).toEqual([
      { ...failing, linkStatus: null },
      { ...succeeding, linkStatus: 'live' },
    ]);
  });

  it('drops a confirmed-dead comp whose Wayback lookup throws without affecting a sibling comp in the same call', async () => {
    const failing = comp({ title: 'Wayback throws', url: 'https://example.com/dead-wayback-throws-sibling' });
    const succeeding = comp({ title: 'Succeeding comp', url: 'https://example.com/ok-2' });
    const fetchMock = vi.fn(async (urlArg: string | URL | Request) => {
      const url = typeof urlArg === 'string' ? urlArg : urlArg instanceof URL ? urlArg.href : urlArg.url;
      if (url === failing.url) {
        return new Response(null, { status: 404 });
      }
      if (url === WAYBACK_URL(failing.url)) {
        throw new Error('archive.org is down');
      }
      if (url === succeeding.url) {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });
    setLinkCheckFetchOverride(fetchMock as unknown as typeof fetch);

    const result = await verifyAndResolveComps([failing, succeeding]);

    expect(result).toEqual([{ ...succeeding, linkStatus: 'live' }]);
  });
});

describe('setLinkCheckFetchOverride', () => {
  it('reverts to the real global fetch once the override is cleared', async () => {
    const input = comp({ url: 'https://example.com/cleared-override' });
    const fetchMock = routedFetch({ [input.url]: () => new Response(null, { status: 200 }) });
    setLinkCheckFetchOverride(fetchMock);
    await verifyAndResolveComps([input]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    setLinkCheckFetchOverride(null);

    const realFetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await verifyAndResolveComps([input]);
    expect(realFetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    realFetchSpy.mockRestore();
  });
});
