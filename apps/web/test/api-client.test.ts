import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient, ApiError } from '../src/lib/api-client';

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
