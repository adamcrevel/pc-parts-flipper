import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentifyPartsJob } from '@pc-parts-flipper/shared';
import { apiClient, ApiError, buildPhotoUrl } from '../src/lib/api-client';
import {
  enqueueIdentifyPartsJob,
  fetchIdentifyPartsJob,
  fetchLatestIdentifyPartsJob,
  ackIdentifyPartsJob,
} from '../src/features/listings/listings-api';

// Proves api-client.ts's error path (T4): a non-2xx response from the
// backend must reject with an ApiError carrying the HTTP status and a
// usable, displayable message — not a bare rejected promise or a generic
// fetch/SyntaxError a caller can't branch on. Mocks global fetch instead of
// a real server since this is purely testing apiRequest/parseResponse's own
// error-shaping logic, not the backend.
describe('apiClient error path', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects with an ApiError carrying status and the backend message on a non-2xx JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Source not found', statusCode: 404 } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const call = apiClient.get('/api/sources/999');

    await expect(call).rejects.toBeInstanceOf(ApiError);
    // Re-await in a try/catch (rather than a second `rejects` assertion on
    // the same already-settled promise) to inspect both fields the error
    // path is supposed to surface: the exact status code and the backend's
    // own message text, not just "some error happened".
    try {
      await call;
      throw new Error('expected apiClient.get to reject');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.message).toBe('Source not found');
    }
  });

  it('falls back to a generic-but-usable message when the non-2xx response has no JSON body', async () => {
    // Empty body (e.g. a bare 500 from a proxy with no JSON error payload) —
    // parseResponse still must throw ApiError, not crash on JSON.parse.
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await apiClient.get('/api/sources');
      throw new Error('expected apiClient.get to reject');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(502);
      expect(apiErr.message).toBe('Request to /api/sources failed with status 502');
    }
  });

  it('resolves with the parsed body on a 2xx response instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1', name: 'eBay' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiClient.get('/api/sources/1')).resolves.toEqual({ id: '1', name: 'eBay' });
  });
});

// Proves buildPhotoUrl itself produces a correct, loadable URL — not just
// that some caller invokes it. A test that derives its "expected" value by
// calling buildPhotoUrl() a second time (as photo-upload.test.tsx's
// component-level assertions do) would stay green even if the `/` join
// were dropped (e.g. producing `http://localhost:3001photos/x.jpg`), since
// both sides of such an assertion are equally broken. This test instead
// compares against a literal string, independent of the function under
// test, built from this project's documented default VITE_API_BASE_URL
// (see .env.example) which test/vite config leaves unset.
describe('buildPhotoUrl', () => {
  it('joins the default API base URL and a photoPaths entry with exactly one slash', () => {
    expect(buildPhotoUrl('photos/listing-1-aaaa.jpg')).toBe('http://localhost:3001/photos/listing-1-aaaa.jpg');
  });
});

// Pins the one piece of listings-api.ts's identify-parts job wrappers
// (enqueueIdentifyPartsJob/fetchIdentifyPartsJob/fetchLatestIdentifyPartsJob/
// ackIdentifyPartsJob) that every other test in this workspace mocks away:
// the exact routes and verbs they call. The component tests
// (identify-parts.test.tsx) stub the whole listings-api module, so a wrong
// path or verb here would go unnoticed by all of them while breaking
// against the real backend, whose routes (T3's identify-parts-queue) are a
// contract agreed with apps/server (see identifyPartsRoute.test.ts and
// identifyPartsJobsRoute.test.ts there).
describe('identify-parts job wrapper request shapes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const job: IdentifyPartsJob = {
    id: 'job-1',
    listingId: 'listing-1',
    stage: 'queued',
    parts: null,
    notes: null,
    errorMessage: null,
    delivered: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
  };

  it('enqueueIdentifyPartsJob POSTs to /api/listings/:id/identify-parts and resolves with the parsed job', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(job), { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(enqueueIdentifyPartsJob('listing-1')).resolves.toEqual(job);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings/listing-1/identify-parts');
    expect(init.method).toBe('POST');
  });

  it('fetchIdentifyPartsJob GETs /api/identify-parts-jobs/:id and resolves with the parsed job', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(job), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchIdentifyPartsJob('job-1')).resolves.toEqual(job);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/identify-parts-jobs/job-1');
    expect(init.method).toBe('GET');
  });

  it('fetchLatestIdentifyPartsJob GETs /api/listings/:id/identify-parts-jobs/latest and resolves with the parsed job', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(job), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLatestIdentifyPartsJob('listing-1')).resolves.toEqual(job);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/listings/listing-1/identify-parts-jobs/latest');
    expect(init.method).toBe('GET');
  });

  it('fetchLatestIdentifyPartsJob resolves with null instead of throwing when the backend has no job yet (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'No identify-parts job for this listing', statusCode: 404 } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLatestIdentifyPartsJob('listing-1')).resolves.toBeNull();
  });

  it('ackIdentifyPartsJob POSTs to /api/identify-parts-jobs/:id/ack', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await ackIdentifyPartsJob('job-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/identify-parts-jobs/job-1/ack');
    expect(init.method).toBe('POST');
  });
});

