// Proof for POST /api/listings/:id/identify-parts
// (apps/server/src/routes/identifyParts.ts).
//
// Boots a *real* Fastify server in-process (Fastify() + registerErrorHandler +
// registerIdentifyPartsRoutes, listening on a real local port) against an
// isolated temp DuckDB file, following scan.test.ts's pattern rather than
// helpers.ts's spawn()-based server: the only seam that keeps the real `omp`
// binary out of the automated suite is ompRunner.ts's module-level override,
// and installing it requires the route and the test to share one process.
// (The real end-to-end omp call is verified out of band, the same way the eBay
// connector's real network behavior is.)
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import type * as DbModule from '../src/db/index.js';
import type { Listing, Source } from '../src/db/index.js';
import type * as RunnerModule from '../src/ai/ompRunner.js';
import type * as IdentifyRoutesModule from '../src/routes/identifyParts.js';
import type * as ErrorHandlerModule from '../src/error-handler.js';

// Arbitrary high port distinct from every other suite's TEST_PORT
// (concurrency.test.ts's 34_591, sources.test.ts's 34_597, app-shell.test.ts's
// 34_601, listings.test.ts's 34_602, scan.test.ts's 34_610).
const TEST_PORT = 34_613;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let dataDir: string;
let db: typeof DbModule;
let runner: typeof RunnerModule;
let app: FastifyInstance;

interface ErrorResponse {
  error: { message: string; statusCode: number };
}

// Creates a Source + Listing pair to identify parts on.
async function createListingWithPhotos(title: string, photoPaths: string[]): Promise<Listing> {
  const source: Source = await db.createSource({
    name: `AI Identify Source ${title}`,
    platformType: 'ebay',
    url: null,
    notes: null,
    connectorConfig: null,
  });
  return db.createListing({
    sourceId: source.id,
    title,
    description: 'Includes keyboard and mouse.',
    listingUrl: null,
    askingPrice: 500,
    listingDate: '2026-09-20',
    acquisitionFees: 0,
    photoPaths,
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-identify-route-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Dynamic import (same exception as db.test.ts/scan.test.ts): client.ts's
  // DATA_DIR is read once at module-evaluation time from DUCKDB_DATA_DIR, so a
  // static import would open the shared development database instead.
  db = await import('../src/db/index.js');
  runner = await import('../src/ai/ompRunner.js');
  const { registerIdentifyPartsRoutes }: typeof IdentifyRoutesModule = await import('../src/routes/identifyParts.js');
  const { registerErrorHandler }: typeof ErrorHandlerModule = await import('../src/error-handler.js');
  const Fastify = (await import('fastify')).default;

  app = Fastify();
  registerErrorHandler(app);
  await registerIdentifyPartsRoutes(app);
  await app.listen({ port: TEST_PORT, host: '127.0.0.1' });
}, 30_000);

afterAll(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  runner.setOmpRunnerOverride(null);
});

describe('POST /api/listings/:id/identify-parts', () => {
  it('returns 200 with the parsed identification for an existing Listing', async () => {
    const modelOutput = JSON.stringify({
      parts: [
        { category: 'CPU', brand: 'AMD', partNumber: 'Ryzen 5 5600X', description: 'Boxed cooler included', confidence: 'high', source: 'text' },
        { category: 'GPU', brand: 'NVIDIA', partNumber: null, description: 'RTX 3060, 12GB variant unconfirmed', confidence: 'medium', source: 'image' },
      ],
      notes: 'PSU wattage not visible in any photo.',
    });
    let receivedImages: readonly string[] = [];
    runner.setOmpRunnerOverride(async (_prompt, imagePaths) => {
      receivedImages = imagePaths;
      return modelOutput;
    });
    const listing = await createListingWithPhotos('Gaming PC with RTX 3060', ['photos/pic-one.jpg']);

    const res = await fetch(`${BASE_URL}/api/listings/${listing.id}/identify-parts`, { method: 'POST' });
    const body = (await res.json()) as IdentifyPartsResponse;

    expect(res.status).toBe(200);
    expect(body.parts).toHaveLength(2);
    // Full-shape equality, so brand/partNumber reaching the HTTP response is
    // proven rather than assumed — including the null half.
    expect(body.parts[0]).toEqual({ category: 'CPU', brand: 'AMD', partNumber: 'Ryzen 5 5600X', description: 'Boxed cooler included', confidence: 'high', source: 'text' });
    expect(body.parts[1].brand).toBe('NVIDIA');
    expect(body.parts[1].partNumber).toBeNull();
    expect(body.notes).toBe('PSU wattage not visible in any photo.');
    // The route reached the real orchestrator (photo resolution included),
    // not some shortcut that echoed the fixture.
    expect(receivedImages).toEqual([path.join(dataDir, 'photos', 'pic-one.jpg')]);
  });

  it('returns 404 for a Listing that does not exist, without calling the model', async () => {
    let called = false;
    runner.setOmpRunnerOverride(async () => {
      called = true;
      return '{"parts":[],"notes":""}';
    });

    // UUID-shaped but unused id, matching scan.test.ts's nonexistent-id
    // convention: the id column is a DuckDB UUID, so a non-UUID string fails
    // conversion before the row lookup could report "not found".
    const res = await fetch(`${BASE_URL}/api/listings/00000000-0000-0000-0000-000000000000/identify-parts`, { method: 'POST' });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(404);
    expect(body.error.message).toContain('not found');
    expect(called).toBe(false);
  });

  it('surfaces an identification failure as a real error, never an empty success body', async () => {
    runner.setOmpRunnerOverride(async () => 'Sorry, I cannot do that.');
    const listing = await createListingWithPhotos('Office PC', []);

    const res = await fetch(`${BASE_URL}/api/listings/${listing.id}/identify-parts`, { method: 'POST' });
    const body = (await res.json()) as ErrorResponse;

    expect(res.status).toBe(502);
    expect(body.error.message).toContain('did not return valid JSON');
  });
});
