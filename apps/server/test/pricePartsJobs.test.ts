// Tests for apps/server/src/db/queries/pricePartsJobs.ts and the
// price_parts_jobs table DDL in apps/server/src/db/schema.ts
// (part-price-estimation feature T4). Exercises every exported query
// function directly against a real isolated DuckDB file — no HTTP server
// involved, the same direct-DB pattern identifyPartsJobs.test.ts uses for
// the sibling identify-parts queue.
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-parts-jobs-test-'));
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

// claimNextQueuedPriceJob picks the oldest queued job GLOBALLY (it is not
// scoped to any combo), and this suite shares one DuckDB file across every
// test. Without draining first, a job a previous test left queued would be
// the one a later claim returns. Draining via raw SQL — not through the
// module under test — gives each test a clean slate regardless of run order.
beforeEach(async () => {
  const connection = await getConnection();
  await connection.run(
    `UPDATE price_parts_jobs SET stage = 'failed', completed_at = current_timestamp
     WHERE stage NOT IN ('completed', 'failed')`,
  );
});

// Direct row read for one combo, bypassing the query module under test so
// the assertions below don't depend on the same code they're verifying.
async function readJobRows(brand: string, partNumber: string): Promise<Record<string, unknown>[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM price_parts_jobs WHERE brand = $brand AND part_number = $part_number ORDER BY created_at`,
    { brand, part_number: partNumber },
  );
  return reader.getRowObjectsJson();
}

// Each test uses its own part number so the global claim/drain behaviour of
// one test can never be mistaken for another test's rows.
let partCounter = 0;
function uniquePartNumber(): string {
  partCounter += 1;
  return `RTX-TEST-${partCounter}`;
}

describe('pricePartsJobs — createQueuedPriceJob', () => {
  it('inserts a queued job carrying the full combo and no timestamps yet', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('GPU', 'NVIDIA', partNumber);

    expect(job.category).toBe('GPU');
    expect(job.brand).toBe('NVIDIA');
    expect(job.partNumber).toBe(partNumber);
    expect(job.stage).toBe('queued');
    expect(job.errorMessage).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(typeof job.id).toBe('string');

    const rows = await readJobRows('NVIDIA', partNumber);
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe('queued');
    expect(rows[0].component_category).toBe('GPU');
  });
});

describe('pricePartsJobs — claimNextQueuedPriceJob', () => {
  it('flips the claimed job to pricing and stamps started_at', async () => {
    const partNumber = uniquePartNumber();
    await db.createQueuedPriceJob('CPU', 'Intel', partNumber);

    const claimed = await db.claimNextQueuedPriceJob();

    expect(claimed?.partNumber).toBe(partNumber);
    expect(claimed?.stage).toBe('pricing');
    expect(claimed?.startedAt).not.toBeNull();

    const rows = await readJobRows('Intel', partNumber);
    expect(rows[0].stage).toBe('pricing');
    expect(rows[0].started_at).not.toBeNull();
  });

  it('claims the oldest queued job first and never hands the same job to two claimers', async () => {
    const firstPart = uniquePartNumber();
    const secondPart = uniquePartNumber();
    // created_at is a timestamp; inserting sequentially (awaited) is what
    // makes "oldest" well-defined here.
    await db.createQueuedPriceJob('CPU', 'Intel', firstPart);
    await db.createQueuedPriceJob('CPU', 'Intel', secondPart);

    const first = await db.claimNextQueuedPriceJob();
    const second = await db.claimNextQueuedPriceJob();

    expect(first?.partNumber).toBe(firstPart);
    expect(second?.partNumber).toBe(secondPart);
    expect(first?.id).not.toBe(second?.id);
  });

  it('returns null when nothing is queued', async () => {
    expect(await db.claimNextQueuedPriceJob()).toBeNull();
  });
});

describe('pricePartsJobs — stage transitions', () => {
  it('updatePriceJobStage sets the stage without touching completed_at', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('RAM', 'Corsair', partNumber);

    await db.updatePriceJobStage(job.id, 'pricing');

    const rows = await readJobRows('Corsair', partNumber);
    expect(rows[0].stage).toBe('pricing');
    expect(rows[0].completed_at).toBeNull();
  });

  it('completePriceJob marks the job completed and stamps completed_at', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('RAM', 'Corsair', partNumber);

    await db.completePriceJob(job.id);

    const rows = await readJobRows('Corsair', partNumber);
    expect(rows[0].stage).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].error_message).toBeNull();
  });

  it('failPriceJob marks the job failed, stamps completed_at and stores the message', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('PSU', 'Seasonic', partNumber);

    await db.failPriceJob(job.id, 'omp exited non-zero');

    const rows = await readJobRows('Seasonic', partNumber);
    expect(rows[0].stage).toBe('failed');
    expect(rows[0].completed_at).not.toBeNull();
    expect(rows[0].error_message).toBe('omp exited non-zero');
  });
});

describe('pricePartsJobs — retryOrFailPriceJob', () => {
  it('returns the job to queued, increments retry_count, sets a future next_retry_at, and records the error, leaving started_at/completed_at untouched', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('GPU', 'EVGA', partNumber);
    await db.claimNextQueuedPriceJob(); // -> pricing, stamps started_at
    const claimedRows = await readJobRows('EVGA', partNumber);
    expect(claimedRows[0].started_at).not.toBeNull();

    const before = Date.now();
    await db.retryOrFailPriceJob(job.id, "'omp' exited with code 1");

    const rows = await readJobRows('EVGA', partNumber);
    expect(rows[0].stage).toBe('queued');
    expect(Number(rows[0].retry_count)).toBe(1);
    expect(rows[0].error_message).toBe("'omp' exited with code 1");
    expect(rows[0].completed_at).toBeNull();
    expect(rows[0].started_at).not.toBeNull(); // untouched from the earlier claim
    expect(new Date(rows[0].next_retry_at as string).getTime()).toBeGreaterThan(before);
  });

  it('increments retry_count across repeated failures, growing the backoff window each time', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('RAM', 'Corsair', partNumber);

    await db.retryOrFailPriceJob(job.id, 'first failure');
    const firstRows = await readJobRows('Corsair', partNumber);
    expect(Number(firstRows[0].retry_count)).toBe(1);

    await db.retryOrFailPriceJob(job.id, 'second failure');
    const secondRows = await readJobRows('Corsair', partNumber);
    expect(Number(secondRows[0].retry_count)).toBe(2);
    expect(secondRows[0].error_message).toBe('second failure');

    // Second failure's backoff window must be strictly further out than the
    // first's — exponential growth (10m vs 5m from "now"), not a flat
    // retry interval repeating the same delay.
    const firstDelay = new Date(firstRows[0].next_retry_at as string).getTime() - Date.now();
    const secondDelay = new Date(secondRows[0].next_retry_at as string).getTime() - Date.now();
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('a retried job is not claimable before its backoff window passes, but is claimable once it does', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('PSU', 'Seasonic', partNumber);
    await db.retryOrFailPriceJob(job.id, 'transient infra failure');

    // next_retry_at defaults to ~5 minutes out (BASE_RETRY_DELAY_MS) -- still
    // in the future, so the job must not be claimable yet, even though its
    // stage is 'queued' exactly like a fresh job.
    expect(await db.claimNextQueuedPriceJob()).toBeNull();

    // Backdate next_retry_at directly (bypassing the module under test) to
    // simulate the backoff window having reopened.
    const connection = await getConnection();
    await connection.run(
      `UPDATE price_parts_jobs SET next_retry_at = current_timestamp - INTERVAL 1 SECOND WHERE id = $id`,
      { id: job.id },
    );

    const claimed = await db.claimNextQueuedPriceJob();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.stage).toBe('pricing');
  });

  it('does not disturb failPriceJob\'s existing behavior: a failPriceJob-ed job keeps retry_count/next_retry_at at their defaults and is never reclaimed', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('PSU', 'Seasonic', partNumber);

    await db.failPriceJob(job.id, 'omp exited non-zero');

    const rows = await readJobRows('Seasonic', partNumber);
    expect(rows[0].stage).toBe('failed');
    expect(rows[0].error_message).toBe('omp exited non-zero');
    expect(rows[0].completed_at).not.toBeNull();
    expect(Number(rows[0].retry_count)).toBe(0);
    expect(rows[0].next_retry_at).toBeNull();

    // A permanently-failed job must never be picked back up by the claim
    // query, backoff guard or not.
    expect(await db.claimNextQueuedPriceJob()).toBeNull();
  });
});

describe('pricePartsJobs — hasNonTerminalPriceJob', () => {
  it('is false for a combo that has never had a job', async () => {
    expect(await db.hasNonTerminalPriceJob('GPU', 'AMD', uniquePartNumber())).toBe(false);
  });

  it('is true while a job for the combo is queued, and still true once it is pricing', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('GPU', 'AMD', partNumber);
    expect(await db.hasNonTerminalPriceJob('GPU', 'AMD', partNumber)).toBe(true);

    await db.updatePriceJobStage(job.id, 'pricing');
    expect(await db.hasNonTerminalPriceJob('GPU', 'AMD', partNumber)).toBe(true);
  });

  // Both terminal stages must read as "no job in flight" — a suite proving
  // only `completed` would leave `failed` free to block every future retry
  // of that combo forever.
  it('is false once the combo\'s job is completed', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('GPU', 'AMD', partNumber);
    await db.completePriceJob(job.id);

    expect(await db.hasNonTerminalPriceJob('GPU', 'AMD', partNumber)).toBe(false);
  });

  it('is false once the combo\'s job has failed', async () => {
    const partNumber = uniquePartNumber();
    const job = await db.createQueuedPriceJob('GPU', 'AMD', partNumber);
    await db.failPriceJob(job.id, 'no confident answer');

    expect(await db.hasNonTerminalPriceJob('GPU', 'AMD', partNumber)).toBe(false);
  });

  // The lookup is keyed on all three columns; a match on brand+partNumber
  // alone (or on brand alone) would wrongly suppress a real enqueue.
  it('does not match a different category, brand, or part number', async () => {
    const partNumber = uniquePartNumber();
    await db.createQueuedPriceJob('GPU', 'AMD', partNumber);

    expect(await db.hasNonTerminalPriceJob('CPU', 'AMD', partNumber)).toBe(false);
    expect(await db.hasNonTerminalPriceJob('GPU', 'NVIDIA', partNumber)).toBe(false);
    expect(await db.hasNonTerminalPriceJob('GPU', 'AMD', `${partNumber}-other`)).toBe(false);
  });
});

describe('pricePartsJobs — resetOrphanedPriceJobsToQueued', () => {
  // Mirrors identifyPartsJobs.test.ts's own resetOrphanedJobsToQueued test:
  // one job in each of the four stages this function must tell apart, a
  // real call through the query module (no mocking), and an assertion that
  // only the orphaned 'pricing' job moved while the other three rows are
  // byte-for-byte unchanged. claimNextQueuedPriceJob claims the GLOBALLY
  // oldest queued job, so the pricing job is created and claimed first,
  // before the queued job is created — otherwise the claim below would
  // grab the wrong row.
  it('resets only the pricing job to queued and clears started_at, leaving queued/completed/failed jobs completely untouched', async () => {
    const pricingPart = uniquePartNumber();
    const pricingJobCreated = await db.createQueuedPriceJob('GPU', 'EVGA', pricingPart);
    const pricingJob = await db.claimNextQueuedPriceJob();
    expect(pricingJob?.id).toBe(pricingJobCreated.id);
    expect(pricingJob?.stage).toBe('pricing');

    const queuedPart = uniquePartNumber();
    const queuedJob = await db.createQueuedPriceJob('GPU', 'EVGA', queuedPart);

    const completedPart = uniquePartNumber();
    const completedJob = await db.createQueuedPriceJob('GPU', 'EVGA', completedPart);
    await db.completePriceJob(completedJob.id);

    const failedPart = uniquePartNumber();
    const failedJob = await db.createQueuedPriceJob('GPU', 'EVGA', failedPart);
    await db.failPriceJob(failedJob.id, 'no confident answer');

    const beforeQueuedRows = await readJobRows('EVGA', queuedPart);
    const beforeCompletedRows = await readJobRows('EVGA', completedPart);
    const beforeFailedRows = await readJobRows('EVGA', failedPart);

    const resetIds = await db.resetOrphanedPriceJobsToQueued();

    expect(resetIds).toEqual([pricingJob!.id]);

    const afterPricingRows = await readJobRows('EVGA', pricingPart);
    expect(afterPricingRows).toHaveLength(1);
    expect(afterPricingRows[0].stage).toBe('queued');
    expect(afterPricingRows[0].started_at).toBeNull();

    // The other three rows must be completely untouched, not merely
    // "still the right stage" — comparing the full raw row (including
    // started_at/completed_at/updated_at) catches a WHERE clause broad
    // enough to match them but narrow enough to leave stage alone.
    const afterQueuedRows = await readJobRows('EVGA', queuedPart);
    expect(afterQueuedRows).toEqual(beforeQueuedRows);
    expect(afterQueuedRows[0].stage).toBe('queued');
    expect(afterQueuedRows[0].id).toBe(queuedJob.id);

    const afterCompletedRows = await readJobRows('EVGA', completedPart);
    expect(afterCompletedRows).toEqual(beforeCompletedRows);
    expect(afterCompletedRows[0].stage).toBe('completed');

    const afterFailedRows = await readJobRows('EVGA', failedPart);
    expect(afterFailedRows).toEqual(beforeFailedRows);
    expect(afterFailedRows[0].stage).toBe('failed');
  });
});
