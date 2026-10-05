// T6 proof: Listing CRUD (POST/GET/PUT /api/listings) with nested Expected
// Parts, the Req 3 comparison calculation, and Req 13 validation (blank
// required field / negative monetary field rejected with inline error).
// Boots the real server via helpers.ts's startTestServer, the same pattern
// T14's concurrency.test.ts uses, so these assertions exercise the actual
// HTTP routes/validation/db-query code rather than a mock. Deliberately
// never touches POST /api/listings/:id/accept or /reject — those belong to
// T7's tester.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateListingInput, ListingDetail, ListListingsResponse } from '@pc-parts-flipper/shared';
import { getJson, postJson, startTestServer, type JsonResponse, type TestServer } from './helpers.js';

// Arbitrary high port distinct from concurrency.test.ts's 34_591 so this
// suite can run standalone or alongside it without a port collision.
const TEST_PORT = 34_602;

interface SourceResponse {
  id: string;
}

// PUTs `body` as JSON to `url` and returns the parsed response status/body.
// Not added to the shared helpers.ts (other testers run against that file
// concurrently in this batch); kept local to this file instead.
async function putJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

// Builds a valid create-Listing request body; callers override individual
// fields per test via the spread.
function listingBody(sourceId: string, overrides: Partial<CreateListingInput> = {}): CreateListingInput {
  return {
    sourceId,
    title: 'Dell Optiplex 7080 bundle',
    description: 'Untested, seller says it powers on',
    listingUrl: 'https://example.com/listing/7080',
    askingPrice: 100,
    listingDate: '2026-01-15',
    acquisitionFees: 25,
    expectedParts: [
      { componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-10700', description: 'Pulled from a working machine', estimatedResaleValue: 60 },
      { componentCategory: 'RAM', brand: null, partNumber: null, description: '16GB DDR4', estimatedResaleValue: 30 },
      { componentCategory: 'Storage', brand: 'Samsung', partNumber: null, description: '512GB NVMe', estimatedResaleValue: 20 },
    ],
    ...overrides,
  };
}

describe('Listing CRUD + Expected Parts + Req-3 comparison (T6)', () => {
  let server: TestServer;
  let sourceId: string;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'T6 Test Source',
      platformType: 'ebay',
      url: 'https://example.com/t6-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  it('creates a Listing with nested Expected Parts and round-trips them via GET', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.title).toBe('Dell Optiplex 7080 bundle');
    expect(created.body.status).toBe('open');
    expect(created.body.expectedParts).toHaveLength(3);
    // Every Expected Part row must carry a generated id distinct from its
    // siblings (proves the nested rows were actually persisted, not just
    // echoed back from the request body).
    const partIds = new Set(created.body.expectedParts.map((p) => p.id));
    expect(partIds.size).toBe(3);
    expect(new Set(created.body.expectedParts.map((p) => p.listingId))).toEqual(new Set([created.body.id]));

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.title).toBe(created.body.title);
    // The round-trip set must match exactly on the fields the client
    // submitted, not merely have the same length.
    const fetchedSorted = [...fetched.body.expectedParts].sort((a, b) => a.description.localeCompare(b.description));
    expect(fetchedSorted.map((p) => ({ componentCategory: p.componentCategory, brand: p.brand, partNumber: p.partNumber, description: p.description, estimatedResaleValue: p.estimatedResaleValue }))).toEqual([
      { componentCategory: 'Storage', brand: 'Samsung', partNumber: null, description: '512GB NVMe', estimatedResaleValue: 20 },
      { componentCategory: 'RAM', brand: null, partNumber: null, description: '16GB DDR4', estimatedResaleValue: 30 },
      { componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-10700', description: 'Pulled from a working machine', estimatedResaleValue: 60 },
    ].sort((a, b) => a.description.localeCompare(b.description)));
  });

  it('accepts an Expected Part with brand/partNumber omitted entirely, normalizing both to null', async () => {
    // The optional half of the contract: a component the user could not
    // identify is submitted without these keys at all and must come back as
    // null — never as an empty string, and never rejected as a missing
    // required field.
    // Deliberately built as an untyped object rather than through
    // listingBody: the point of this test is a wire body that genuinely
    // lacks the keys, which the typed CreateListingInput cannot express.
    const body = {
      ...listingBody(sourceId),
      expectedParts: [{ componentCategory: 'PSU', description: '650W, no label visible', estimatedResaleValue: 25 }],
    };
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, body);

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].brand).toBeNull();
    expect(created.body.expectedParts[0].partNumber).toBeNull();
  });

  it('normalizes a blank/whitespace brand and partNumber to null, and trims a real one', async () => {
    // Whitespace-only input is the realistic failure mode of a form field the
    // user tabbed through: it must be stored as "not identified", not as text
    // that would later render as a leading space in a sale listing title.
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId, {
      expectedParts: [
        { componentCategory: 'GPU', brand: '   ', partNumber: '', description: 'Unidentified card', estimatedResaleValue: 150 },
        { componentCategory: 'CPU', brand: '  AMD  ', partNumber: '  Ryzen 5 5600X ', description: 'Boxed', estimatedResaleValue: 90 },
      ],
    }));

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    const gpu = created.body.expectedParts.find((p) => p.componentCategory === 'GPU');
    expect(gpu?.brand).toBeNull();
    expect(gpu?.partNumber).toBeNull();
    const cpu = created.body.expectedParts.find((p) => p.componentCategory === 'CPU');
    expect(cpu?.brand).toBe('AMD');
    expect(cpu?.partNumber).toBe('Ryzen 5 5600X');
  });

  it('computes the Req-3 comparison correctly for a known input, on both GET detail and GET list', async () => {
    // Known input: expected resale 60+30+20=110; cost 100 asking + 25 fees =
    // 125; difference 110-125=-15 (expected loss on paper). Every number
    // here is hand-computed from the spec, not derived from the code under
    // test.
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status).toBe(201);
    expect(created.body.comparison).toEqual({ totalExpectedResaleValue: 110, totalCost: 125, difference: -15 });

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.comparison).toEqual({ totalExpectedResaleValue: 110, totalCost: 125, difference: -15 });

    // Req 12: the Listings queue list rows carry the same comparison value.
    const list = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=200`);
    const row = list.body.listings.find((l) => l.id === created.body.id);
    expect(row, 'created Listing must appear in GET /api/listings').toBeDefined();
    expect(row?.comparison).toEqual({ totalExpectedResaleValue: 110, totalCost: 125, difference: -15 });
  });

  it('rejects a blank required field (title) with 400 and an inline-usable error naming the field, never silently accepting', async () => {
    const res = await postJson<{ error?: { message?: string; statusCode?: number } }>(`${server.baseUrl}/api/listings`, listingBody(sourceId, { title: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error?.statusCode).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "title", got ${JSON.stringify(res.body)}`).toMatch(/title/i);

    // Must not have been persisted: list total is unaffected by the
    // rejected attempt.
    const before = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    const res2 = await postJson<{ error?: { message?: string } }>(`${server.baseUrl}/api/listings`, listingBody(sourceId, { title: '' }));
    expect(res2.status).toBe(400);
    const after = await getJson<ListListingsResponse>(`${server.baseUrl}/api/listings?limit=1`);
    expect(after.body.total, 'a rejected create must not change the stored Listing count').toBe(before.body.total);
  });

  it('rejects a negative monetary field (askingPrice) with 400 naming the field, never silently accepting', async () => {
    const res = await postJson<{ error?: { message?: string } }>(`${server.baseUrl}/api/listings`, listingBody(sourceId, { askingPrice: -5 }));
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "askingPrice", got ${JSON.stringify(res.body)}`).toMatch(/askingPrice/i);
  });

  it('rejects a negative Expected Part estimatedResaleValue with 400 naming the field, never silently accepting', async () => {
    const res = await postJson<{ error?: { message?: string } }>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, { expectedParts: [{ componentCategory: 'CPU', description: 'i7', estimatedResaleValue: -1 }] }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.message, `expected an error message naming "estimatedResaleValue", got ${JSON.stringify(res.body)}`).toMatch(/estimatedResaleValue/i);
  });

  it('PUT fully replaces a Listing\'s Expected Parts set (old rows gone, new rows present)', async () => {
    const created = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody(sourceId));
    expect(created.status).toBe(201);
    const oldPartIds = new Set(created.body.expectedParts.map((p) => p.id));

    const updated = await putJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`, {
      ...listingBody(sourceId),
      title: 'Dell Optiplex 7080 bundle (revised)',
      askingPrice: 80,
      expectedParts: [{ componentCategory: 'GPU', description: 'GTX 1660', estimatedResaleValue: 90 }],
    });
    expect(updated.status, `update failed: ${JSON.stringify(updated.body)}`).toBe(200);
    expect(updated.body.title).toBe('Dell Optiplex 7080 bundle (revised)');
    expect(updated.body.expectedParts).toHaveLength(1);
    expect(updated.body.expectedParts[0].componentCategory).toBe('GPU');
    // None of the replaced rows' ids survive the full-replace.
    for (const part of updated.body.expectedParts) {
      expect(oldPartIds.has(part.id)).toBe(false);
    }

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.expectedParts).toHaveLength(1);
    expect(fetched.body.expectedParts[0].description).toBe('GTX 1660');
  });
});
