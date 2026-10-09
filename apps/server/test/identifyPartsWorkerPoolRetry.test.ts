// T7 proof: apps/server/src/jobs/identifyPartsWorkerPool.ts's retry-or-fail
// wiring (Req 5, 6, 7).
//
// identifyPartsWorkerPool.test.ts isolates the pool's own claim/process/
// stage-callback logic from DuckDB by mocking db/index.js entirely, so it
// can only prove that processJob *calls* retryOrFailJob with the right
// arguments on a thrown error — it cannot prove that doing so actually
// round-trips through the real identify_parts_jobs table into a requeued,
// backoff-gated, eventually-reclaimed job, since the mocked retryOrFailJob
// never touches a table at all. This suite closes that gap: it runs the
// real worker pool against a real, isolated DuckDB file (no db/index.js
// mocking) with only the one true external dependency,
// ai/partIdentification.js, replaced by a controllable stub (plus
// jobs/pricePartsTrigger.js, mocked away as irrelevant to a job that never
// reaches persistIdentifiedParts while failing). It proves, end to end,
// exactly what the T7 task calls for: a job that throws is returned to
// 'queued' (never 'failed') with an incremented retry_count and a future
// next_retry_at, is NOT reclaimed by the pool's own poll loop before that
// window passes, and IS reclaimed and successfully retried once it does.
// The DB-level mechanics of retryOrFailJob itself (exact backoff growth
// across repeated failures, etc.) are already proven directly in
// identifyPartsJobs.test.ts's own "retryOrFailJob" describe block; this
// file's job is only to prove the *pool* is actually wired to it, not to
// re-derive the backoff schedule. The Listing-deleted permanent-failure
// branch is deliberately NOT re-proven here against a real DuckDB file:
// identify_parts_jobs.listing_id is a NOT NULL FOREIGN KEY REFERENCES
// listings(id) (schema.ts), so a real listings row can never actually be
// deleted while a job still references it — DuckDB itself rejects that
// with a foreign-key constraint violation, confirmed by attempting it
// while authoring this suite. identifyPartsWorkerPool.test.ts's own
// mock-based "permanently fails a job ... when its Listing has been
// deleted" test already covers that branch (and that it never calls
// retryOrFailJob) at the one level where it's actually exercisable.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as IdentifyPartsWorkerPoolModule from '../src/jobs/identifyPartsWorkerPool.js';
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';

const identifyListingParts = vi.fn();
vi.mock('../src/ai/partIdentification.js', () => ({
  identifyListingParts: (...args: unknown[]) => identifyListingParts(...args),
}));

// persistIdentifiedParts (only reached once identifyListingParts actually
// succeeds, on the retried pass) hands its freshly-created rows to
// triggerPriceLookups as its last step; mocked away here the same way
// identifyPartsWorkerPool.test.ts mocks it, to keep this suite's focus on
// the retry wiring rather than price-trigger behavior.
const triggerPriceLookups = vi.fn();
vi.mock('../src/jobs/pricePartsTrigger.js', () => ({
  triggerPriceLookups: (...args: unknown[]) => triggerPriceLookups(...args),
}));

let dataDir: string;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;
let startIdentifyPartsWorkerPool: typeof IdentifyPartsWorkerPoolModule.startIdentifyPartsWorkerPool;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-identify-parts-pool-retry-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import): client.ts's DATA_DIR is computed once,
  // from DUCKDB_DATA_DIR, at module-evaluation time into a file-scoped
  // const, and identifyPartsWorkerPool.ts statically imports db/index.js
  // (which imports client.ts) at its own top level. A static top-of-file
  // import of either module in this test file would therefore evaluate
  // before this beforeAll sets the env var and would open the shared dev
  // database instead of this test's isolated temp dir. The dynamic imports
  // here are what make the module-loading timing land after the env var —
  // the exact technique identifyPartsJobs.test.ts already uses for its own
  // direct-DB suite.
  db = (await import('../src/db/index.js')) as typeof DbModule;
  ({ getConnection } = (await import('../src/db/client.js')) as typeof ClientModule);
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(await getConnection());
  ({ startIdentifyPartsWorkerPool } = (await import(
    '../src/jobs/identifyPartsWorkerPool.js'
  )) as typeof IdentifyPartsWorkerPoolModule);
});

