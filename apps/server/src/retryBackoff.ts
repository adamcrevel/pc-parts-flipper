// Shared exponential-backoff schedule for every infrastructure-failure retry
// this feature adds — sourcing-attempt level (part_reference_sourcing_attempts,
// part_catalog_sourcing_attempts) and job level (identify_parts_jobs,
// price_parts_jobs). One helper, reused everywhere a "when can this be tried
// again" timestamp is computed, so the growing/self-limiting schedule can
// never drift between call sites.
//
// Per the plan (Req 3, A2): there is deliberately no cap on the number of
// retries — an infrastructure failure alone can never prove a combo/job is
// permanently unfindable/unprocessable, so the interval between attempts
// keeps growing, capped at MAX_RETRY_DELAY_MS, rather than the attempts
// themselves ever stopping.

/** Base delay for the first retry: 5 minutes. */
export const BASE_RETRY_DELAY_MS = 300_000;

/** Ceiling the exponential growth never exceeds: 24 hours. */
export const MAX_RETRY_DELAY_MS = 86_400_000;

/**
 * Computes the timestamp at which the next retry attempt is allowed, given
 * how many infrastructure failures this combo/job has now accumulated.
 *
 * `attemptCount` is the 1-indexed count of *this* failure — the first infra
 * failure for a combo/job passes 1, the second passes 2, and so on; it is
 * never 0. The delay grows exponentially with each successive failure
 * (`BASE_RETRY_DELAY_MS * 2^(attemptCount-1)`), capped at
 * `MAX_RETRY_DELAY_MS` so it never waits unboundedly long no matter how many
 * failures accumulate: 5m, 10m, 20m, 40m, ... up to 24h, then flat.
 *
 * Pure function: `now` defaults to `new Date()` but the caller may pass a
 * fixed instant (as every write site in this feature does, per Assumption
 * A5 — a timestamp computed once in application code and bound as a
 * parameter, never left to a second, possibly-skewed `current_timestamp`
 * evaluation inside the same multi-step write).
 */
export function computeNextRetryAt(attemptCount: number, now: Date = new Date()): Date {
  const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attemptCount - 1), MAX_RETRY_DELAY_MS);
  return new Date(now.getTime() + delayMs);
}
