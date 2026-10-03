// T5 proof: Source CRUD routes (Req 1: create/list/edit/deactivate) and
// Req 13 ("every form rejects save on a blank required field ... with
// inline error — never silently accepts") as implemented by
// apps/server/src/routes/sources.ts + apps/server/src/db/queries/sources.ts.
//
// Follows the same real-server-via-child-process pattern as T14's
// concurrency.test.ts (apps/server/test/helpers.ts's startTestServer): boots
// the actual Fastify app against an isolated temp DuckDB file and exercises
// the real /api/sources HTTP routes end to end, rather than importing the
// handler functions directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJson, patchJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Distinct from concurrency.test.ts's 34_591 so the two suites can run
// concurrently (e.g. `vitest run` executing both files in parallel workers)
// without a port collision.
const TEST_PORT = 34_597;

// Shape returned by the real Source routes (POST/PUT/GET/PATCH /api/sources*).
interface SourceResponse {
  id: string;
  name: string;
  platformType: string;
  url: string | null;
  notes: string | null;
  active: boolean;
  connectorConfig: string | null;
}

// Shape of the centralized error-handler body (error-handler.ts) that every
// AppError-driven 400 response returns.
interface ErrorResponse {
  error: { message: string; statusCode: number };
}

// PUT isn't in helpers.ts's postJson/patchJson/getJson trio (no other task's
// test needs it yet), so it's defined locally here rather than editing the
// shared helpers file out from under sibling test files editing it in the
// same batch.
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

