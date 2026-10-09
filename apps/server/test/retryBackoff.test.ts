// T1 proof (Req 3, 10): computeNextRetryAt's growing-then-flat backoff
// schedule — 5m, 10m, 20m, 40m, ... doubling every successive infra
// failure, capped at 24h so no combo/job ever waits unboundedly long no
// matter how many failures accumulate (per Assumption A2: retries
// themselves never stop, only the interval between them stops growing).
//
// Every expected delay below is a literal millisecond value worked out by
// hand from the plan's own schedule (5m=300,000ms doubling), not derived
// from BASE_RETRY_DELAY_MS/MAX_RETRY_DELAY_MS — so a mutation to either
// constant's value, or to the doubling/cap formula itself, changes the
// actual result away from a fixed expectation instead of moving both sides
// of the assertion together.
import { describe, expect, it } from 'vitest';

import { BASE_RETRY_DELAY_MS, computeNextRetryAt, MAX_RETRY_DELAY_MS } from '../src/retryBackoff.js';

describe('retryBackoff exported constants (T1, Req 3)', () => {
  it('BASE_RETRY_DELAY_MS is exactly 5 minutes in milliseconds', () => {
    expect(BASE_RETRY_DELAY_MS).toBe(300_000);
  });

  it('MAX_RETRY_DELAY_MS is exactly 24 hours in milliseconds', () => {
    expect(MAX_RETRY_DELAY_MS).toBe(86_400_000);
  });
});

describe('computeNextRetryAt schedule (T1, Req 3)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  // Hand-computed schedule: 300,000 * 2^(attemptCount-1), literal per step,
  // through attemptCount 9 (76,800,000ms = 21h20m, still under the 24h
  // cap) then attemptCount 10 (300,000 * 512 = 153,600,000ms, which DOES
  // exceed the cap) is where the flat 86,400,000ms ceiling first applies.
  const expectedDelayMs: ReadonlyArray<readonly [attemptCount: number, delayMs: number]> = [
    [1, 300_000], // 5m
    [2, 600_000], // 10m
    [3, 1_200_000], // 20m
    [4, 2_400_000], // 40m
    [5, 4_800_000], // 1h20m
    [6, 9_600_000], // 2h40m
    [7, 19_200_000], // 5h20m
    [8, 38_400_000], // 10h40m
    [9, 76_800_000], // 21h20m (last uncapped step)
    [10, 86_400_000], // 24h (cap first applies here)
  ];

  for (const [attemptCount, delayMs] of expectedDelayMs) {
    it(`attemptCount ${attemptCount} resolves to now + ${delayMs}ms`, () => {
      const result = computeNextRetryAt(attemptCount, now);
      expect(result.getTime()).toBe(now.getTime() + delayMs);
    });
  }

  it('attemptCount 11 stays flat at the 24h cap rather than continuing to double', () => {
    const result = computeNextRetryAt(11, now);
    expect(result.getTime()).toBe(now.getTime() + 86_400_000);
  });

  it('attemptCount 50 stays flat at the 24h cap', () => {
    const result = computeNextRetryAt(50, now);
    expect(result.getTime()).toBe(now.getTime() + 86_400_000);
  });

  it('a very large attemptCount (100,000) never throws and stays capped at exactly 24h', () => {
    expect(() => computeNextRetryAt(100_000, now)).not.toThrow();
    const result = computeNextRetryAt(100_000, now);
    expect(Number.isNaN(result.getTime())).toBe(false);
    expect(result.getTime()).toBe(now.getTime() + 86_400_000);
  });

  it('Number.MAX_SAFE_INTEGER attemptCount never throws and stays capped at exactly 24h', () => {
    expect(() => computeNextRetryAt(Number.MAX_SAFE_INTEGER, now)).not.toThrow();
    const result = computeNextRetryAt(Number.MAX_SAFE_INTEGER, now);
    expect(Number.isNaN(result.getTime())).toBe(false);
    expect(result.getTime()).toBe(now.getTime() + 86_400_000);
  });

  it('defaults `now` to the current time when the second argument is omitted', () => {
    const before = Date.now();
    const result = computeNextRetryAt(1);
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(result.getTime()).toBeLessThanOrEqual(after + 300_000);
  });
});