afterAll(async () => {
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

let activeHandle: { stop(): void } | null = null;
let listingCounter = 0;

beforeEach(() => {
  identifyListingParts.mockReset();
  triggerPriceLookups.mockReset().mockResolvedValue(undefined);
  // This suite's own pool instance is stopped in afterEach below, and each
  // test uses its own freshly-created listing/job, so no cross-test
  // draining is needed the way identifyPartsJobs.test.ts's shared-table
  // suite requires for its global-scope claimNextQueuedJob assertions.
});

afterEach(() => {
  activeHandle?.stop();
  activeHandle = null;
  vi.restoreAllMocks();
});

async function createTestListing(): Promise<string> {
  listingCounter += 1;
  const source = await db.createSource({
    name: `Identify Parts Pool Retry Test Source ${listingCounter}`,
    platformType: 'other',
    url: 'https://example.com',
    notes: null,
  });
  const listing = await db.createListing({
    sourceId: source.id,
    title: `Identify Parts Pool Retry Test Listing ${listingCounter}`,
    description: null,
    listingUrl: 'https://example.com/listing',
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    photoPaths: [],
  });
  return listing.id;
}

describe('identifyPartsWorkerPool retry-or-fail wiring, end to end (T7, Req 5, 6, 7)', () => {
  it(
    'a job that throws is requeued with an incremented retry_count and a future next_retry_at (never failed), ' +
      'is not reclaimed before that window passes, and is reclaimed and successfully retried once it does',
    async () => {
      const listingId = await createTestListing();
      const job = await db.insertQueuedJobIfNoneActive(listingId);
      expect(job).not.toBeNull();

      let callCount = 0;
      identifyListingParts.mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('AI provider timed out');
        }
        return { parts: [], notes: 'retry succeeded' } satisfies IdentifyPartsResponse;
      });

      const beforeFirstFailure = Date.now();
      activeHandle = startIdentifyPartsWorkerPool();

      // First pass: the pool claims the job, identifyListingParts throws,
      // and the catch block's retryOrFailJob call must return it to
      // 'queued' — never 'failed' — with retry_count incremented and
      // next_retry_at set strictly in the future.
      await vi.waitFor(() => expect(callCount).toBe(1));
      await vi.waitFor(async () => {
        const fetched = await db.getJobById(job!.id);
        expect(fetched?.stage).toBe('queued');
      });

      const afterFirstFailure = await db.getJobById(job!.id);
      expect(afterFirstFailure?.stage).toBe('queued');
      expect(afterFirstFailure?.errorMessage).toBe('AI provider timed out');

      const connection = await getConnection();
      const rowAfterFirstFailure = (
        await connection.runAndReadAll(`SELECT * FROM identify_parts_jobs WHERE id = $id`, { id: job!.id })
      ).getRowObjectsJson()[0];
      expect(Number(rowAfterFirstFailure.retry_count)).toBe(1);
      expect(new Date(rowAfterFirstFailure.next_retry_at as string).getTime()).toBeGreaterThan(beforeFirstFailure);

      // Not reclaimed before its window passes: the production pool's own
      // poll loop ticks a hardcoded, non-injectable `setInterval(..., 1000)`
      // against the real system clock (startIdentifyPartsWorkerPool exposes
      // no way to drive it with fake timers, and its claimed job's backoff
      // check races a real DuckDB connection, not a mockable clock), so
      // proving "not reclaimed across a real poll tick" genuinely requires
      // waiting out one real tick rather than simulating it — the
      // documented exception to avoiding real timers in tests. One tick
      // (a little over 1000ms) is enough: next_retry_at is still ~5 minutes
      // out (the default BASE_RETRY_DELAY_MS), so if the claim query's
      // backoff gate (or retryOrFailJob itself) were broken, this single
      // real tick would already be enough to reclaim and re-run the job.
      const { promise: afterOneTick, resolve: resolveAfterOneTick } = Promise.withResolvers<void>();
      setTimeout(resolveAfterOneTick, 1200);
      await afterOneTick;
      expect(callCount).toBe(1);

      // Backdate next_retry_at directly (bypassing the module under test,
      // the same technique identifyPartsJobs.test.ts's own
      // claimNextQueuedJob/retryOrFailJob tests use) to simulate the
      // backoff window having reopened, without waiting out the real ~5
      // minutes.
      await connection.run(
        `UPDATE identify_parts_jobs SET next_retry_at = current_timestamp - INTERVAL 1 SECOND WHERE id = $id`,
        { id: job!.id },
      );

      // Reclaimed and retried once the window passes: the pool's next poll
      // tick claims it again, identifyListingParts runs a second time and
      // succeeds, and the job reaches 'completed' — proving this is a real
      // retry, not merely a requeue that never gets picked back up.
      await vi.waitFor(
        async () => {
          const fetched = await db.getJobById(job!.id);
          expect(fetched?.stage).toBe('completed');
        },
        { timeout: 5000 },
      );

      expect(callCount).toBe(2);
      const finalJob = await db.getJobById(job!.id);
      expect(finalJob?.notes).toBe('retry succeeded');
    },
    15_000,
  );
});
