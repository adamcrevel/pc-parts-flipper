// T5 proof: apps/server/src/jobs/pricePartsWorkerPool.ts (Req 11).
//
// This suite isolates the worker pool from both DuckDB and the real AI
// runner by mocking the two modules it imports (db/index.js and
// ai/ompSourcingRunner.js), the same module-under-test isolation
// identifyPartsWorkerPool.test.ts uses for its own pool. That keeps the
// focus on the pool's own logic — claim/process sequencing, the
// found-price/no-confident-price/runner-crash outcome split, and the
// activeCount bookkeeping that frees a slot for the next job — rather than
// re-proving buildPriceEstimationPrompt/parsePriceEstimationResponse or the
// DB layer, which already have their own direct suites.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricePartsJob } from '../src/db/index.js';

const claimNextQueuedPriceJob = vi.fn<[], Promise<PricePartsJob | null>>();
const completePriceJob = vi.fn<[string], Promise<void>>();
const retryOrFailPriceJob = vi.fn<[string, string], Promise<void>>();
const resetOrphanedPriceJobsToQueued = vi.fn<[], Promise<string[]>>();
const updatePriceCacheEntryValue = vi.fn<[string, string, string, number | null], Promise<void>>();
const propagateCachedPriceToExpectedParts = vi.fn<[string, string, string, number], Promise<void>>();

// Mocking the whole db/index.js barrel (rather than the single
// pricePartsJobs.ts/partPriceCache.ts query files) matches how the worker
// pool itself imports it (`from '../db/index.js'`), so vi.mock's specifier
// resolves to the exact module the pool sees. vi.mock is hoisted above
// this file's imports, so the static import of pricePartsWorkerPool.ts
// below already sees these mocks.
vi.mock('../src/db/index.js', () => ({
  claimNextQueuedPriceJob: (...args: []) => claimNextQueuedPriceJob(...args),
  completePriceJob: (...args: [string]) => completePriceJob(...args),
  retryOrFailPriceJob: (...args: [string, string]) => retryOrFailPriceJob(...args),
  resetOrphanedPriceJobsToQueued: (...args: []) => resetOrphanedPriceJobsToQueued(...args),
  updatePriceCacheEntryValue: (...args: [string, string, string, number | null]) =>
    updatePriceCacheEntryValue(...args),
  propagateCachedPriceToExpectedParts: (...args: [string, string, string, number]) =>
    propagateCachedPriceToExpectedParts(...args),
}));

const ompSourcingRunner = vi.fn<[string, { timeoutMs?: number } | undefined], Promise<string>>();
vi.mock('../src/ai/ompSourcingRunner.js', () => ({
  getOmpSourcingRunner: () => (...args: [string, { timeoutMs?: number } | undefined]) => ompSourcingRunner(...args),
}));

import { startPricePartsWorkerPool } from '../src/jobs/pricePartsWorkerPool.js';
import { logger } from '../src/logger.js';

function jobFixture(id: string, category = 'CPU', brand = 'Intel', partNumber = 'i7-9700K'): PricePartsJob {
  return {
    id,
    category: category as PricePartsJob['category'],
    brand,
    partNumber,
    stage: 'pricing',
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  };
}

// Every pool handle started by a test is stopped in afterEach, so a test's
// 1000ms poll interval never outlives the test and leaks into the next one
// (or leaves vitest's process waiting on an open timer handle).
let activeHandle: { stop(): void } | null = null;

beforeEach(() => {
  claimNextQueuedPriceJob.mockReset().mockResolvedValue(null);
  completePriceJob.mockReset().mockResolvedValue(undefined);
  retryOrFailPriceJob.mockReset().mockResolvedValue(undefined);
  resetOrphanedPriceJobsToQueued.mockReset().mockResolvedValue([]);
  updatePriceCacheEntryValue.mockReset().mockResolvedValue(undefined);
  propagateCachedPriceToExpectedParts.mockReset().mockResolvedValue(undefined);
  ompSourcingRunner.mockReset();
  vi.spyOn(logger, 'info').mockImplementation(() => logger);
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  activeHandle?.stop();
  activeHandle = null;
});

