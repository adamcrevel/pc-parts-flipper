// Unit proof for computeNextRetryAt (sourcing-resilience feature, Req 3).
// Pure function, no DB/HTTP round trip needed — follows the direct
// describe/it/expect convention already used for a pure helper elsewhere in
// this codebase (packages/shared/src/partIdentity.test.ts).
import { describe, expect, it } from 'vitest';
import { BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS, computeNextRetryAt } from '../src/retryBackoff.js';

describe('computeNextRetryAt', () => {
  it('adds exactly BASE_RETRY_DELAY_MS for the first failure (attemptCount=1)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const result = computeNextRetryAt(1, now);

    // attemptCount=1 is the base case: 2^(1-1) = 1, so the delay is exactly
    // BASE_RETRY_DELAY_MS (5 minutes), not doubled or left at zero.
    expect(result.getTime()).toBe(now.getTime() + BASE_RETRY_DELAY_MS);
    expect(result.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });

  it('doubles the delay with each successive attemptCount, before the cap', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    // 5m, 10m, 20m, 40m — each step exactly double the last, proving the
    // exponent grows with attemptCount rather than staying flat or linear.
    expect(computeNextRetryAt(1, now).getTime() - now.getTime()).toBe(BASE_RETRY_DELAY_MS);
    expect(computeNextRetryAt(2, now).getTime() - now.getTime()).toBe(BASE_RETRY_DELAY_MS * 2);
    expect(computeNextRetryAt(3, now).getTime() - now.getTime()).toBe(BASE_RETRY_DELAY_MS * 4);
    expect(computeNextRetryAt(4, now).getTime() - now.getTime()).toBe(BASE_RETRY_DELAY_MS * 8);
  });

  it('caps the delay at MAX_RETRY_DELAY_MS once the exponential growth exceeds it', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    // BASE_RETRY_DELAY_MS * 2^8 = 300_000 * 256 = 76_800_000ms (~21.3h),
    // still under the 24h cap — attemptCount=9's exponent is (9-1)=8, the
    // largest attemptCount whose uncapped value still lands below the cap,
    // chosen to prove growth is genuinely exponential right up to the edge.
    const justBelowCap = computeNextRetryAt(9, now).getTime() - now.getTime();
    expect(justBelowCap).toBe(BASE_RETRY_DELAY_MS * 2 ** 8);
    expect(justBelowCap).toBeLessThan(MAX_RETRY_DELAY_MS);

    // attemptCount=10 would uncapped compute to 300_000 * 2^9 = 153_600_000ms
    // (~42.7h), well past the 24h ceiling — the cap must clamp it down to
    // exactly MAX_RETRY_DELAY_MS, not let it grow past.
    const atCap = computeNextRetryAt(10, now).getTime() - now.getTime();
    expect(atCap).toBe(MAX_RETRY_DELAY_MS);

    // A much larger attemptCount (no retry-count cap exists per Req 3/A2)
    // must still clamp to the same ceiling, never grow further or overflow.
    const wayPastCap = computeNextRetryAt(50, now).getTime() - now.getTime();
    expect(wayPastCap).toBe(MAX_RETRY_DELAY_MS);
  });

  it('defaults `now` to the current time when omitted', () => {
    const before = Date.now();

    const result = computeNextRetryAt(1);

    const after = Date.now();
    // Result must fall within [before + base, after + base] — proves the
    // default parameter is a live `new Date()` call, not some fixed/zero
    // value baked into the function.
    expect(result.getTime()).toBeGreaterThanOrEqual(before + BASE_RETRY_DELAY_MS);
    expect(result.getTime()).toBeLessThanOrEqual(after + BASE_RETRY_DELAY_MS);
  });
});
