// T6 proof: apps/server/src/jobs/priceRefreshScheduler.ts (Req 8).
//
// A real 3am cron fire can't practically be asserted, so this suite instead
// mirrors scan/scheduler.test.ts's own precedent exactly:
//   (a) unit-tests runScheduledPriceRefresh — the function the cron callback
//       invokes — directly, against a mocked db/index.ts module (the only
//       boundary this file crosses; no DuckDB connection is opened); and
//   (b) confirms startPriceRefreshScheduler registers a valid once-daily
//       cron expression by asserting on node-cron's own `validate` export
//       against the literal expression startPriceRefreshScheduler passes to
//       `schedule`.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { validate } from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type * as NodeCron from 'node-cron';
import { logger } from '../src/logger.js';
import type { PartPriceCacheEntry } from '../src/db/types.js';

// listAllPriceCacheEntries/hasNonTerminalPriceJob/createQueuedPriceJob are
// the only db/index.ts exports priceRefreshScheduler.ts calls; mocking the
// whole module keeps this suite from touching DuckDB, the same boundary
// scheduler.test.ts already exercises on scanService.ts's own behalf.
// vi.mock is hoisted above this file's imports, so the static import of
// priceRefreshScheduler.ts below already sees the mocked db/index.js.
const listAllPriceCacheEntries = vi.fn<[], Promise<PartPriceCacheEntry[]>>();
const hasNonTerminalPriceJob = vi.fn<[string, string, string], Promise<boolean>>();
const createQueuedPriceJob = vi.fn<[string, string, string], Promise<unknown>>();
vi.mock('../src/db/index.js', () => ({
  listAllPriceCacheEntries: (...args: unknown[]) => listAllPriceCacheEntries(...(args as [])),
  hasNonTerminalPriceJob: (...args: unknown[]) => hasNonTerminalPriceJob(...(args as [string, string, string])),
  createQueuedPriceJob: (...args: unknown[]) => createQueuedPriceJob(...(args as [string, string, string])),
}));

// node-cron's named exports live on a non-configurable ESM namespace object,
// so `schedule` can't be vi.spyOn'd directly; mocking the module and
// keeping every other export (validate, in particular) wired to the real
// implementation is the supported way to observe `schedule`'s call args
// instead (same pattern as scheduler.test.ts).
const scheduleMock = vi.fn<(expression: string, fn: () => void) => ScheduledTask>();
vi.mock('node-cron', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCron>();
  return { ...actual, schedule: (...args: Parameters<typeof scheduleMock>) => scheduleMock(...args) };
});

// Imported after the vi.mock calls above (hoisted ahead of them regardless)
// so every call inside priceRefreshScheduler.ts to these db functions
// resolves to the mocks rather than a real DB-backed implementation.
import { runScheduledPriceRefresh, startPriceRefreshScheduler } from '../src/jobs/priceRefreshScheduler.js';

let infoSpy: MockInstance<(...args: unknown[]) => void>;
let errorSpy: MockInstance<(...args: unknown[]) => void>;

