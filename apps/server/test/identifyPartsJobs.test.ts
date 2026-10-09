// Tests for apps/server/src/db/queries/identifyPartsJobs.ts and the
// identify_parts_jobs table DDL in apps/server/src/db/schema.ts (T1, async
// identify-parts-queue feature). Exercises every exported query function
// directly against a real isolated DuckDB file — no HTTP server involved,
// following catalogSourcingAttempts.test.ts's direct-DB pattern rather than
// helpers.ts's spawn()-based server (identifyPartsRoute.test.ts and
// identifyPartsConcurrency.test.ts already cover the HTTP layer).
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-identify-parts-jobs-test-'));
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

// claimNextQueuedJob and resetOrphanedJobsToQueued both operate GLOBALLY
// (across every listing, not scoped to the one a given test creates), and
// this suite shares one DuckDB file/table across every test. Without this,
// a job left in a non-terminal stage by an earlier test (most tests here
// don't drive their job all the way to completed/failed, since that isn't
// what they're testing) would still be sitting there when a later test
// calls one of those two global-scope functions, corrupting its result.
// Draining via raw SQL (not through the query module under test) before
// every test gives each one a clean slate regardless of run order.
beforeEach(async () => {
  const connection = await getConnection();
  await connection.run(
    `UPDATE identify_parts_jobs SET stage = 'failed', completed_at = current_timestamp
     WHERE stage NOT IN ('completed', 'failed')`,
  );
});

// Creates a fresh Source + Listing pair so each test gets its own
// listing_id (insertQueuedJobIfNoneActive refuses a second active job per
// listing, so tests that need multiple jobs for the same listing must drive
// the first one to a terminal stage first, or use two listings).
let listingCounter = 0;
async function createTestListing(): Promise<string> {
  listingCounter += 1;
  const source = await db.createSource({
    name: `Identify Parts Jobs Test Source ${listingCounter}`,
    platformType: 'other',
    url: 'https://example.com',
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: `Identify Parts Jobs Test Listing ${listingCounter}`,
    description: null,
    listingUrl: 'https://example.com/listing',
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    photoPaths: [],
  });
  return listing.id;
}

