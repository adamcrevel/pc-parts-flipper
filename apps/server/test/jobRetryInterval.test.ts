// Stricter DB-side measurement of the retry interval `retryOrFailJob`
// (apps/server/src/db/queries/identifyPartsJobs.ts) and `retryOrFailPriceJob`
// (apps/server/src/db/queries/pricePartsJobs.ts) store on first failure
// (sourcing-resilience T3, Req 5/6/7/10).
//
// identifyPartsJobs.test.ts and pricePartsJobs.test.ts already assert
// `new Date(row.next_retry_at).getTime() > before` for the first failure —
// true of ANY positive delay, including a wildly wrong one (e.g. half or
// double the real ~5-minute schedule, from an off-by-one on the 1-indexed
// `attemptCount` passed to `computeNextRetryAt`). This file instead asks
// DuckDB itself how many seconds separate `next_retry_at` from
// `current_timestamp`, the same `date_diff('second', CAST(current_timestamp
// AS TIMESTAMP), next_retry_at)` pattern sourcingAttempts.test.ts and
// catalogSourcingAttempts.test.ts already use to measure their own
// `next_retry_at`, and asserts that value lands within a few seconds of
// `BASE_RETRY_DELAY_MS / 1000` (300s) — the real first-failure delay the
// plan specifies — not merely "positive".
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-job-retry-interval-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): client.ts's DATA_DIR is computed once,
  // from DUCKDB_DATA_DIR, at module-evaluation time into a file-scoped const.
  // A static top-of-file import would evaluate before this beforeAll sets the
  // env var and would therefore open the shared dev database instead of this
  // test's isolated temp dir — the dynamic import here is what makes the
  // module-loading timing land after the env var.
  db = (await import('../src/db/index.js')) as typeof DbModule;
  ({ getConnection } = (await import('../src/db/client.js')) as typeof ClientModule);
  await runMigrations(await getConnection());
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function createTestListing(): Promise<string> {
  const source = await db.createSource({
    name: 'Job Retry Interval Test Source',
    platformType: 'other',
    url: 'https://example.com',
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: 'Job Retry Interval Test Listing',
    description: null,
    listingUrl: 'https://example.com/listing',
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    photoPaths: [],
  });
  return listing.id;
}

// How many seconds separate a job's stored `next_retry_at` from
// `current_timestamp`, as measured by DuckDB itself — not derived from any
// value Date.now() or the module under test ever produced.
async function secondsUntilRetry(table: 'identify_parts_jobs' | 'price_parts_jobs', jobId: string): Promise<number> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT date_diff('second', CAST(current_timestamp AS TIMESTAMP), next_retry_at) AS secs
       FROM ${table} WHERE id = $id`,
    { id: jobId },
  );
  const rows = reader.getRowObjectsJson();
  expect(rows).toHaveLength(1);
  return Number(rows[0].secs);
}

describe('identifyPartsJobs — retryOrFailJob first-failure interval (DB-measured)', () => {
  it('stores next_retry_at ~300 seconds out for the first failure, not merely a positive offset', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    expect(job).not.toBeNull();

    await db.retryOrFailJob(job!.id, 'first failure');

    const secs = await secondsUntilRetry('identify_parts_jobs', job!.id);

    // BASE_RETRY_DELAY_MS is 300_000ms (5 minutes). A few seconds of
    // tolerance absorbs real wall-clock time elapsed between the write and
    // this measurement; a delay that was actually ~150s (off-by-one passing
    // attemptCount=0) or ~600s (off-by-one passing attemptCount=2) would
    // fall far outside this window and fail here, even though both would
    // pass a bare "> before" check.
    expect(secs).toBeGreaterThan(295);
    expect(secs).toBeLessThan(305);
  });
});

describe('pricePartsJobs — retryOrFailPriceJob first-failure interval (DB-measured)', () => {
  it('stores next_retry_at ~300 seconds out for the first failure, not merely a positive offset', async () => {
    const job = await db.createQueuedPriceJob('GPU', 'Zotac', 'JOB-RETRY-INTERVAL-TEST');

    await db.retryOrFailPriceJob(job.id, 'first failure');

    const secs = await secondsUntilRetry('price_parts_jobs', job.id);

    // Same ~300s expectation and tolerance as the identify-parts case above.
    expect(secs).toBeGreaterThan(295);
    expect(secs).toBeLessThan(305);
  });
});