function makeEntry(overrides: Partial<PartPriceCacheEntry>): PartPriceCacheEntry {
  return {
    id: 'entry-id',
    category: 'CPU',
    brand: 'Intel',
    partNumber: 'i7-9700K',
    estimatedResaleValue: null,
    comps: [],
    lastResearchedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  listAllPriceCacheEntries.mockReset();
  hasNonTerminalPriceJob.mockReset();
  createQueuedPriceJob.mockReset();
  scheduleMock.mockReset();
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runScheduledPriceRefresh (T6, Req 8)', () => {
  it('enqueues a job for every cache entry, including one that already has a non-null value', async () => {
    const pricedEntry = makeEntry({
      category: 'CPU',
      brand: 'Intel',
      partNumber: 'i7-9700K',
      estimatedResaleValue: 150,
    });
    const unpricedEntry = makeEntry({
      category: 'GPU',
      brand: 'Nvidia',
      partNumber: 'RTX-3080',
      estimatedResaleValue: null,
    });
    listAllPriceCacheEntries.mockResolvedValue([pricedEntry, unpricedEntry]);
    hasNonTerminalPriceJob.mockResolvedValue(false);
    createQueuedPriceJob.mockResolvedValue(undefined);

    await expect(runScheduledPriceRefresh()).resolves.toBeUndefined();

    // Req 8: the already-priced entry is swept exactly like the unpriced
    // one — no filter on estimatedResaleValue anywhere in the sweep.
    expect(createQueuedPriceJob).toHaveBeenCalledTimes(2);
    expect(createQueuedPriceJob).toHaveBeenCalledWith('CPU', 'Intel', 'i7-9700K');
    expect(createQueuedPriceJob).toHaveBeenCalledWith('GPU', 'Nvidia', 'RTX-3080');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enqueuedCount: 2, skippedCount: 0, totalCount: 2 }),
      'Scheduled price refresh completed',
    );
  });

  it('skips an entry that already has a non-terminal job in flight, enqueuing nothing for it', async () => {
    const queuedEntry = makeEntry({ category: 'CPU', brand: 'AMD', partNumber: 'R7-5800X' });
    const freeEntry = makeEntry({ category: 'Motherboard', brand: 'Asus', partNumber: 'ROG-B550' });
    listAllPriceCacheEntries.mockResolvedValue([queuedEntry, freeEntry]);
    // Only the first combo already has a non-terminal job; the second does not.
    hasNonTerminalPriceJob.mockImplementation((category) => Promise.resolve(category === 'CPU'));
    createQueuedPriceJob.mockResolvedValue(undefined);

    await expect(runScheduledPriceRefresh()).resolves.toBeUndefined();

    // Dedup: the already-queued combo gets no second job...
    expect(createQueuedPriceJob).not.toHaveBeenCalledWith('CPU', 'AMD', 'R7-5800X');
    expect(createQueuedPriceJob).toHaveBeenCalledTimes(1);
    // ...while the free combo is still enqueued normally.
    expect(createQueuedPriceJob).toHaveBeenCalledWith('Motherboard', 'Asus', 'ROG-B550');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enqueuedCount: 1, skippedCount: 1, totalCount: 2 }),
      'Scheduled price refresh completed',
    );
  });

  it('isolates one entry failing to enqueue so later entries still get processed (per-entry isolation, mirrors scanAllEligibleSources)', async () => {
    const failingEntry = makeEntry({ category: 'CPU', brand: 'AMD', partNumber: 'R7-5800X' });
    const laterEntry = makeEntry({ category: 'Motherboard', brand: 'Asus', partNumber: 'ROG-B550' });
    listAllPriceCacheEntries.mockResolvedValue([failingEntry, laterEntry]);
    hasNonTerminalPriceJob.mockResolvedValue(false);
    createQueuedPriceJob.mockImplementation((category: string) => {
      if (category === 'CPU') {
        return Promise.reject(new Error('enqueue failed for CPU combo'));
      }
      return Promise.resolve(undefined);
    });

    await expect(runScheduledPriceRefresh()).resolves.toBeUndefined();

    // The failing entry's own enqueue attempt was made (and rejected)...
    expect(createQueuedPriceJob).toHaveBeenCalledWith('CPU', 'AMD', 'R7-5800X');
    // ...but the entry after it was still reached and enqueued normally,
    // proving the throw on entry N did not abort the sweep before N+1.
    expect(createQueuedPriceJob).toHaveBeenCalledWith('Motherboard', 'Asus', 'ROG-B550');
    expect(createQueuedPriceJob).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'CPU',
        brand: 'AMD',
        partNumber: 'R7-5800X',
        err: 'enqueue failed for CPU combo',
      }),
      'Scheduled price refresh failed for one cache entry; continuing with the rest',
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enqueuedCount: 1, skippedCount: 0, erroredCount: 1, totalCount: 2 }),
      'Scheduled price refresh completed',
    );
  });

  it('catches a rejection of listAllPriceCacheEntries itself, logs it at Error level, and does not throw', async () => {
    listAllPriceCacheEntries.mockRejectedValue(new Error('DB connection lost'));

    await expect(runScheduledPriceRefresh()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'DB connection lost' }),
      'Scheduled price refresh run failed unexpectedly',
    );
    expect(createQueuedPriceJob).not.toHaveBeenCalled();
  });
});

describe('startPriceRefreshScheduler (T6, Req 8)', () => {
  function fakeScheduledTask(): ScheduledTask {
    return {
      id: 'fake',
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(() => 'idle'),
      destroy: vi.fn(),
      execute: vi.fn(() => Promise.resolve()),
      getNextRun: vi.fn(() => null),
      getNextRuns: vi.fn(() => []),
      match: vi.fn(() => false),
      msToNext: vi.fn(() => null),
      isBusy: vi.fn(() => false),
      runsLeft: vi.fn(() => undefined),
      getPattern: vi.fn(() => ''),
      lastRun: vi.fn(() => null),
      unref: vi.fn(),
      ref: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    };
  }

  it('registers a cron job using a valid once-daily expression, distinct from the 2am scan job', () => {
    scheduleMock.mockReturnValue(fakeScheduledTask());

    startPriceRefreshScheduler();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [expression] = scheduleMock.mock.calls[0]!;
    expect(validate(expression)).toBe(true);
    // Literal 3am schedule (A4) — distinct from scan/scheduler.ts's 2am job.
    expect(expression).toBe('0 3 * * *');
    const fields = expression.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour, dayOfMonth, month] = fields;
    expect(minute).not.toBe('*');
    expect(hour).not.toBe('*');
    expect(dayOfMonth).toBe('*');
    expect(month).toBe('*');
  });

  it('calls runScheduledPriceRefresh when the cron callback fires', async () => {
    listAllPriceCacheEntries.mockResolvedValue([]);
    scheduleMock.mockReturnValue(fakeScheduledTask());

    startPriceRefreshScheduler();

    const [, callback] = scheduleMock.mock.calls[0]!;
    await callback();

    expect(listAllPriceCacheEntries).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Scheduled price refresh starting');
  });
});
