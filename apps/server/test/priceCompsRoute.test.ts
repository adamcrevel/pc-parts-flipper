// T3 proof: GET /api/price-comps (pricing-comps feature) returns the cached
// price-research state — including the supporting comps array (T1/T2) — for
// one (category, brand, partNumber) combo. Runs against the real server
// (helpers.ts's spawn-based fixture, same as priceSourceRoute.test.ts) and a
// real DuckDB file seeded with raw SQL (never through the route or
// partPriceCache.ts) so what each assertion proves is the route's own
// read-and-shape logic, not a fixture built from the same code it judges.
import type { DuckDBConnection } from '@duckdb/node-api';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { getJson, startTestServer, type TestServer } from './helpers.js';

// Unique port so this suite can run alongside every other server-spawning
// suite (highest currently in use is priceSourceCrossListing.test.ts's
// 34_650) without a collision.
const TEST_PORT = 34_651;

interface PriceCompsResponse {
  estimatedResaleValue: number | null;
  lastResearchedAt: string | null;
  comps: { title: string; url: string; priceUsd: number | null; condition: string | null; saleType: 'sold' | 'listed' | null }[];
}

interface ErrorResponse {
  error: { message: string; statusCode: number };
}

// The combo seeded with a full comps array.
const WITH_COMPS_PART = 'PC-WITH-COMPS';
const WITH_COMPS_VALUE = 199.99;
const SEEDED_COMP = { title: 'Sold listing', url: 'https://example.com/listing/1', priceUsd: 189.5, condition: 'Used', saleType: 'sold' as const };

// The combo seeded with an explicit `comps: '[]'` row (Req 5: a researched
// combo whose last research found no usable comps still returns `[]`, not
// null or an error).
const EMPTY_COMPS_PART = 'PC-EMPTY-COMPS';
const EMPTY_COMPS_VALUE = 42;

// Never inserted into part_price_cache — proves the unseeded-combo path
// returns 200 with all-null/empty fields rather than a 404.
const UNSEEDED_PART = 'PC-NEVER-SEEDED';

describe('GET /api/price-comps (pricing-comps T3)', () => {
  let server: TestServer;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-comps-'));
    process.env.DUCKDB_DATA_DIR = dataDir;
    // Exception (ts-no-dynamic-import): client.ts resolves DUCKDB_DATA_DIR
    // once at module-evaluation time, so it has to be loaded after the env
    // var points at this suite's directory — the same reason
    // priceSourceRoute.test.ts imports it this way.
    const { getConnection, closeConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
    const seedConnection: DuckDBConnection = await getConnection();
    await runMigrations(seedConnection);

    await seedConnection.run(
      `INSERT INTO part_price_cache (id, component_category, brand, part_number, estimated_resale_value, comps, last_researched_at)
       VALUES (gen_random_uuid(), 'GPU', 'NVIDIA', $part_number, $value, $comps, current_timestamp)`,
      { part_number: WITH_COMPS_PART, value: WITH_COMPS_VALUE, comps: JSON.stringify([SEEDED_COMP]) },
    );
    await seedConnection.run(
      `INSERT INTO part_price_cache (id, component_category, brand, part_number, estimated_resale_value, comps, last_researched_at)
       VALUES (gen_random_uuid(), 'GPU', 'NVIDIA', $part_number, $value, '[]', current_timestamp)`,
      { part_number: EMPTY_COMPS_PART, value: EMPTY_COMPS_VALUE },
    );
    // Single-writer rule (client.ts's own module doc): this connection must
    // be closed before the server process opens the same file.
    await closeConnection();

    server = await startTestServer(TEST_PORT, { DUCKDB_DATA_DIR: dataDir });
  }, 95_000);

  afterAll(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('returns the full cached shape, including comps, for a seeded combo', async () => {
    const res = await getJson<PriceCompsResponse>(
      `${server.baseUrl}/api/price-comps?category=GPU&brand=NVIDIA&partNumber=${WITH_COMPS_PART}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      estimatedResaleValue: WITH_COMPS_VALUE,
      lastResearchedAt: expect.any(String) as string,
      comps: [SEEDED_COMP],
    });
  });

  it("returns comps: [] (never null) for a combo researched with no usable comps (Req 5)", async () => {
    const res = await getJson<PriceCompsResponse>(
      `${server.baseUrl}/api/price-comps?category=GPU&brand=NVIDIA&partNumber=${EMPTY_COMPS_PART}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      estimatedResaleValue: EMPTY_COMPS_VALUE,
      lastResearchedAt: expect.any(String) as string,
      comps: [],
    });
  });

  it('returns 200 with all-null/empty fields (never 404) for a combo never queued for research', async () => {
    const res = await getJson<PriceCompsResponse>(
      `${server.baseUrl}/api/price-comps?category=GPU&brand=NVIDIA&partNumber=${UNSEEDED_PART}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ estimatedResaleValue: null, lastResearchedAt: null, comps: [] });
  });

  it('rejects a request missing a required query param with 400', async () => {
    const res = await getJson<ErrorResponse>(`${server.baseUrl}/api/price-comps?category=GPU&brand=NVIDIA`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/partNumber/);
  });

  it('rejects a request with an invalid category with 400', async () => {
    const res = await getJson<ErrorResponse>(
      `${server.baseUrl}/api/price-comps?category=NotACategory&brand=NVIDIA&partNumber=${WITH_COMPS_PART}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/category/);
  });
});
