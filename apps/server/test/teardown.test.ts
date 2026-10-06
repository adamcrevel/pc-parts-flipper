// T9 integration proof for the Req 6 teardown workflow (teardown.ts +
// teardownValidation.ts + db/queries/teardownResults.ts): boots the real
// server (helpers.ts, the same pattern as concurrency.test.ts) and drives
// the actual HTTP endpoints — no mocking of the db layer — so the proof
// covers the real reconciliation logic, not a stand-in for it.
//
// Two behaviors are proven:
//  1. A Purchase with a genuine mix of present_as_expected /
//     present_but_different / missing Expected Parts, plus one Additional
//     Part, moves to 'torn_down' and generates exactly one Part per
//     non-'missing' entry (expected + additional) — none for 'missing'.
//  2. Submitting teardown against a Purchase that isn't yet 'received' is
//     rejected (400) and leaves the Purchase's status untouched.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  AcceptListingResponse,
  CreateListingInput,
  ListPartsResponse,
  ListingDetail,
  Part,
  PurchaseDetail,
  SubmitTeardownResponse,
} from '@pc-parts-flipper/shared';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as ReferencePhotosModule from '../src/db/queries/referencePhotos.js';
import type * as LoggerModule from '../src/logger.js';
import { getJson, patchJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Mocks only the leaf module backing promoteReferencePhotos (re-exported from
// the db barrel, db/index.ts), wrapping the real implementation in a vi.fn so
// every test below gets genuine promotion behavior by default — only the one
// test that calls mockImplementationOnce actually overrides it, to prove the
// catch/log-Error path (standing check) without faking a real DB failure.
// Scoped to this file's own module graph; the spawned child-process server
// the describe block above uses runs in a separate OS process and is
// entirely unaffected by this.
vi.mock('../src/db/queries/referencePhotos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ReferencePhotosModule>();
  return { ...actual, promoteReferencePhotos: vi.fn(actual.promoteReferencePhotos) };
});

// Distinct from every other suite's TEST_PORT (concurrency.test.ts: 34_591,
// parts.test.ts: 34_592 — NOT 34_592 despite that port's doc-comment claim
// elsewhere, it's actually taken — profit.test.ts/saleListings.test.ts:
// 34_593, sources.test.ts: 34_597, purchases.test.ts: 34_599, app-shell.
// test.ts: 34_601, listings.test.ts: 34_602, sales.test.ts: 34_612) so this
// suite can run concurrently with the rest without a port collision. (The
// nested describe block below uses its own HOOK_PORT, 34_632; see that
// block's comment — listingPhotos.test.ts's nested PHOTO_HOOK_PORT is
// 34_633, not 34_632, to avoid colliding with it.)
const TEST_PORT = 34_625;

interface SourceResponse {
  id: string;
}

describe('teardown workflow proof (T9)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer(TEST_PORT);
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  }, 30_000);

  // Creates a Source, a Listing with three distinct Expected Parts (one per
  // non-additional TeardownResultType), and accepts it into a fresh
  // Purchase. Returns everything a teardown submission needs. Shared by
  // both tests below so each gets its own isolated Purchase.
  async function createPurchaseWithThreeExpectedParts(label: string): Promise<{ purchaseId: string; expectedPartIds: { cpu: string; gpu: string; ram: string } }> {
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: `Teardown Test Source ${label}`,
      platformType: 'ebay',
      url: `https://example.com/teardown-test-${label}`,
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);

    const listingBody: CreateListingInput = {
      sourceId: sourceRes.body.id,
      title: `Teardown Test Listing ${label}`,
      description: null,
      listingUrl: `https://example.com/listing-${label}`,
      askingPrice: 100,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      expectedParts: [
        { componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-10700', description: `Test CPU ${label}`, estimatedResaleValue: 50 },
        { componentCategory: 'GPU', brand: null, partNumber: null, description: `Test GPU ${label}`, estimatedResaleValue: 80 },
        { componentCategory: 'RAM', brand: 'Corsair', partNumber: 'CMK16GX4M2B3200C16', description: `Test RAM ${label}`, estimatedResaleValue: 20 },
      ],
    };
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody);
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    // Order of expectedParts in the response isn't guaranteed to match
    // submission order (DuckDB row order), so look each one up by its
    // distinguishing componentCategory rather than assuming array position.
    const cpu = listingRes.body.expectedParts.find((part) => part.componentCategory === 'CPU')!;
    const gpu = listingRes.body.expectedParts.find((part) => part.componentCategory === 'GPU')!;
    const ram = listingRes.body.expectedParts.find((part) => part.componentCategory === 'RAM')!;

    const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
    expect(acceptRes.status, `accept failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);

    return { purchaseId: acceptRes.body.purchaseId, expectedPartIds: { cpu: cpu.id, gpu: gpu.id, ram: ram.id } };
  }

  it('rejects a teardown submission when the Purchase is not yet received', async () => {
    const { purchaseId, expectedPartIds } = await createPurchaseWithThreeExpectedParts('reject-not-received');

    // Freshly-accepted Purchase starts 'ordered' (Req 5), not 'received' —
    // submitting teardown here must be rejected rather than silently
    // accepted.
    const res = await postJson<{ message?: string }>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [
        { expectedPartId: expectedPartIds.cpu, result: 'present_as_expected', note: null },
        { expectedPartId: expectedPartIds.gpu, result: 'present_as_expected', note: null },
        { expectedPartId: expectedPartIds.ram, result: 'present_as_expected', note: null },
      ],
      additionalParts: [],
    });
    expect(res.status, `expected 400 for teardown of a non-received purchase, got ${res.status}: ${JSON.stringify(res.body)}`).toBe(400);

    // Status must be untouched by the rejected submission.
    const after = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(after.body.status).toBe('ordered');
  });

  it('reconciles a mix of present/different/missing + an additional find into the right Part records', async () => {
    const { purchaseId, expectedPartIds } = await createPurchaseWithThreeExpectedParts('reconcile-mix');

    // Advance ordered -> shipped -> received (Req 5's forward-only
    // lifecycle) so teardown is actually legal for this Purchase.
    const shipped = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    const received = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    expect(received.status, JSON.stringify(received.body)).toBe(200);

    const submitRes = await postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [
        { expectedPartId: expectedPartIds.cpu, result: 'present_as_expected', note: null },
        { expectedPartId: expectedPartIds.gpu, result: 'present_but_different', note: 'Different GPU model than listed' },
        { expectedPartId: expectedPartIds.ram, result: 'missing', note: 'RAM never arrived' },
      ],
      additionalParts: [{ category: 'Storage', brand: 'Samsung', partNumber: '970 EVO', description: 'Bonus SSD found inside', note: 'Not on the listing' }],
    });
    expect(submitRes.status, `teardown submission failed: ${JSON.stringify(submitRes.body)}`).toBe(200);

    // The Purchase itself must have advanced to torn_down.
    expect(submitRes.body.purchaseStatus).toBe('torn_down');

    // Four reconciliation lines recorded: one per Expected Part plus the
    // one Additional Part.
    expect(submitRes.body.teardownResults).toHaveLength(4);

    // Exactly three Part records: CPU (present_as_expected) + GPU
    // (present_but_different) + the additional SSD. Zero for the missing
    // RAM — this is the count this test exists to pin down.
    expect(submitRes.body.createdParts, `expected exactly 3 created Parts (none for the missing RAM), got: ${JSON.stringify(submitRes.body.createdParts)}`).toHaveLength(3);
    const createdCategories = submitRes.body.createdParts.map((part) => part.category).sort();
    expect(createdCategories).toEqual(['CPU', 'GPU', 'Storage']);
    // Confirms the missing RAM specifically produced no Part, not just that
    // the total count happens to match.
    expect(createdCategories).not.toContain('RAM');

    // brand/partNumber must travel Expected Part -> Part for a reconciled
    // row, and Additional Part submission -> Part for an unexpected find.
    // Without this the Sale Listing default title silently degrades back to
    // `category: description` for every part in the system.
    const createdPart = (category: string): Part | undefined => submitRes.body.createdParts.find((part) => part.category === category);
    expect(createdPart('CPU')?.brand).toBe('Intel');
    expect(createdPart('CPU')?.partNumber).toBe('i7-10700');
    // The unidentified GPU stays unidentified — teardown must not invent an
    // identity for a part that never had one.
    expect(createdPart('GPU')?.brand).toBeNull();
    expect(createdPart('GPU')?.partNumber).toBeNull();
    // The additional find's identity comes from the teardown form itself.
    expect(createdPart('Storage')?.brand).toBe('Samsung');
    expect(createdPart('Storage')?.partNumber).toBe('970 EVO');
    // An Additional Part has no Expected Part behind it, so it must come
    // out with an empty candidate list rather than inheriting anything.
    expect(createdPart('Storage')?.identityCandidates).toEqual([]);

    // Reconcile against the real GET endpoint too, not just the POST
    // response — proves the Parts actually persisted, not just echoed back.
    const partsList = await getJson<ListPartsResponse>(`${server.baseUrl}/api/parts?purchaseId=${purchaseId}&limit=20`);
    expect(partsList.body.total).toBe(3);
    expect(partsList.body.parts.map((part) => part.category).sort()).toEqual(['CPU', 'GPU', 'Storage']);
    // Read back through the Parts list query too: that endpoint selects an
    // explicit column list rather than `SELECT *`, so a column missing from
    // it would show up here and nowhere else.
    expect(partsList.body.parts.find((part) => part.category === 'CPU')?.partNumber).toBe('i7-10700');
    expect(partsList.body.parts.find((part) => part.category === 'Storage')?.brand).toBe('Samsung');

    // Purchase status change also persisted, not just echoed.
    const purchaseAfter = await getJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}`);
    expect(purchaseAfter.body.status).toBe('torn_down');
  });

  it('accepts an Additional Part with brand/partNumber omitted or blank, storing null on the Part', async () => {
    const { purchaseId, expectedPartIds } = await createPurchaseWithThreeExpectedParts('additional-optional');
    await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });

    const submitRes = await postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [
        { expectedPartId: expectedPartIds.cpu, result: 'missing', note: 'not present' },
        { expectedPartId: expectedPartIds.gpu, result: 'missing', note: 'not present' },
        { expectedPartId: expectedPartIds.ram, result: 'missing', note: 'not present' },
      ],
      // One row omits the keys entirely, the other sends whitespace: both
      // must validate and normalize to null rather than 400 or store blanks.
      additionalParts: [
        { category: 'Cooler', description: 'Unbranded tower cooler' },
        { category: 'Case', brand: '  ', partNumber: '   ', description: 'Generic ATX case' },
      ],
    });

    expect(submitRes.status, `teardown submission failed: ${JSON.stringify(submitRes.body)}`).toBe(200);
    expect(submitRes.body.createdParts).toHaveLength(2);
    for (const part of submitRes.body.createdParts) {
      expect(part.brand, `${part.category} brand should be null`).toBeNull();
      expect(part.partNumber, `${part.category} partNumber should be null`).toBeNull();
    }
  });

  it('carries a non-empty Expected Part identityCandidates array verbatim onto the created Part (Req 7)', async () => {
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Teardown Test Source identity-candidates',
      platformType: 'ebay',
      url: 'https://example.com/teardown-test-identity-candidates',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);

    const candidates = [
      { brand: 'NVIDIA', partNumber: 'RTX 3070' },
      { brand: 'NVIDIA', partNumber: 'RTX 3070 Ti' },
    ];
    // Built as a loosely-typed body (not CreateListingInput) the same way
    // listings.test.ts's identityCandidates tests do: identityCandidates is
    // not yet on every typed fixture builder in this repo (a gap the T6
    // reviewer separately flagged on the web side), so this avoids
    // depending on that.
    const listingBody = {
      sourceId: sourceRes.body.id,
      title: 'Teardown Test Listing identity-candidates',
      description: null,
      listingUrl: 'https://example.com/listing-identity-candidates',
      askingPrice: 100,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      expectedParts: [
        {
          componentCategory: 'GPU',
          brand: 'NVIDIA',
          partNumber: 'RTX 3070',
          description: 'Test GPU identity-candidates',
          estimatedResaleValue: 200,
          identityCandidates: candidates,
        },
      ],
    };
    const listingRes = await postJson<ListingDetail>(`${server.baseUrl}/api/listings`, listingBody);
    expect(listingRes.status, `seed Listing creation failed: ${JSON.stringify(listingRes.body)}`).toBe(201);
    expect(listingRes.body.expectedParts[0].identityCandidates).toEqual(candidates);
    const gpuExpectedPartId = listingRes.body.expectedParts[0].id;

    const acceptRes = await postJson<AcceptListingResponse>(`${server.baseUrl}/api/listings/${listingRes.body.id}/accept`, {});
    expect(acceptRes.status, `accept failed: ${JSON.stringify(acceptRes.body)}`).toBe(201);
    const purchaseId = acceptRes.body.purchaseId;

    const shipped = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    const received = await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(shipped.status, JSON.stringify(shipped.body)).toBe(200);
    expect(received.status, JSON.stringify(received.body)).toBe(200);

    const submitRes = await postJson<SubmitTeardownResponse>(`${server.baseUrl}/api/purchases/${purchaseId}/teardown`, {
      results: [{ expectedPartId: gpuExpectedPartId, result: 'present_as_expected', note: null }],
      additionalParts: [],
    });
    expect(submitRes.status, `teardown submission failed: ${JSON.stringify(submitRes.body)}`).toBe(200);
    expect(submitRes.body.createdParts).toHaveLength(1);

    // The sharpest assertion this test exists for: the created Part's
    // identityCandidates must be the exact same array the Expected Part
    // carried — not dropped to [], and not some other value.
    expect(submitRes.body.createdParts[0].identityCandidates).toEqual(candidates);

    // Reconcile against the real GET /api/parts endpoint too, not just the
    // POST response — proves the value actually persisted, not just echoed.
    const partsList = await getJson<ListPartsResponse>(`${server.baseUrl}/api/parts?purchaseId=${purchaseId}&limit=5`);
    expect(partsList.body.parts).toHaveLength(1);
    expect(partsList.body.parts[0].identityCandidates).toEqual(candidates);
  });

  it('POST Additional Part with null brand does not fail', async () => {
    const { purchaseId, expectedPartIds } = await createPurchaseWithThreeExpectedParts('T2 additional-null-brand');
    await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    await patchJson<PurchaseDetail>(`${server.baseUrl}/api/purchases/${purchaseId}/status`, { status: 'received' });
    const submitRes = await postJson<SubmitTeardownResponse>(
      `${server.baseUrl}/api/purchases/${purchaseId}/teardown`,
      {
        results: [
          { expectedPartId: expectedPartIds.cpu, result: 'missing', note: 'Not in the box' },
          { expectedPartId: expectedPartIds.gpu, result: 'missing', note: 'Not in the box' },
          { expectedPartId: expectedPartIds.ram, result: 'missing', note: 'Not in the box' },
        ],
        additionalParts: [
          {
            category: 'RAM',
            brand: null,
            partNumber: null,
            description: 'Unidentified RAM',
            note: null,
          },
        ],
      },
    );
    expect(submitRes.status, `teardown submission failed: ${JSON.stringify(submitRes.body)}`).toBe(200);
    expect(submitRes.body.createdParts).toHaveLength(1);
    expect(submitRes.body.createdParts[0].brand).toBeNull();
  });
});

