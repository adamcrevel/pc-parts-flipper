// T5 proof: apps/server/src/ai/sourcingConcurrencyLimiter.ts (Req 4).
//
// The module under test is a pure, in-process counting semaphore with no
// DB/network dependency, so this suite drives it directly with fake async
// functions whose resolution order is controlled manually via
// Promise.withResolvers deferreds (same pattern as helpers.ts,
// gracefulShutdown.test.ts, referenceSourcingOrchestrator.test.ts, etc.) —
// no server, no fake timers, no mocked modules needed.
//
// Each test that depends on SOURCING_PER_BRAND_CONCURRENCY's parsed value
// (the fallback-parsing suite below) sets the env var and re-imports the
// module fresh via vi.resetModules() + a dynamic import: SOURCING_PER_BRAND_
// CONCURRENCY is read once, into a module-scope constant, at import time, so
// a static top-of-file import could only ever observe whatever value was set
// when this file first loaded (the same module-loading-boundary exception
// identifyPartsWorkerPool.test.ts's own parsePoolSize suite documents). The
// default-concurrency suite above it also re-imports fresh per test (rather
// than using one static import) so each test starts with its own empty
// brandState map instead of sharing accumulated per-brand slot state with
// every other test in the file.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { runWithBrandLimit as RunWithBrandLimit } from '../src/ai/sourcingConcurrencyLimiter.js';

// Drains the microtask queue (and one macrotask turn) so every already-
// settled promise's .then chain has actually run before the next assertion
// — needed because runWithBrandLimit's own internal `await`s (acquireSlot,
// fn()) each take at least one microtask turn to observably progress.
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe('runWithBrandLimit (default SOURCING_PER_BRAND_CONCURRENCY, unset)', () => {
  const originalEnv = process.env.SOURCING_PER_BRAND_CONCURRENCY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SOURCING_PER_BRAND_CONCURRENCY;
    } else {
      process.env.SOURCING_PER_BRAND_CONCURRENCY = originalEnv;
    }
  });

  async function freshRunWithBrandLimit(): Promise<typeof RunWithBrandLimit> {
    delete process.env.SOURCING_PER_BRAND_CONCURRENCY;
    vi.resetModules();
    // Dynamic import deliberately, not a static top-of-file one: this test
    // needs a fresh module instance (its own empty brandState Map) per test
    // case, which only re-triggering module evaluation at runtime can give
    // — a static import is evaluated once for the whole file.
    const mod = await import('../src/ai/sourcingConcurrencyLimiter.js');
    return mod.runWithBrandLimit;
  }

  it('serializes two calls for the same brand: the second does not start until the first resolves', async () => {
    const runWithBrandLimit = await freshRunWithBrandLimit();
    const order: string[] = [];
    const d1 = Promise.withResolvers<void>();
    const d2 = Promise.withResolvers<void>();

    const call1 = runWithBrandLimit('Zotac', async () => {
      order.push('1-start');
      await d1.promise;
      order.push('1-end');
    });
    await tick();
    // Only call1 has been admitted — call2 hasn't even been issued yet, so
    // there is nothing else that could appear in `order` at this point.
    expect(order).toEqual(['1-start']);

    const call2 = runWithBrandLimit('zotac', async () => {
      order.push('2-start');
      await d2.promise;
      order.push('2-end');
    });
    await tick();
    // call2 targets the same brand (differing only by case) while call1's
    // slot is still held — it must be queued, not admitted.
    expect(order).toEqual(['1-start']);

    d1.resolve();
    await call1;
    await tick();
    expect(order).toEqual(['1-start', '1-end', '2-start']);

    d2.resolve();
    await call2;
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  it('runs two calls for different brands concurrently, neither waiting on the other', async () => {
    const runWithBrandLimit = await freshRunWithBrandLimit();
    const order: string[] = [];
    const dA = Promise.withResolvers<void>();
    const dB = Promise.withResolvers<void>();

    const callA = runWithBrandLimit('zotac', async () => {
      order.push('a-start');
      await dA.promise;
      order.push('a-end');
    });
    const callB = runWithBrandLimit('crucial', async () => {
      order.push('b-start');
      await dB.promise;
      order.push('b-end');
    });
    await tick();
    // Both brands' first call is admitted immediately — if brand keying
    // were broken (e.g. one shared slot for every brand), callB would still
    // be queued behind callA here.
    expect(order).toEqual(['a-start', 'b-start']);

    dA.resolve();
    dB.resolve();
    await Promise.all([callA, callB]);
    expect(order).toEqual(['a-start', 'b-start', 'a-end', 'b-end']);
  });

  it('releases the slot when fn throws, so the next waiter for the same brand still proceeds', async () => {
    const runWithBrandLimit = await freshRunWithBrandLimit();
    const order: string[] = [];

    const call1 = runWithBrandLimit('amd', async () => {
      order.push('1-start');
      throw new Error('simulated infra failure');
    });
    await expect(call1).rejects.toThrow('simulated infra failure');

    const d2 = Promise.withResolvers<void>();
    const call2 = runWithBrandLimit('amd', async () => {
      order.push('2-start');
      await d2.promise;
      order.push('2-end');
    });
    await tick();
    // If the slot had leaked (no `finally` release on throw), call2 would
    // still be stuck waiting and '2-start' would never appear here.
    expect(order).toEqual(['1-start', '2-start']);

    d2.resolve();
    await call2;
  });

  it('wakes queued waiters for the same brand in FIFO order (arrival order), not reverse order', async () => {
    const runWithBrandLimit = await freshRunWithBrandLimit();
    const order: string[] = [];
    const deferreds = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];

    const calls = [1, 2, 3].map((n) =>
      runWithBrandLimit('nvidia', async () => {
        order.push(`${n}-start`);
        await deferreds[n - 1].promise;
        order.push(`${n}-end`);
      })
    );
    await tick();
    expect(order).toEqual(['1-start']);

    deferreds[0].resolve();
    await tick();
    // If waiters were woken LIFO instead of FIFO, call3 (the most recently
    // queued) would start here instead of call2.
    expect(order).toEqual(['1-start', '1-end', '2-start']);

    deferreds[1].resolve();
    await tick();
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end', '3-start']);

    deferreds[2].resolve();
    await Promise.all(calls);
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end', '3-start', '3-end']);
  });
});

