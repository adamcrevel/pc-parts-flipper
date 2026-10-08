// T5 proof (part 3 of 3 — the manual-save call path, against the real
// server + real DB; see workingStatusIdentifyParts.test.ts for the
// identify-parts call path and workingStatusTriggerGate.test.ts for Req
// 12's direct trigger-gate proof): apps/server/src/routes/listings.ts's
// createExpectedPartsForListing (Req 10, 13, 14, 16).
//
// Runs against the real server (helpers.ts's spawn-based fixture, the same
// pattern priceSourceRoute.test.ts uses) so what is proven is the whole
// chain — request validation, the route's own $1-override decision, the
// INSERT, and (for Req 14) the real part_price_cache table — rather than
// any one layer's in-memory behaviour.
//
// IDENTIFY_PARTS_POOL_SIZE=0 and PRICE_PARTS_POOL_SIZE=0 keep both worker
// pools from claiming anything (same reason priceSourceRoute.test.ts sets
// them), so nothing this suite's writes enqueue is ever processed — every
// assertion below is about the synchronous route response and the rows it
// wrote, not about any background job completing.
import type { DuckDBConnection } from '@duckdb/node-api';
import type { CreateListingInput, ListingDetail } from '@pc-parts-flipper/shared';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Unique port, higher than every other server-spawning suite (highest
// currently in use is priceSourceCrossListing.test.ts's 34_650), so this
// suite can run alongside the rest of the matrix without a port collision.
const TEST_PORT = 34_660;

interface SourceResponse {
  id: string;
}

function listingBody(sourceId: string, expectedParts: CreateListingInput['expectedParts']): CreateListingInput {
  return {
    sourceId,
    title: 'Manual-save working-status rig',
    description: null,
    listingUrl: 'https://example.com/listing/working-status-manual',
    askingPrice: 300,
    listingDate: '2026-02-01',
    acquisitionFees: 0,
    expectedParts,
  };
}

// Named part numbers per test keep the part_price_cache rows these writes
// create (or deliberately don't, for Req 14) from one test being read by
// another.
let partCounter = 0;
function uniquePartNumber(): string {
  partCounter += 1;
  return `WS-MANUAL-${partCounter}`;
}

describe('createExpectedPartsForListing — manual-save working-status handling (T5, Req 10/13/14/16)', () => {
  let server: TestServer;
  let sourceId: string;
  let dataDir: string;
  let serverStopped = false;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-working-status-manual-'));
    server = await startTestServer(TEST_PORT, { IDENTIFY_PARTS_POOL_SIZE: '0', PRICE_PARTS_POOL_SIZE: '0', DUCKDB_DATA_DIR: dataDir });
    const sourceRes = await postJson<SourceResponse>(`${server.baseUrl}/api/sources`, {
      name: 'Working Status Manual Test Source',
      platformType: 'ebay',
      url: 'https://example.com/working-status-manual-source',
      notes: null,
    });
    expect(sourceRes.status, `seed Source creation failed: ${JSON.stringify(sourceRes.body)}`).toBe(201);
    sourceId = sourceRes.body.id;
  }, 95_000);

  afterAll(async () => {
    if (!serverStopped) {
      await server.stop();
    }
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('Req 13: a fully-identified, unpriced part saved with workingStatus non_working gets estimatedResaleValue exactly 1', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        {
          componentCategory: 'GPU',
          brand: 'NVIDIA',
          partNumber,
          description: 'Reported dead',
          estimatedResaleValue: null,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
          workingStatus: 'non_working',
        },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].workingStatus).toBe('non_working');
    expect(created.body.expectedParts[0].estimatedResaleValue).toBe(1);
    expect(created.body.expectedParts[0].priceSource).toBe('auto');

    // Re-fetched, not just echoed: proves the $1 and workingStatus columns
    // were actually written, not merely reflected back in the create response.
    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.expectedParts[0].estimatedResaleValue).toBe(1);
    expect(fetched.body.expectedParts[0].workingStatus).toBe('non_working');
  });

  it('Req 10: a manually-entered part with workingStatus omitted comes back exactly "working" (never null/undefined)', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        {
          componentCategory: 'RAM',
          brand: 'Corsair',
          partNumber,
          description: '16GB kit',
          estimatedResaleValue: null,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
          // workingStatus intentionally omitted.
        },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    // Literal string equality, not a truthy check: `undefined` would also
    // read as "not non_working" but is not the value Req 10 requires.
    expect(created.body.expectedParts[0].workingStatus).toBe('working');

    const fetched = await getJson<ListingDetail>(`${server.baseUrl}/api/listings/${created.body.id}`);
    expect(fetched.body.expectedParts[0].workingStatus).toBe('working');
  });

  it('Req 16a: a manual-owned row (priceSource "manual") with workingStatus non_working keeps its exact own price, never overridden to 1', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        {
          componentCategory: 'Motherboard',
          brand: 'ASUS',
          partNumber,
          description: 'User already priced this one',
          estimatedResaleValue: 77,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
          priceSource: 'manual',
          workingStatus: 'non_working',
        },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].estimatedResaleValue).toBe(77);
    expect(created.body.expectedParts[0].priceSource).toBe('manual');
    expect(created.body.expectedParts[0].workingStatus).toBe('non_working');
  });

  it('Req 16b: an already-valued, priceSource-undecided row with workingStatus non_working keeps its exact own price, never overridden to 1', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        {
          componentCategory: 'Case',
          brand: 'Fractal',
          partNumber,
          description: 'Already has a resale figure from somewhere',
          estimatedResaleValue: 55,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
          // priceSource intentionally omitted (undecided) — the route's
          // own 'auto'-claim condition additionally requires
          // estimatedResaleValue === null, which this row does not meet,
          // so priceSource stays undecided and the $1 override (gated on
          // priceSource === 'auto') never fires.
          workingStatus: 'non_working',
        },
      ]),
    );

    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].estimatedResaleValue).toBe(55);
    expect(created.body.expectedParts[0].workingStatus).toBe('non_working');
  });

  // Last test in the suite: stops the real server (DuckDB's single-writer
  // rule means the data file can't be opened directly while the server
  // process still holds it) and reads part_price_cache straight from the
  // table — the same pattern priceSourceRoute.test.ts's own final test
  // uses — so Req 14 is proven against the real table, not a mock.
  it('Req 14: the $1 assignment never creates a part_price_cache row for that combo', async () => {
    const partNumber = uniquePartNumber();
    const created = await postJson<ListingDetail>(
      `${server.baseUrl}/api/listings`,
      listingBody(sourceId, [
        {
          componentCategory: 'Cooler',
          brand: 'Noctua',
          partNumber,
          description: 'Non-working cooler fan',
          estimatedResaleValue: null,
          identityCandidates: [],
          aiConfidence: null,
          aiSource: null,
          workingStatus: 'non_working',
        },
      ]),
    );
    expect(created.status, `create failed: ${JSON.stringify(created.body)}`).toBe(201);
    expect(created.body.expectedParts[0].estimatedResaleValue).toBe(1);

    await server.stop();
    serverStopped = true;

    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): client.ts computes its DATA_DIR once
    // at module-evaluation time from DUCKDB_DATA_DIR, so it has to be
    // imported after that env var points at this suite's directory — the
    // same reason every direct-DB suite in this folder (e.g.
    // priceSourceRoute.test.ts's own final test) imports it this way.
    const { getConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
    const connection: DuckDBConnection = await getConnection();

    const cache = await connection.runAndReadAll(
      `SELECT estimated_resale_value FROM part_price_cache WHERE component_category = 'Cooler' AND brand = 'Noctua' AND part_number = $part_number`,
      { part_number: partNumber },
    );
    const cacheRows = cache.getRowObjectsJson();
    // No row at all for this combo — not a row with a null/zero value, an
    // absent row: the $1 is specific to this one Listing's actual item,
    // never a market-price fact shared with other Listings.
    expect(cacheRows).toHaveLength(0);

    delete process.env.DUCKDB_DATA_DIR;
  }, 30_000);
});