// Direct row count for a listing, bypassing the query module under test so
// the race-condition assertions below don't depend on the same code they're
// verifying.
async function countJobRows(listingId: string): Promise<number> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) as cnt FROM identify_parts_jobs WHERE listing_id = $listing_id`,
    { listing_id: listingId },
  );
  return Number(reader.getRowObjectsJson()[0].cnt);
}

const sampleResult: IdentifyPartsResponse = {
  parts: [
    {
      category: 'CPU',
      brand: 'Intel',
      partNumber: 'i7-9700k',
      description: 'Good condition',
      confidence: 'high',
      source: 'text',
      identityCandidates: [],
    },
  ],
  notes: 'Looks complete',
};

describe('identifyPartsJobs — insertQueuedJobIfNoneActive', () => {
  it('inserts a new queued job with the expected shape when no active job exists', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);

    expect(job).not.toBeNull();
    expect(job?.listingId).toBe(listingId);
    expect(job?.stage).toBe('queued');
    expect(job?.parts).toBeNull();
    expect(job?.notes).toBeNull();
    expect(job?.errorMessage).toBeNull();
    expect(job?.delivered).toBe(false);
    expect(job?.startedAt).toBeNull();
    expect(job?.completedAt).toBeNull();
    expect(typeof job?.id).toBe('string');

    expect(await countJobRows(listingId)).toBe(1);
  });

  it('returns null and inserts nothing when the listing already has an active (queued) job', async () => {
    const listingId = await createTestListing();
    const first = await db.insertQueuedJobIfNoneActive(listingId);
    expect(first).not.toBeNull();

    const second = await db.insertQueuedJobIfNoneActive(listingId);
    expect(second).toBeNull();

    // Exactly one row, not two — proves the second call didn't insert.
    expect(await countJobRows(listingId)).toBe(1);
  });

  it('returns null while an active job is mid-pipeline (identifying), not only while queued', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    expect(job).not.toBeNull();
    // Advance it out of 'queued' via the real claim path.
    const claimed = await db.claimNextQueuedJob();
    expect(claimed?.id).toBe(job?.id);
    expect(claimed?.stage).toBe('identifying');

    const blocked = await db.insertQueuedJobIfNoneActive(listingId);
    expect(blocked).toBeNull();
    expect(await countJobRows(listingId)).toBe(1);
  });

  it('allows a new job once the prior one for the same listing reached a terminal stage (completed)', async () => {
    const listingId = await createTestListing();
    const first = await db.insertQueuedJobIfNoneActive(listingId);
    expect(first).not.toBeNull();
    await db.completeJob(first!.id, sampleResult);

    const second = await db.insertQueuedJobIfNoneActive(listingId);
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
    expect(await countJobRows(listingId)).toBe(2);
  });

  it('allows a new job once the prior one for the same listing reached a terminal stage (failed)', async () => {
    const listingId = await createTestListing();
    const first = await db.insertQueuedJobIfNoneActive(listingId);
    expect(first).not.toBeNull();
    await db.failJob(first!.id, 'boom');

    const second = await db.insertQueuedJobIfNoneActive(listingId);
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
    expect(await countJobRows(listingId)).toBe(2);
  });

  // Requirement 13 / Standing Check 7: the existence-check and the insert
  // must run as ONE atomic statement, so two genuinely concurrent calls for
  // the same listing (fired together via Promise.all, not sequentially
  // awaited) can never both insert a row. If insertQueuedJobIfNoneActive
  // were rewritten as a separate SELECT-then-INSERT pair (even one that
  // still "works" when called sequentially), this exact test would start
  // failing — proven below via the mutation runner, which swaps the real
  // implementation for a naive check-then-insert with an artificial delay
  // between the two queries, runs this test, shows it fails (2 rows
  // instead of 1), then restores the real file.
  it('creates exactly one job for 8 genuinely concurrent calls against the same listing (real race, not sequential)', async () => {
    const listingId = await createTestListing();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.insertQueuedJobIfNoneActive(listingId)),
    );

    const nonNull = results.filter((r) => r !== null);
    expect(nonNull).toHaveLength(1);
    expect(await countJobRows(listingId)).toBe(1);
  });
});

describe('identifyPartsJobs — getActiveJobForListing', () => {
  it('returns null when the listing has never had a job', async () => {
    const listingId = await createTestListing();
    expect(await db.getActiveJobForListing(listingId)).toBeNull();
  });

  it('returns the job while it is queued', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    const active = await db.getActiveJobForListing(listingId);
    expect(active?.id).toBe(job?.id);
    expect(active?.stage).toBe('queued');
  });

  it('returns null once the job reaches completed', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.completeJob(job!.id, sampleResult);
    expect(await db.getActiveJobForListing(listingId)).toBeNull();
  });

  it('returns null once the job reaches failed', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.failJob(job!.id, 'boom');
    expect(await db.getActiveJobForListing(listingId)).toBeNull();
  });
});

describe('identifyPartsJobs — getJobById', () => {
  it('fetches a job by id with the correct fields', async () => {
    const listingId = await createTestListing();
    const inserted = await db.insertQueuedJobIfNoneActive(listingId);
    const fetched = await db.getJobById(inserted!.id);
    expect(fetched?.id).toBe(inserted?.id);
    expect(fetched?.listingId).toBe(listingId);
    expect(fetched?.stage).toBe('queued');
  });

  it('returns null for an id that does not exist', async () => {
    expect(await db.getJobById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('identifyPartsJobs — getLatestJobForListing', () => {
  it('returns null when the listing has never had a job', async () => {
    const listingId = await createTestListing();
    expect(await db.getLatestJobForListing(listingId)).toBeNull();
  });

  it('returns the most recently created job, not the first one, when the listing has had two', async () => {
    const listingId = await createTestListing();
    const first = await db.insertQueuedJobIfNoneActive(listingId);
    await db.failJob(first!.id, 'first attempt failed');
    const second = await db.insertQueuedJobIfNoneActive(listingId);
    expect(second).not.toBeNull();

    const latest = await db.getLatestJobForListing(listingId);
    expect(latest?.id).toBe(second?.id);
    expect(latest?.id).not.toBe(first?.id);
  });
});

describe('identifyPartsJobs — claimNextQueuedJob', () => {
  it('returns null when there is no queued job', async () => {
    expect(await db.claimNextQueuedJob()).toBeNull();
  });

  it('claims a queued job, flipping its stage to identifying and setting started_at', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    expect(job?.startedAt).toBeNull();

    const claimed = await db.claimNextQueuedJob();
    expect(claimed?.id).toBe(job?.id);
    expect(claimed?.stage).toBe('identifying');
    expect(claimed?.startedAt).not.toBeNull();

    // A second claim attempt finds nothing left queued.
    expect(await db.claimNextQueuedJob()).toBeNull();
  });

  it('claims the oldest queued job first (FIFO), not an arbitrary one, across two listings', async () => {
    const listingA = await createTestListing();
    const jobA = await db.insertQueuedJobIfNoneActive(listingA);
    const listingB = await createTestListing();
    const jobB = await db.insertQueuedJobIfNoneActive(listingB);

    // Force a deterministic creation order without depending on wall-clock
    // timing between the two inserts above: DuckDB's current_timestamp is
    // generated by the native engine itself, not JS's clock, so it cannot
    // be controlled via fake timers. Backdate jobA's created_at directly so
    // the FIFO assertion below is exact rather than relying on real-time
    // ordering between two fast consecutive inserts.
    const connection = await getConnection();
    await connection.run(
      `UPDATE identify_parts_jobs SET created_at = created_at - INTERVAL 1 SECOND WHERE id = $id`,
      { id: jobA!.id },
    );

    const claimed = await db.claimNextQueuedJob();
    expect(claimed?.id).toBe(jobA?.id);
    expect(claimed?.id).not.toBe(jobB?.id);
  });
});

describe('identifyPartsJobs — updateJobStage', () => {
  it('advances a claimed job to sourcing_references', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.claimNextQueuedJob();

    await db.updateJobStage(job!.id, 'sourcing_references');
    const fetched = await db.getJobById(job!.id);
    expect(fetched?.stage).toBe('sourcing_references');
  });

  it('advances a claimed job to comparing', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.claimNextQueuedJob();

    await db.updateJobStage(job!.id, 'comparing');
    const fetched = await db.getJobById(job!.id);
    expect(fetched?.stage).toBe('comparing');
  });
});

describe('identifyPartsJobs — completeJob', () => {
  it('marks the job completed and stores the result split into parts/notes', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);

    await db.completeJob(job!.id, sampleResult);

    const fetched = await db.getJobById(job!.id);
    expect(fetched?.stage).toBe('completed');
    expect(fetched?.parts).toEqual(sampleResult.parts);
    expect(fetched?.notes).toBe('Looks complete');
    expect(fetched?.completedAt).not.toBeNull();
    expect(fetched?.errorMessage).toBeNull();
  });
});

describe('identifyPartsJobs — failJob', () => {
  it('marks the job failed and records the error message', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);

    await db.failJob(job!.id, 'AI provider timed out');

    const fetched = await db.getJobById(job!.id);
    expect(fetched?.stage).toBe('failed');
    expect(fetched?.errorMessage).toBe('AI provider timed out');
    expect(fetched?.completedAt).not.toBeNull();
    expect(fetched?.parts).toBeNull();
  });
});

describe('identifyPartsJobs — retryOrFailJob', () => {
  it('returns the job to queued, increments retry_count, sets a future next_retry_at, and records the error, leaving started_at/completed_at untouched', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.claimNextQueuedJob(); // -> identifying, stamps started_at
    const claimedBefore = await db.getJobById(job!.id);
    expect(claimedBefore?.startedAt).not.toBeNull();

    const before = Date.now();
    await db.retryOrFailJob(job!.id, "'omp' exited with code 1");

    const connection = await getConnection();
    const reader = await connection.runAndReadAll(
      `SELECT * FROM identify_parts_jobs WHERE id = $id`,
      { id: job!.id },
    );
    const row = reader.getRowObjectsJson()[0];

    expect(row.stage).toBe('queued');
    expect(Number(row.retry_count)).toBe(1);
    expect(row.error_message).toBe("'omp' exited with code 1");
    expect(row.completed_at).toBeNull();
    expect(row.started_at).not.toBeNull(); // untouched from the earlier claim
    expect(new Date(row.next_retry_at as string).getTime()).toBeGreaterThan(before);
  });

  it('increments retry_count across repeated failures, growing the backoff window each time', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    const connection = await getConnection();

    await db.retryOrFailJob(job!.id, 'first failure');
    const firstRow = (
      await connection.runAndReadAll(`SELECT * FROM identify_parts_jobs WHERE id = $id`, { id: job!.id })
    ).getRowObjectsJson()[0];
    expect(Number(firstRow.retry_count)).toBe(1);

    await db.retryOrFailJob(job!.id, 'second failure');
    const secondRow = (
      await connection.runAndReadAll(`SELECT * FROM identify_parts_jobs WHERE id = $id`, { id: job!.id })
    ).getRowObjectsJson()[0];
    expect(Number(secondRow.retry_count)).toBe(2);
    expect(secondRow.error_message).toBe('second failure');

    // Second failure's backoff window must be strictly further out than the
    // first's — exponential growth (10m vs 5m from "now"), not a flat
    // retry interval repeating the same delay.
    const firstDelay = new Date(firstRow.next_retry_at as string).getTime() - Date.now();
    const secondDelay = new Date(secondRow.next_retry_at as string).getTime() - Date.now();
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });

  it('a retried job is not claimable before its backoff window passes, but is claimable once it does', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.retryOrFailJob(job!.id, 'transient infra failure');

    // next_retry_at defaults to ~5 minutes out (BASE_RETRY_DELAY_MS) -- still
    // in the future, so the job must not be claimable yet, even though its
    // stage is 'queued' exactly like a fresh job.
    expect(await db.claimNextQueuedJob()).toBeNull();

    // Backdate next_retry_at directly (bypassing the module under test, the
    // same technique claimNextQueuedJob's own FIFO test uses for
    // created_at) to simulate the backoff window having reopened.
    const connection = await getConnection();
    await connection.run(
      `UPDATE identify_parts_jobs SET next_retry_at = current_timestamp - INTERVAL 1 SECOND WHERE id = $id`,
      { id: job!.id },
    );

    const claimed = await db.claimNextQueuedJob();
    expect(claimed?.id).toBe(job!.id);
    expect(claimed?.stage).toBe('identifying');
  });

  it('does not disturb failJob\'s existing permanent-failure behavior: a failJob-ed job keeps retry_count/next_retry_at at their defaults and is never reclaimed', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);

    await db.failJob(job!.id, 'Listing no longer exists');

    const connection = await getConnection();
    const row = (
      await connection.runAndReadAll(`SELECT * FROM identify_parts_jobs WHERE id = $id`, { id: job!.id })
    ).getRowObjectsJson()[0];
    expect(row.stage).toBe('failed');
    expect(row.error_message).toBe('Listing no longer exists');
    expect(row.completed_at).not.toBeNull();
    expect(Number(row.retry_count)).toBe(0);
    expect(row.next_retry_at).toBeNull();

    // A permanently-failed job must never be picked back up by the claim
    // query, backoff guard or not.
    expect(await db.claimNextQueuedJob()).toBeNull();
  });
});

describe('identifyPartsJobs — markDelivered', () => {
  it('flips delivered from false to true for exactly the targeted job', async () => {
    const listingId = await createTestListing();
    const job = await db.insertQueuedJobIfNoneActive(listingId);
    await db.completeJob(job!.id, sampleResult);
    expect((await db.getJobById(job!.id))?.delivered).toBe(false);

    await db.markDelivered(job!.id);

    expect((await db.getJobById(job!.id))?.delivered).toBe(true);
  });
});

describe('identifyPartsJobs — resetOrphanedJobsToQueued', () => {
  it('resets identifying/sourcing_references/comparing jobs to queued and clears started_at, leaving terminal and already-queued jobs untouched', async () => {
    const listingIdentifying = await createTestListing();
    const jobIdentifying = await db.insertQueuedJobIfNoneActive(listingIdentifying);
    await db.claimNextQueuedJob(); // -> identifying

    const listingSourcing = await createTestListing();
    const jobSourcing = await db.insertQueuedJobIfNoneActive(listingSourcing);
    await db.claimNextQueuedJob();
    await db.updateJobStage(jobSourcing!.id, 'sourcing_references');

    const listingComparing = await createTestListing();
    const jobComparing = await db.insertQueuedJobIfNoneActive(listingComparing);
    await db.claimNextQueuedJob();
    await db.updateJobStage(jobComparing!.id, 'comparing');

    const listingQueued = await createTestListing();
    const jobQueued = await db.insertQueuedJobIfNoneActive(listingQueued);

    const listingCompleted = await createTestListing();
    const jobCompleted = await db.insertQueuedJobIfNoneActive(listingCompleted);
    await db.completeJob(jobCompleted!.id, sampleResult);

    const resetIds = await db.resetOrphanedJobsToQueued();

    expect(resetIds.sort()).toEqual(
      [jobIdentifying!.id, jobSourcing!.id, jobComparing!.id].sort(),
    );

    const afterIdentifying = await db.getJobById(jobIdentifying!.id);
    expect(afterIdentifying?.stage).toBe('queued');
    expect(afterIdentifying?.startedAt).toBeNull();

    const afterSourcing = await db.getJobById(jobSourcing!.id);
    expect(afterSourcing?.stage).toBe('queued');
    expect(afterSourcing?.startedAt).toBeNull();

    const afterComparing = await db.getJobById(jobComparing!.id);
    expect(afterComparing?.stage).toBe('queued');
    expect(afterComparing?.startedAt).toBeNull();

    // Untouched: already queued, and already terminal.
    expect((await db.getJobById(jobQueued!.id))?.stage).toBe('queued');
    expect((await db.getJobById(jobCompleted!.id))?.stage).toBe('completed');
  });
});