describe('SOURCING_PER_BRAND_CONCURRENCY parsing fallback', () => {
  const originalEnv = process.env.SOURCING_PER_BRAND_CONCURRENCY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SOURCING_PER_BRAND_CONCURRENCY;
    } else {
      process.env.SOURCING_PER_BRAND_CONCURRENCY = originalEnv;
    }
  });

  async function freshRunWithBrandLimit(rawEnvValue: string): Promise<typeof RunWithBrandLimit> {
    process.env.SOURCING_PER_BRAND_CONCURRENCY = rawEnvValue;
    vi.resetModules();
    // Dynamic import deliberately: SOURCING_PER_BRAND_CONCURRENCY is parsed
    // once into a module-scope constant at import time, so proving the
    // fallback for a given raw env value requires setting the env var and
    // re-triggering module evaluation at runtime — a static import can only
    // ever observe the value present when this file first loaded.
    const mod = await import('../src/ai/sourcingConcurrencyLimiter.js');
    return mod.runWithBrandLimit;
  }

  async function assertFallsBackToLimitOne(rawEnvValue: string): Promise<void> {
    const runWithBrandLimit = await freshRunWithBrandLimit(rawEnvValue);
    const order: string[] = [];
    const d1 = Promise.withResolvers<void>();

    const call1 = runWithBrandLimit('intel', async () => {
      order.push('1-start');
      await d1.promise;
    });
    await tick();
    // If the bad raw value had been allowed to become 0 (rather than
    // falling back to 1), `active < 0` would never be true and call1 itself
    // would already be stuck queued here instead of having started.
    expect(order).toEqual(['1-start']);

    const d2 = Promise.withResolvers<void>();
    const call2 = runWithBrandLimit('intel', async () => {
      order.push('2-start');
      await d2.promise;
    });
    await tick();
    // The second same-brand call must still be queued behind the first —
    // proving the effective limit is exactly 1, not something larger that a
    // permissive (non-fallback) parse of the bad raw value might produce.
    expect(order).toEqual(['1-start']);

    d1.resolve();
    await call1;
    await tick();
    expect(order).toEqual(['1-start', '2-start']);
    d2.resolve();
    await call2;
  }

  it('falls back to a limit of 1 when SOURCING_PER_BRAND_CONCURRENCY is an empty string', async () => {
    await assertFallsBackToLimitOne('');
  });

  it('falls back to a limit of 1 when SOURCING_PER_BRAND_CONCURRENCY is a non-numeric string', async () => {
    await assertFallsBackToLimitOne('not-a-number');
  });

  it('falls back to a limit of 1 when SOURCING_PER_BRAND_CONCURRENCY is negative', async () => {
    await assertFallsBackToLimitOne('-5');
  });

  it('honors a SOURCING_PER_BRAND_CONCURRENCY of exactly 0 as a valid (if hazardous) value, not a fallback to 1', async () => {
    const runWithBrandLimit = await freshRunWithBrandLimit('0');
    const order: string[] = [];
    const d = Promise.withResolvers<void>();

    // Intentionally not awaited: with a limit of 0, `active < 0` is never
    // true, so this call is queued forever and never admitted — exactly
    // the documented hazard. Only the microtask-flush assertion below is
    // checked; the call itself is left pending on purpose.
    void runWithBrandLimit('intel', async () => {
      order.push('started');
      await d.promise;
    });
    await tick();
    // If 0 had been treated like the invalid negative/non-numeric cases and
    // fallen back to the default of 1, the call above would have been
    // admitted and 'started' would appear here.
    expect(order).toEqual([]);
  });

  it('honors a custom positive SOURCING_PER_BRAND_CONCURRENCY, admitting exactly that many concurrent calls for one brand', async () => {
    const runWithBrandLimit = await freshRunWithBrandLimit('2');
    const order: string[] = [];
    const deferreds = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];

    const calls = [0, 1, 2].map((n) =>
      runWithBrandLimit('amd', async () => {
        order.push(`${n}-start`);
        await deferreds[n].promise;
        order.push(`${n}-end`);
      })
    );
    await tick();
    // Both of the first two calls are admitted at once — proving the parsed
    // limit is 2, not the default of 1 — while the third is queued.
    expect(order).toEqual(['0-start', '1-start']);

    deferreds[0].resolve();
    await tick();
    expect(order).toEqual(['0-start', '1-start', '0-end', '2-start']);

    deferreds[1].resolve();
    deferreds[2].resolve();
    await Promise.all(calls);
  });
});
