// Regression test for the price-parts shutdown race (R2's finding): before
// this fix, pricePartsWorkerPool.ts's startPricePartsWorkerPool().stop()
// cleared the poll interval and returned synchronously, with no visibility
// into a job still mid-flight — processJob spends almost all of its time
// awaiting the AI runner, entirely before it reaches any DB
// run/runAndReadAll call, so client.ts's own queueTail (what
// closeConnection() awaits) never saw it either. index.ts's
// gracefulShutdown() could therefore run closeConnection() (and
// process.exit) while a price job was still awaiting the AI call, either
// losing its eventual updatePriceCacheEntryValue/completePriceJob write, or
// — since closeConnection() nulls out client.ts's module-level
// connectionPromise — letting a getConnection() call made after that point
// silently reopen a brand-new DuckDBInstance and rerun every migration.
//
// This suite proves both halves of the fix directly, in-process, with no
// spawned child and no timing-based race: a controlled deferred promise
// (Promise.withResolvers, the same convention as helpers.ts/
// gracefulShutdown.test.ts/sourcingConcurrencyLimiter.test.ts) holds the AI
// call open so the test — not wall-clock luck — decides exactly when
// processJob is allowed to proceed past it.
//
// A second describe block below extends this same deferred-promise pattern
// to a narrower window inside pump() itself (R5's finding on T5's own
// retry-1 fix): pump() used to increment activeCount only after
// claimNextQueuedPriceJob() resolved, not before calling it, leaving a gap
// where a claim already committed in the DB was invisible to stop()'s
// drain. Those tests hold claimNextQueuedPriceJob's own promise open
// (mocking it directly, since the real call resolves far too fast for a
// test to observe its in-flight window otherwise) to prove activeCount is
// already incremented the instant pump() calls it — not only once it
// returns — and that the increment is correctly rolled back both when the
// claim resolves with no job found and when the claim itself rejects
// (R5's second finding against T5's retry-1 fix: claimNextQueuedPriceJob
// has no internal try/catch, so a transient DuckDB error propagating
// through it would otherwise leak activeCount permanently with no
// rollback path left to run).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as ClientModule from '../src/db/client.js';
import type * as DbModule from '../src/db/index.js';
import type * as PoolModule from '../src/jobs/pricePartsWorkerPool.js';
import type * as RunnerModule from '../src/ai/ompSourcingRunner.js';

let dataDir: string;
let client: typeof ClientModule;
let db: typeof DbModule;
let pool: typeof PoolModule;
let runner: typeof RunnerModule;

// Exception to this suite's otherwise-deterministic, condition-wait style
// (ts-no-test-timers): the one property asserted right after this —
// "stop() has not resolved yet" — has no promise/event to await instead.
// stop()'s own drain loop polls activeCount via real setTimeout(..., 25)
// precisely because activeCount is flipped by a real DuckDB
// run/runAndReadAll call chain (claimNextQueuedPriceJob already ran;
// updatePriceCacheEntryValue/completePriceJob have not), not by anything
// this test could fast-forward with fake timers without also faking the
// native DuckDB binding's own async scheduling — which would stop proving
// the real polling behavior stop() relies on and start proving a mock of
// it instead. The wait is short and bounded, and nothing in this suite
// resolves the held-open AI call before the one assertion that depends on
// it runs, so there is no nondeterministic competing event to race
// against — only a fixed window given to stop()'s poll loop to run a few
// real iterations.
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-price-shutdown-race-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Exception (ts-no-dynamic-import), same as pricePartsJobs.test.ts:
  // client.ts's DATA_DIR is computed once, from DUCKDB_DATA_DIR, at
  // module-evaluation time into a file-scoped const. A static top-of-file
  // import would evaluate before this beforeAll sets the env var and would
  // therefore open the shared dev database instead of this test's isolated
  // temp dir.
  client = (await import('../src/db/client.js')) as typeof ClientModule;
  db = (await import('../src/db/index.js')) as typeof DbModule;
  pool = (await import('../src/jobs/pricePartsWorkerPool.js')) as typeof PoolModule;
  runner = (await import('../src/ai/ompSourcingRunner.js')) as typeof RunnerModule;
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(await client.getConnection());
});