describe('Source CRUD routes (T5)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
  }, 95_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('creates a Source via POST /api/sources and returns it with a generated id', async () => {
    const res = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Example eBay Store',
      platformType: 'ebay',
      url: 'https://example.com/store',
      notes: 'Reliable seller',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.name).toBe('Example eBay Store');
    expect(res.body.platformType).toBe('ebay');
    expect(res.body.url).toBe('https://example.com/store');
    expect(res.body.notes).toBe('Reliable seller');
    expect(res.body.active).toBe(true);

    // Round-trip through GET /api/sources to confirm the create was actually
    // persisted, not just echoed back in the POST response.
    const list = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    expect(list.body.some((s) => s.id === res.body.id && s.name === 'Example eBay Store')).toBe(true);
  });

  it('edits a Source via PUT /api/sources/:id and persists the change', async () => {
    const created = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Facebook Group A',
      platformType: 'facebook_marketplace',
      url: 'https://facebook.com/groups/a',
      notes: null,
    });
    expect(created.status).toBe(201);

    const updated = await putJson<SourceResponse>(`${server.baseUrl}/api/sources/${created.body.id}`, {
      name: 'Facebook Group A (renamed)',
      platformType: 'facebook_marketplace',
      url: 'https://facebook.com/groups/a-renamed',
      notes: 'Now has notes',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Facebook Group A (renamed)');
    expect(updated.body.url).toBe('https://facebook.com/groups/a-renamed');
    expect(updated.body.notes).toBe('Now has notes');

    // Re-fetch independently to confirm the edit actually persisted to the
    // database rather than only being reflected in the PUT response body.
    const refetched = await getJson<SourceResponse>(`${server.baseUrl}/api/sources/${created.body.id}`);
    expect(refetched.body.name).toBe('Facebook Group A (renamed)');
    expect(refetched.body.notes).toBe('Now has notes');
  });

  it('deactivates a Source via PATCH /api/sources/:id/deactivate without deleting it', async () => {
    const created = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Source To Deactivate',
      platformType: 'other',
      url: 'https://example.com/other',
      notes: null,
    });
    expect(created.status).toBe(201);
    expect(created.body.active).toBe(true);

    const deactivated = await patchJson<SourceResponse>(`${server.baseUrl}/api/sources/${created.body.id}/deactivate`, {});
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.active).toBe(false);

    // The row must still exist (deactivate, not delete): GET by id still
    // finds it, now with active: false.
    const refetched = await getJson<SourceResponse>(`${server.baseUrl}/api/sources/${created.body.id}`);
    expect(refetched.status).toBe(200);
    expect(refetched.body.active).toBe(false);
  });

  it('rejects POST /api/sources with a blank name with 400 and an inline error, without creating a row', async () => {
    const before = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    const countBefore = before.body.length;

    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/sources`, {
      name: '   ',
      platformType: 'ebay',
      url: 'https://example.com/blank-name',
      notes: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/name/i);

    // Never silently accepts: the row count must be unchanged.
    const after = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    expect(after.body.length).toBe(countBefore);
  });

  it('rejects POST /api/sources with a missing/invalid platformType with 400 and an inline error', async () => {
    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Valid Name',
      platformType: 'craigslist', // not in the ebay|facebook_marketplace|other enum
      url: 'https://example.com/bad-platform',
      notes: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/platformType/i);
  });

  it('rejects POST /api/sources with a blank url with 400 and an inline error', async () => {
    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Valid Name',
      platformType: 'ebay',
      url: '',
      notes: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/url/i);
  });

  it('accepts a valid eBay connectorConfig on POST and round-trips it on the created Source', async () => {
    const res = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'eBay Scanner Source',
      platformType: 'ebay',
      url: 'https://example.com/ebay-store',
      notes: null,
      connectorConfig: { queries: ['ryzen 7 5800x', 'rtx 3080'], maxPrice: 500 },
    });

    expect(res.status).toBe(201);
    expect(JSON.parse(res.body.connectorConfig as string)).toEqual({ queries: ['ryzen 7 5800x', 'rtx 3080'], maxPrice: 500 });

    // Round-trip through GET /api/sources/:id to confirm the config was
    // actually persisted, not just echoed back in the POST response.
    const refetched = await getJson<SourceResponse>(`${server.baseUrl}/api/sources/${res.body.id}`);
    expect(JSON.parse(refetched.body.connectorConfig as string)).toEqual({ queries: ['ryzen 7 5800x', 'rtx 3080'], maxPrice: 500 });
  });

  it('rejects an ebay connectorConfig with an empty queries array with 400 and an inline error, without creating a row', async () => {
    const before = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    const countBefore = before.body.length;

    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/sources`, {
      name: 'eBay Scanner Source',
      platformType: 'ebay',
      url: 'https://example.com/ebay-store-empty-queries',
      notes: null,
      connectorConfig: { queries: [] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/queries/i);

    // Never silently accepts/drops the invalid config: the row count must be unchanged.
    const after = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    expect(after.body.length).toBe(countBefore);
  });

  it('rejects an ebay connectorConfig with a blank query string with 400 and an inline error, without creating a row', async () => {
    const before = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    const countBefore = before.body.length;

    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/sources`, {
      name: 'eBay Scanner Source',
      platformType: 'ebay',
      url: 'https://example.com/ebay-store-blank-query',
      notes: null,
      connectorConfig: { queries: ['valid query', '   '] },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/queries/i);

    // Never silently accepts/drops the invalid config: the row count must be unchanged.
    const after = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    expect(after.body.length).toBe(countBefore);
  });

  it('rejects an ebay connectorConfig with a negative maxPrice with 400 and an inline error, without creating a row', async () => {
    const before = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    const countBefore = before.body.length;

    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/sources`, {
      name: 'eBay Scanner Source',
      platformType: 'ebay',
      url: 'https://example.com/ebay-store-negative-price',
      notes: null,
      connectorConfig: { queries: ['valid query'], maxPrice: -5 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/maxPrice/i);

    // Never silently accepts/drops the invalid config: the row count must be unchanged.
    const after = await getJson<SourceResponse[]>(`${server.baseUrl}/api/sources`);
    expect(after.body.length).toBe(countBefore);
  });

  it('accepts a connectorConfig on a non-ebay Source without applying eBay shape validation', async () => {
    // platformType 'other' is not 'ebay', so the queries/maxPrice rules do
    // not apply (Requirement 1 scopes them to eBay sources specifically) —
    // an empty queries array here must NOT be rejected the way it would be
    // for an ebay Source.
    const res = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Non-eBay Source With Config',
      platformType: 'other',
      url: 'https://example.com/other-store',
      notes: null,
      connectorConfig: { queries: [] },
    });

    expect(res.status).toBe(201);
    expect(JSON.parse(res.body.connectorConfig as string)).toEqual({ queries: [] });
  });
});