// T2 proof (promotion hook wired into teardown.ts's additionalParts loop,
// Requirement 3), plus the thrown-promotion-failure standing check and the
// cross-code-path concurrency standing check. The describe block above
// exercises these same routes against the real HTTP contract via a spawned
// child-process server (helpers.ts), which has no way to directly inspect
// part_reference_photos — DuckDB only allows one process to hold this file
// open at a time. This block instead boots registerListingsRoutes +
// registerTeardownRoutes + registerPurchasesRoutes in-process (Fastify() +
// registerErrorHandler, the same pattern as scan.test.ts /
// identifyPartsRoute.test.ts), specifically so it can (a) run raw SQL against
// the exact connection the routes use to verify real row state, (b) force
// promoteReferencePhotos to throw via vi.mock, and (c) fire real concurrent
// HTTP requests from both promotion code paths (Listing PUT and teardown
// Additional Part) against the identical photo/category/brand/partNumber
// combination — the same proof style as core-workflow's T14 /
// ebay-scanning's T7.
describe('Reference photo promotion hook — DB-verified (T2)', () => {
  const HOOK_PORT = 34_632;
  const HOOK_BASE_URL = `http://127.0.0.1:${HOOK_PORT}`;
  let hookDataDir: string;
  let hookDb: typeof DbModule;
  let hookGetConnection: typeof ClientModule.getConnection;
  let referencePhotosModule: typeof ReferencePhotosModule;
  let hookLogger: typeof LoggerModule.logger;
  let hookApp: FastifyInstance;
  let hookSourceId: string;

  beforeAll(async () => {
    hookDataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-teardown-hook-test-'));
    process.env.DUCKDB_DATA_DIR = hookDataDir;
    // Dynamic import (same exception as db.test.ts/scan.test.ts): client.ts's
    // DATA_DIR is computed once, at module-evaluation time, from
    // DUCKDB_DATA_DIR — a static top-of-file import would evaluate before
    // this beforeAll sets the env var.
    hookDb = await import('../src/db/index.js');
    ({ getConnection: hookGetConnection } = await import('../src/db/client.js'));
    referencePhotosModule = await import('../src/db/queries/referencePhotos.js');
    ({ logger: hookLogger } = await import('../src/logger.js'));
    const { registerListingsRoutes } = await import('../src/routes/listings.js');
    const { registerTeardownRoutes } = await import('../src/routes/teardown.js');
    const { registerPurchasesRoutes } = await import('../src/routes/purchases.js');
    const { registerErrorHandler } = await import('../src/error-handler.js');
    const Fastify = (await import('fastify')).default;
    hookApp = Fastify();
    registerErrorHandler(hookApp);
    await registerListingsRoutes(hookApp);
    await registerTeardownRoutes(hookApp);
    await registerPurchasesRoutes(hookApp);
    await hookApp.listen({ port: HOOK_PORT, host: '127.0.0.1' });
    const source = await hookDb.createSource({ name: 'T2 Teardown Hook Source', platformType: 'ebay', url: null, notes: null, connectorConfig: null });
    hookSourceId = source.id;
  }, 30_000);

  afterAll(async () => {
    await hookApp.close();
    delete process.env.DUCKDB_DATA_DIR;
    await rm(hookDataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Creates a Listing with zero Expected Parts, injects `photoPaths` directly
  // via db.updateListing (bypassing the separate photo-upload route — already
  // covered by listingPhotos.test.ts), accepts it into a Purchase, and
  // advances that Purchase straight to 'received' so it's ready for teardown.
  async function createReceivedPurchase(photoPaths: string[]): Promise<{ listingId: string; purchaseId: string }> {
    const created = await postJson<ListingDetail>(`${HOOK_BASE_URL}/api/listings`, {
      sourceId: hookSourceId,
      title: 'T2 teardown hook listing',
      description: 'Hook test listing',
      listingUrl: 'https://example.com/t2-teardown-hook',
      askingPrice: 100,
      listingDate: '2026-01-01',
      acquisitionFees: 0,
      expectedParts: [],
    } as CreateListingInput);
    expect(created.status, `listing creation failed: ${JSON.stringify(created.body)}`).toBe(201);
    await hookDb.updateListing(created.body.id, { photoPaths });
    const accepted = await postJson<AcceptListingResponse>(`${HOOK_BASE_URL}/api/listings/${created.body.id}/accept`, {});
    expect(accepted.status, `accept failed: ${JSON.stringify(accepted.body)}`).toBe(201);
    const purchaseId = accepted.body.purchaseId;
    const shipped = await patchJson<PurchaseDetail>(`${HOOK_BASE_URL}/api/purchases/${purchaseId}/status`, { status: 'shipped' });
    expect(shipped.status, `shipped transition failed: ${JSON.stringify(shipped.body)}`).toBe(200);
    const received = await patchJson<PurchaseDetail>(`${HOOK_BASE_URL}/api/purchases/${purchaseId}/status`, { status: 'received' });
    expect(received.status, `received transition failed: ${JSON.stringify(received.body)}`).toBe(200);
    return { listingId: created.body.id, purchaseId };
  }

  // Counts real rows in part_reference_photos matching one exact
  // category/brand/partNumber/photoPath tuple — the granularity Requirement
  // 4's unique index actually dedupes on.
  async function countReferencePhotoRowsFor(category: string, brand: string, partNumber: string, photoPath: string): Promise<number> {
    const connection = await hookGetConnection();
    const reader = await connection.runAndReadAll(
      `SELECT COUNT(*) as cnt FROM part_reference_photos WHERE category = $category AND brand = $brand AND part_number = $part_number AND photo_path = $photo_path`,
      { category, brand, part_number: partNumber, photo_path: photoPath },
    );
    return Number(reader.getRowObjectsJson()[0].cnt);
  }

  it("teardown's Additional Part with a non-null brand promotes the originating Listing's photos (Req 3)", async () => {
    const { listingId, purchaseId } = await createReceivedPurchase(['photos/teardown-hook-promote-1.jpg']);

    const submitRes = await postJson<SubmitTeardownResponse>(`${HOOK_BASE_URL}/api/purchases/${purchaseId}/teardown`, {
      results: [],
      additionalParts: [{ category: 'CPU', brand: 'AMD', partNumber: 'Ryzen 7 5800X', description: 'Found loose in the box', note: 'Unexpected bonus' }],
    });
    expect(submitRes.status, `teardown submission failed: ${JSON.stringify(submitRes.body)}`).toBe(200);

    const connection = await hookGetConnection();
    const reader = await connection.runAndReadAll(
      `SELECT category, brand, part_number, source, listing_id FROM part_reference_photos WHERE photo_path = $photo_path`,
      { photo_path: 'photos/teardown-hook-promote-1.jpg' },
    );
    const rows = reader.getRowObjectsJson();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('CPU');
    expect(rows[0].brand).toBe('AMD');
    expect(rows[0].part_number).toBe('Ryzen 7 5800X');
    expect(rows[0].source).toBe('confirmed_listing');
    expect(rows[0].listing_id).toBe(listingId);
  });

  it('a thrown promotion failure during teardown submission is logged at Error and never fails the request (standing check)', async () => {
    const { purchaseId } = await createReceivedPurchase(['photos/teardown-hook-throws-1.jpg']);
    const errorSpy = vi.spyOn(hookLogger, 'error');
    vi.mocked(referencePhotosModule.promoteReferencePhotos).mockImplementationOnce(() => {
      throw new Error('Simulated teardown promotion failure');
    });

    const submitRes = await postJson<SubmitTeardownResponse>(`${HOOK_BASE_URL}/api/purchases/${purchaseId}/teardown`, {
      results: [],
      additionalParts: [{ category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3070', description: 'Found loose', note: null }],
    });
    expect(submitRes.status, `teardown submission unexpectedly failed: ${JSON.stringify(submitRes.body)}`).toBe(200);
    expect(submitRes.body.createdParts[0].brand).toBe('NVIDIA');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'Simulated teardown promotion failure' }) }),
      'Failed to promote reference photos for Additional Part',
    );
  });

  it(
    'never produces two rows and never throws unhandled when the Listing-save path (PUT) and the teardown Additional-Part path race to promote the identical photo/category/brand/partNumber combination (standing check)',
    async () => {
      // Two separate Listings/Purchases so neither request's expected_parts
      // writes can interact with the other's — the only thing shared between
      // them is the literal photo_path string, injected directly via
      // db.updateListing precisely to force both previously-separate code
      // paths to contend for the exact same part_reference_photos unique-
      // index key at once, the scenario Requirement 4's dedup exists for.
      const SHARED_PHOTO_PATH = 'photos/shared-race-fixture.jpg';
      const listingB = await postJson<ListingDetail>(`${HOOK_BASE_URL}/api/listings`, {
        sourceId: hookSourceId,
        title: 'T2 race listing B (PUT path)',
        description: 'Hook race listing B',
        listingUrl: 'https://example.com/t2-race-b',
        askingPrice: 100,
        listingDate: '2026-01-01',
        acquisitionFees: 0,
        expectedParts: [],
      } as CreateListingInput);
      expect(listingB.status, `listing B creation failed: ${JSON.stringify(listingB.body)}`).toBe(201);
      await hookDb.updateListing(listingB.body.id, { photoPaths: [SHARED_PHOTO_PATH] });
      const { purchaseId: purchaseIdA } = await createReceivedPurchase([SHARED_PHOTO_PATH]);

      // Spies on the real (unmocked in this describe block) logger to
      // discriminate promoteReferencePhotos's own duplicate-detection path
      // (Info-level, the logging standing check) from the separate
      // per-call try/catch already present in listings.ts/teardown.ts for
      // the distinct "promotion throws but request succeeds" standing
      // check (Error-level) — without this, a regression that defeats
      // promoteReferencePhotos's own UNIQUE_CONSTRAINT_MESSAGE detection
      // would still pass this test via that unrelated outer catch, proving
      // nothing about promoteReferencePhotos's own concurrency handling.
      const infoSpy = vi.spyOn(hookLogger, 'info');
      const errorSpy = vi.spyOn(hookLogger, 'error');
      // Fired together via Promise.all — genuine concurrency, not two
      // sequential awaits dressed up as parallel (per T14's
      // concurrency.test.ts standing-check convention).
      const [putRes, teardownRes] = await Promise.all([
        (async () => {
          const res = await fetch(`${HOOK_BASE_URL}/api/listings/${listingB.body.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceId: hookSourceId,
              title: 'T2 race listing B (PUT path)',
              description: 'Hook race listing B',
              listingUrl: 'https://example.com/t2-race-b',
              askingPrice: 100,
              listingDate: '2026-01-01',
              acquisitionFees: 0,
              expectedParts: [{ componentCategory: 'Cooler', brand: 'Noctua', partNumber: 'NH-D15', description: 'Reference cooler', estimatedResaleValue: 90 }],
            }),
          });
          return { status: res.status, body: (await res.json()) as ListingDetail };
        })(),
        postJson<SubmitTeardownResponse>(`${HOOK_BASE_URL}/api/purchases/${purchaseIdA}/teardown`, {
          results: [],
          additionalParts: [{ category: 'Cooler', brand: 'Noctua', partNumber: 'NH-D15', description: 'Found loose', note: 'Race test' }],
        }),
      ]);

      expect(putRes.status, `PUT failed: ${JSON.stringify(putRes.body)}`).toBe(200);
      expect(teardownRes.status, `teardown failed: ${JSON.stringify(teardownRes.body)}`).toBe(200);

      const rowCount = await countReferencePhotoRowsFor('Cooler', 'Noctua', 'NH-D15', SHARED_PHOTO_PATH);
      expect(rowCount).toBe(1);

      // The race's loser must be caught and logged at Info by
      // promoteReferencePhotos itself (the duplicate-skip path), never by
      // falling through to the route-level Error-log fallback that exists
      // for genuinely unexpected failures.
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'Cooler', brand: 'Noctua', partNumber: 'NH-D15', photoPath: SHARED_PHOTO_PATH }),
        'Skipped reference photo already in database',
      );
      expect(errorSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Failed to promote reference photos/));
    },
    30_000,
  );
});