afterAll(async () => {
  runner.setOmpSourcingRunnerOverride(null);
  delete process.env.DUCKDB_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

const CATEGORY_CLAIM_WINDOW = 'GPU';
const BRAND_CLAIM_WINDOW = 'AMD';
const PART_NUMBER_CLAIM_WINDOW = 'RX-SHUTDOWN-RACE-CLAIM-WINDOW-7900XT';
const PART_NUMBER_NO_JOB = 'RX-SHUTDOWN-RACE-CLAIM-WINDOW-NO-JOB';
const PART_NUMBER_REJECTION = 'RX-SHUTDOWN-RACE-CLAIM-WINDOW-REJECTION';

describe('price-parts worker pool claim-window race (R5/T5 retry-1)', () => {
  it(
    "stop() does not resolve while claimNextQueuedPriceJob is still in flight, before any job has even been found — activeCount must already be incremented at call time, not only once the claim resolves",
    async () => {
      await db.insertPriceCacheEntry(CATEGORY_CLAIM_WINDOW, BRAND_CLAIM_WINDOW, PART_NUMBER_CLAIM_WINDOW);
      const job = await db.createQueuedPriceJob(CATEGORY_CLAIM_WINDOW, BRAND_CLAIM_WINDOW, PART_NUMBER_CLAIM_WINDOW);

      // Holds claimNextQueuedPriceJob's own promise open on its first call
      // only, so pump() is parked exactly at "called claimNextQueuedPriceJob,
      // awaiting its resolution" for as long as the test needs — the window
      // the pre-fix pump() left unguarded, since it only incremented
      // activeCount after this await returned. The real DB-backed
      // implementation is never invoked here; the mocked job returned once
      // resolved is the actual row created above, so processJob's
      // subsequent writes below land on a real id. Every call after the
      // first resolves null immediately: once the job completes,
      // processJob's finally block re-enters pump(), which would otherwise
      // reclaim the same already-resolved deferred promise forever (a
      // `Promise.withResolvers` promise keeps returning its settled value
      // on every await), looping stop()'s drain indefinitely instead of
      // letting it settle.
      const claimDeferred = Promise.withResolvers<DbModule.PricePartsJob | null>();
      let claimCallCount = 0;
      const claimSpy = vi.spyOn(db, 'claimNextQueuedPriceJob').mockImplementation(async () => {
        claimCallCount += 1;
        if (claimCallCount === 1) {
          return claimDeferred.promise;
        }
        return null;
      });
      runner.setOmpSourcingRunnerOverride(async () => '{"confident":true,"priceUsd":456}');

      const handle = pool.startPricePartsWorkerPool();

      await vi.waitFor(() => {
        expect(claimCallCount).toBeGreaterThan(0);
      });

      let stopResolved = false;
      const stopPromise = handle.stop().then(() => {
        stopResolved = true;
      });

      // Falsification: pre-fix pump() incremented activeCount only after
      // this very await resolved, so at this point activeCount would still
      // read 0 and stop()'s drain loop would already have resolved.
      await delay(120);
      expect(stopResolved).toBe(false);

      claimDeferred.resolve(job);
      await stopPromise;
      expect(stopResolved).toBe(true);

      const cacheEntry = await db.findPriceCacheEntry(CATEGORY_CLAIM_WINDOW, BRAND_CLAIM_WINDOW, PART_NUMBER_CLAIM_WINDOW);
      expect(cacheEntry?.estimatedResaleValue).toBe(456);
      expect(await db.hasNonTerminalPriceJob(CATEGORY_CLAIM_WINDOW, BRAND_CLAIM_WINDOW, PART_NUMBER_CLAIM_WINDOW)).toBe(
        false,
      );

      claimSpy.mockRestore();
      handle.stop();
    },
    15_000,
  );

  it(
    'rolls activeCount back to its pre-call value when claimNextQueuedPriceJob resolves with no job found, so stop() still drains correctly and no slot leaks permanently open',
    async () => {
      await db.insertPriceCacheEntry(CATEGORY_CLAIM_WINDOW, BRAND_CLAIM_WINDOW, PART_NUMBER_NO_JOB);

      // No job is ever created for this combo, so the real
      // claimNextQueuedPriceJob would resolve null on its own — but this
      // test still controls it with a deferred promise so the
      // "claim called, still unresolved" window is held open long enough
      // for the assertion below to run deterministically rather than
      // relying on the real claim's own (fast, unobservable) timing.
      const claimDeferred = Promise.withResolvers<DbModule.PricePartsJob | null>();
      let claimCalled = false;
      const claimSpy = vi.spyOn(db, 'claimNextQueuedPriceJob').mockImplementation(async () => {
        claimCalled = true;
        return claimDeferred.promise;
      });

      const handle = pool.startPricePartsWorkerPool();

      await vi.waitFor(() => {
        expect(claimCalled).toBe(true);
      });

      let stopResolved = false;
      const stopPromise = handle.stop().then(() => {
        stopResolved = true;
      });

      // Same claim-in-flight window as the test above: activeCount must
      // already be non-zero here even though this call is about to resolve
      // with no job at all.
      await delay(120);
      expect(stopResolved).toBe(false);

      claimDeferred.resolve(null);

      // Falsification: if pump() rolled the increment back without ever
      // actually decrementing-to-zero correctly (e.g. forgot the rollback,
      // or rolled back twice), stop() would either hang past this bounded
      // wait or resolve it only "accidentally" for an unrelated reason;
      // this is the one case in the pair above where no processJob ever
      // runs to perform the usual finally-block decrement, so stop()
      // resolving here can only be explained by pump()'s own rollback.
      await stopPromise;
      expect(stopResolved).toBe(true);

      claimSpy.mockRestore();
      handle.stop();
    },
    15_000,
  );

  it(
    'rolls activeCount back to its pre-call value when claimNextQueuedPriceJob rejects (a transient DuckDB error, I/O hiccup, or lock contention), so stop() still drains correctly and no slot leaks permanently open (R5\'s second cycle-1 finding against T5)',
    async () => {
      await db.insertPriceCacheEntry(CATEGORY_CLAIM_WINDOW, BRAND_CLAIM_WINDOW, PART_NUMBER_REJECTION);

      // Same deferred-promise control as the pair above, except this
      // deferred promise is rejected rather than resolved — simulating a
      // transient DB error from inside claimNextQueuedPriceJob itself,
      // which (per db/queries/pricePartsJobs.ts) has no internal
      // try/catch of its own around its getConnection()/runAndReadAll()
      // calls.
      const claimDeferred = Promise.withResolvers<DbModule.PricePartsJob | null>();
      let claimCalled = false;
      const claimSpy = vi.spyOn(db, 'claimNextQueuedPriceJob').mockImplementation(async () => {
        claimCalled = true;
        return claimDeferred.promise;
      });

      const handle = pool.startPricePartsWorkerPool();

      await vi.waitFor(() => {
        expect(claimCalled).toBe(true);
      });

      let stopResolved = false;
      const stopPromise = handle.stop().then(() => {
        stopResolved = true;
      });

      // Same claim-in-flight window as the two tests above: activeCount
      // must already be non-zero here even though this call is about to
      // reject rather than resolve.
      await delay(120);
      expect(stopResolved).toBe(false);

      claimDeferred.reject(new Error('simulated transient DuckDB error'));

      // Falsification: before this fix, pump()'s activeCount increment
      // had no rollback on a rejection — only the job===null branch
      // rolled back — so this await would hang forever (stop()'s drain
      // loop never observing activeCount return to 0) and this test
      // would time out. pump() catches and logs the rejection internally
      // (never rethrowing through the fire-and-forget `void pump()` call
      // sites), so no unhandled rejection reaches this test either.
      await stopPromise;
      expect(stopResolved).toBe(true);

      claimSpy.mockRestore();
      handle.stop();
    },
    15_000,
  );
});

const CATEGORY = 'GPU';
const BRAND = 'AMD';
const PART_NUMBER = 'RX-SHUTDOWN-RACE-7900';

describe('price-parts worker pool shutdown race (R2)', () => {
  it(
    "stop() does not resolve until the mid-flight job's write lands, and the shutdown guard then refuses to reopen the database",
    async () => {
      await db.insertPriceCacheEntry(CATEGORY, BRAND, PART_NUMBER);
      await db.createQueuedPriceJob(CATEGORY, BRAND, PART_NUMBER);

      // Holds the AI call open until this test explicitly resolves it, so
      // processJob is parked exactly at "claimed the job, awaiting the AI
      // runner, has not yet touched updatePriceCacheEntryValue/
      // completePriceJob" for as long as the test needs.
      const aiCall = Promise.withResolvers<string>();
      let aiCalled = false;
      runner.setOmpSourcingRunnerOverride(async () => {
        aiCalled = true;
        return aiCall.promise;
      });

      const handle = pool.startPricePartsWorkerPool();

      // Deterministic condition wait (vi.waitFor polls a predicate, same
      // convention as pricePartsWorkerPool.test.ts's own suite) rather than
      // a sleep: resolves exactly when the override above has actually been
      // invoked, i.e. pump() claimed the job and processJob reached the AI
      // call.
      await vi.waitFor(() => {
        expect(aiCalled).toBe(true);
      });

      let stopResolved = false;
      const stopPromise = handle.stop().then(() => {
        stopResolved = true;
      });

      // Falsification: if stop() were reverted to the pre-fix shape (clear
      // the interval and return synchronously, with no activeCount drain),
      // stopResolved would already be true here — the fix's whole point is
      // that it cannot be, while the job is still parked on aiCall.
      await delay(120);
      expect(stopResolved).toBe(false);

      // The write genuinely hasn't landed yet — proves this isn't a stale
      // read, it's the actual still-in-flight state.
      const beforeResolve = await db.findPriceCacheEntry(CATEGORY, BRAND, PART_NUMBER);
      expect(beforeResolve?.estimatedResaleValue).toBeNull();

      aiCall.resolve('{"confident":true,"priceUsd":123}');
      await stopPromise;

      // No lost write: the job's own value, not null/stale, is what ended
      // up cached once stop() actually let the job finish.
      const afterResolve = await db.findPriceCacheEntry(CATEGORY, BRAND, PART_NUMBER);
      expect(afterResolve?.estimatedResaleValue).toBe(123);
      expect(await db.hasNonTerminalPriceJob(CATEGORY, BRAND, PART_NUMBER)).toBe(false);

      // Mirrors index.ts's real gracefulShutdown() ordering: the shutdown
      // guard is only raised once stop() has confirmed the drain, then
      // closeConnection() runs.
      client.beginShutdown();
      await client.closeConnection();

      // Falsification: if the shutdown guard were removed from
      // getConnection(), this would resolve a freshly reopened
      // DuckDBInstance (rerunning every migration) instead of rejecting.
      await expect(client.getConnection()).rejects.toThrow(
        'cannot open database connection: shutdown already in progress',
      );

      handle.stop();
    },
    15_000,
  );
});

