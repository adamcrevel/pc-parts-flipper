// T8 proof: apps/server/src/scan/scheduler.ts (Req 6, 9).
//
// A real 2am cron fire can't practically be asserted, so this suite instead:
//   (a) unit-tests runScheduledScan — the function the cron callback invokes
//       — directly, against a mocked scanService.ts module (matching
//       scanService.test.ts's own module-under-test isolation rather than
//       scan.test.ts's fetch-stub-through-real-DB approach, since scheduler.ts
//       has no DB/connector logic of its own to exercise honestly); and
//   (b) confirms startScheduler registers a valid once-daily cron expression
//       by asserting on node-cron's own `validate` export against the literal
//       expression startScheduler passes to `schedule`.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { validate } from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { logger } from '../src/logger.js';
import type { ScanAllResult } from '../src/scan/scanService.js';

// scanAllEligibleSources is the only scanService export scheduler.ts calls;
// mocking the whole module keeps this suite from touching DuckDB or the
// real eBay connector, the same boundary scanService.test.ts already
// exercises on scanAllEligibleSources's own behalf. vi.mock is hoisted
// above this file's imports, so the static import of scheduler.ts below
// already sees the mocked scanService.ts.
const scanAllEligibleSources = vi.fn<[], Promise<ScanAllResult>>();
vi.mock('../src/scan/scanService.js', () => ({
  scanAllEligibleSources: (...args: unknown[]) => scanAllEligibleSources(...(args as [])),
}));

// node-cron's named exports live on a non-configurable ESM namespace object,
// so `schedule` can't be vi.spyOn'd directly (vitest throws "Module
// namespace is not configurable"); mocking the module and keeping every
// other export (validate, in particular) wired to the real implementation
// is the supported way to observe `schedule`'s call args instead.
const scheduleMock = vi.fn<(expression: string, fn: () => void) => ScheduledTask>();
vi.mock('node-cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-cron')>();
  return { ...actual, schedule: (...args: Parameters<typeof scheduleMock>) => scheduleMock(...args) };
});

// Imported after the vi.mock call above (hoisted ahead of it regardless) so
// every call inside scheduler.ts to scanAllEligibleSources resolves to the
// mock rather than the real DB-backed implementation.
import { runScheduledScan, startScheduler } from '../src/scan/scheduler.js';

let infoSpy: MockInstance<(...args: unknown[]) => void>;
let errorSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  scanAllEligibleSources.mockReset();
  scheduleMock.mockReset();
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runScheduledScan (T8, Req 6, 9)', () => {
  it('logs an Info start line and an Info summary line on a normal run, without throwing', async () => {
    scanAllEligibleSources.mockResolvedValue({
      sources: [{ sourceId: 'src-1', foundCount: 3, newCount: 1 }],
      totalFound: 3,
      totalNew: 1,
    });

    await expect(runScheduledScan()).resolves.toBeUndefined();

    expect(infoSpy).toHaveBeenCalledWith('Scheduled scan starting');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ totalFound: 3, totalNew: 1, scannedCount: 1 }),
      'Scheduled scan completed',
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs an Error line naming the failing Source when one outcome carries an error, and does not throw', async () => {
    scanAllEligibleSources.mockResolvedValue({
      sources: [
        { sourceId: 'src-ok', foundCount: 2, newCount: 0 },
        { sourceId: 'src-bad', error: 'connector timed out' },
      ],
      totalFound: 2,
      totalNew: 0,
    });

    await expect(runScheduledScan()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-bad', error: 'connector timed out' }),
      'Scheduled scan failed for Source',
    );
    // The summary line still reports the Sources that did succeed.
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ totalFound: 2, totalNew: 0, scannedCount: 2 }),
      'Scheduled scan completed',
    );
  });

  it('catches a rejection of scanAllEligibleSources itself, logs it at Error level, and does not throw', async () => {
    scanAllEligibleSources.mockRejectedValue(new Error('DB connection lost'));

    await expect(runScheduledScan()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'DB connection lost' }),
      'Scheduled scan run failed unexpectedly',
    );
    // A top-level rejection never reaches the per-run summary line.
    expect(infoSpy).not.toHaveBeenCalledWith(expect.anything(), 'Scheduled scan completed');
  });
});

describe('startScheduler (T8, Req 6, 9)', () => {
  it('registers a cron job using a valid once-daily expression', () => {
    // Minimal stand-in ScheduledTask so startScheduler's return type is
    // satisfied without a real cron timer being armed.
    const fakeTask: ScheduledTask = {
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
    scheduleMock.mockReturnValue(fakeTask);

    startScheduler();

    expect(scheduleMock).toHaveBeenCalledTimes(1);
    const [expression] = scheduleMock.mock.calls[0]!;
    expect(validate(expression)).toBe(true);
    // Once-daily: five cron fields, each of the four non-minute fields
    // pinned to a single value (day-of-month/month never `*` together with
    // an unpinned hour) — distinguishes "once daily" from "every hour"/
    // "every minute".
    const fields = expression.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour, dayOfMonth, month] = fields;
    expect(minute).not.toBe('*');
    expect(hour).not.toBe('*');
    expect(dayOfMonth).toBe('*');
    expect(month).toBe('*');
  });

  it('calls runScheduledScan when the cron callback fires (Req 6)', async () => {
    scanAllEligibleSources.mockResolvedValue({
      sources: [],
      totalFound: 0,
      totalNew: 0,
    });

    const fakeTask: ScheduledTask = {
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
    scheduleMock.mockReturnValue(fakeTask);

    startScheduler();

    // Extract the callback function from the schedule mock call
    const [, callback] = scheduleMock.mock.calls[0]!;

    // Call the callback and verify scanAllEligibleSources was invoked
    await callback();

    expect(scanAllEligibleSources).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith('Scheduled scan starting');
  });
});