describe('startPricePartsWorkerPool (T5, Req 11)', () => {
  it('resets orphaned jobs to queued on startup before any claim work runs', async () => {
    resetOrphanedPriceJobsToQueued.mockResolvedValue(['orphan-1', 'orphan-2']);

    activeHandle = startPricePartsWorkerPool();

    await vi.waitFor(() => expect(resetOrphanedPriceJobsToQueued).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith({ resetCount: 2 }, 'Recovered orphaned price-parts jobs'),
    );
  });

  it('claims a queued job, caches the found price, propagates it, and completes the job', async () => {
    const job = jobFixture('job-A');
    claimNextQueuedPriceJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    ompSourcingRunner.mockResolvedValue('{"confident":true,"priceUsd":45.5}');

    activeHandle = startPricePartsWorkerPool();

    await vi.waitFor(() => expect(completePriceJob).toHaveBeenCalledTimes(1));

    expect(updatePriceCacheEntryValue).toHaveBeenCalledWith('CPU', 'Intel', 'i7-9700K', 45.5);
    expect(propagateCachedPriceToExpectedParts).toHaveBeenCalledWith('CPU', 'Intel', 'i7-9700K', 45.5);
    expect(completePriceJob).toHaveBeenCalledWith('job-A');
    expect(retryOrFailPriceJob).not.toHaveBeenCalled();
  });

  it('completes a no-confident-price job with the cache value left null and never propagates', async () => {
    const job = jobFixture('job-B');
    claimNextQueuedPriceJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    ompSourcingRunner.mockResolvedValue('{"confident":false,"priceUsd":null}');

    activeHandle = startPricePartsWorkerPool();

    await vi.waitFor(() => expect(completePriceJob).toHaveBeenCalledTimes(1));

    expect(updatePriceCacheEntryValue).toHaveBeenCalledWith('CPU', 'Intel', 'i7-9700K', null);
    expect(propagateCachedPriceToExpectedParts).not.toHaveBeenCalled();
    expect(completePriceJob).toHaveBeenCalledWith('job-B');
    expect(retryOrFailPriceJob).not.toHaveBeenCalled();
  });

  it('retries (requeues, never permanently fails) a job whose AI runner call crashes, recording the error message', async () => {
    const job = jobFixture('job-C');
    claimNextQueuedPriceJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    ompSourcingRunner.mockRejectedValue(new Error('omp spawn failed'));

    activeHandle = startPricePartsWorkerPool();

    await vi.waitFor(() => expect(retryOrFailPriceJob).toHaveBeenCalledTimes(1));

    expect(retryOrFailPriceJob).toHaveBeenCalledWith('job-C', 'omp spawn failed');
    expect(completePriceJob).not.toHaveBeenCalled();
    expect(updatePriceCacheEntryValue).not.toHaveBeenCalled();
    expect(propagateCachedPriceToExpectedParts).not.toHaveBeenCalled();
  });

  // Proves the pool's own activeCount bookkeeping: with the default pool
  // size of 1, after the first claimed job finishes (successfully or not)
  // the slot it held must be freed so the very next pump() call can claim
  // and process a second job. If the pool never decremented activeCount on
  // completion, job-2 would never be claimed and ompSourcingRunner would be
  // called exactly once instead of twice.
  it('frees its slot after a job fails, so the pool immediately claims and processes the next queued job', async () => {
    const jobFailing = jobFixture('job-1', 'CPU', 'Intel', 'bad-part');
    const jobOk = jobFixture('job-2', 'CPU', 'AMD', 'good-part');

    claimNextQueuedPriceJob
      .mockResolvedValueOnce(jobFailing)
      .mockResolvedValueOnce(jobOk)
      .mockResolvedValue(null);
    ompSourcingRunner.mockImplementation(async (prompt) => {
      if (prompt.includes('bad-part')) {
        throw new Error('boom');
      }
      return '{"confident":true,"priceUsd":10}';
    });

    activeHandle = startPricePartsWorkerPool();

    await vi.waitFor(() => expect(completePriceJob).toHaveBeenCalledTimes(1));

    expect(retryOrFailPriceJob).toHaveBeenCalledWith('job-1', 'boom');
    expect(completePriceJob).toHaveBeenCalledWith('job-2');
    expect(ompSourcingRunner).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the poll interval so no further claim attempt is made', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    activeHandle = startPricePartsWorkerPool();
    await vi.waitFor(() => expect(claimNextQueuedPriceJob).toHaveBeenCalled());

    activeHandle.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

// T5 fallback proof, mirroring identifyPartsWorkerPool.test.ts's own
// parsePoolSize coverage for IDENTIFY_PARTS_POOL_SIZE: an empty-string or
// non-numeric PRICE_PARTS_POOL_SIZE must not silently become POOL_SIZE
// 0/NaN (which makes pump()'s `activeCount < POOL_SIZE` false forever, so
// jobs enqueue but are never claimed). process.env.PRICE_PARTS_POOL_SIZE is
// read once, at module load, into the module-scope POOL_SIZE constant —
// the static import at the top of this file already evaluated it with
// whatever the env var was at file-load time, so exercising a *different*
// raw value here requires setting the env var, clearing vitest's module
// cache with vi.resetModules(), and re-importing the module so POOL_SIZE is
// recomputed. vi.mock registrations (db/index.js, ai/ompSourcingRunner.js)
// survive resetModules — only the module cache is cleared, not the mock
// registry — so the fresh module instance still resolves to this file's
// same claimNextQueuedPriceJob/completePriceJob/etc. mock functions.
// Placed last in the file (after every test using the originally
// statically-imported startPricePartsWorkerPool) so resetModules here
// can't affect any earlier test's already-captured import bindings.
describe('parsePoolSize fallback for PRICE_PARTS_POOL_SIZE (T5)', () => {
  const originalPoolSize = process.env.PRICE_PARTS_POOL_SIZE;

  afterEach(() => {
    if (originalPoolSize === undefined) {
      delete process.env.PRICE_PARTS_POOL_SIZE;
    } else {
      process.env.PRICE_PARTS_POOL_SIZE = originalPoolSize;
    }
  });

  async function assertPoolStillProcessesAJob(): Promise<void> {
    vi.resetModules();

    const job = jobFixture('job-fallback');
    claimNextQueuedPriceJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    ompSourcingRunner.mockResolvedValue('{"confident":true,"priceUsd":5}');

    // Exception to static-import preference: this module's POOL_SIZE is a
    // module-scope constant computed once at import time from
    // process.env.PRICE_PARTS_POOL_SIZE, so a static top-of-file import can
    // only ever observe the env var as it was when this test file first
    // loaded. Proving the fallback for a *different* raw value requires
    // setting the env var and re-triggering module evaluation at runtime
    // via vi.resetModules() + a dynamic import — a static import genuinely
    // cannot do this, matching this rule's own "test cases that
    // intentionally exercise module loading boundaries" exception.
    const { startPricePartsWorkerPool: freshStart } = await import('../src/jobs/pricePartsWorkerPool.js');
    activeHandle = freshStart();

    // If parsePoolSize had let POOL_SIZE become 0 (empty string via the old
    // `Number(raw ?? 1)`) or NaN (non-numeric string), pump()'s
    // `activeCount < POOL_SIZE` comparison is false on every call, so
    // claimNextQueuedPriceJob is never invoked and completePriceJob never
    // fires — this wait would time out and fail the test instead of
    // resolving.
    await vi.waitFor(() => expect(completePriceJob).toHaveBeenCalledTimes(1));
    expect(completePriceJob).toHaveBeenCalledWith('job-fallback');
  }

  it('falls back to POOL_SIZE 1 and still claims+completes a queued job when PRICE_PARTS_POOL_SIZE is an empty string', async () => {
    process.env.PRICE_PARTS_POOL_SIZE = '';
    await assertPoolStillProcessesAJob();
  });

  it('falls back to POOL_SIZE 1 and still claims+completes a queued job when PRICE_PARTS_POOL_SIZE is a non-numeric string', async () => {
    process.env.PRICE_PARTS_POOL_SIZE = 'not-a-number';
    await assertPoolStillProcessesAJob();
  });
});
