// Typed CRUD for the `part_reference_sourcing_attempts` table
// (ai-reference-autosourcing feature T1, extended by sourcing-resilience T2).
// Records the latest attempt to auto-source a reference photo for one
// (category, brand, partNumber) combo, so identify-parts' second pass never
// re-attempts a combo it has already genuinely settled.
//
// "Settled" is now outcome-aware (sourcing-resilience Requirements 1-3): a
// clean `succeeded` or `not_found` attempt is permanent exactly as before —
// its `next_retry_at` stays NULL forever and the combo is never re-attempted.
// An `infrastructure_blocked` attempt (the omp call threw/timed out, or the
// model itself reported it was rate-limited/CAPTCHA'd) is NOT a genuine
// "searched and found nothing" signal, so it stores an exponentially growing
// `next_retry_at` (retryBackoff.ts) and the combo becomes attemptable again
// the moment that window reopens, with no cap on how many times that can
// happen (Assumption A2).
//
// Writes are a plain SELECT-then-INSERT-or-UPDATE in application code rather
// than a single `INSERT ... ON CONFLICT DO UPDATE` upsert, and every
// timestamp written is computed once here as a JS `Date` and bound as a
// parameter — never SQL `current_timestamp` inside a conflict-handling write
// (Requirement 10 / Assumption A5: duckdb/duckdb#14404). The narrow race this
// reintroduces (two concurrent calls for the identical combo both SELECTing
// before either writes) is the same benign one this module has always
// tolerated: the unique index on (category, brand, part_number) turns the
// loser's INSERT into a caught, logged, skipped no-op rather than a second row.
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { logger } from '../../logger.js';
import { computeNextRetryAt } from '../../retryBackoff.js';
import type { ComponentCategory } from '../types.js';

// Same pattern as referencePhotos.ts's UNIQUE_CONSTRAINT_MESSAGE: matches the
// DuckDB error text raised when the unique index on
// (category, brand, part_number) is violated by a second attempt row.
const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

// Every timestamp this module writes is bound as an ISO-8601 instant string
// wrapped in `CAST(CAST($x AS TIMESTAMPTZ) AS TIMESTAMP)`. DuckDB's
// `current_timestamp` is a TIMESTAMPTZ and these tables' TIMESTAMP columns
// hold its *local-naive* rendering (that is what every existing
// `DEFAULT current_timestamp` row contains). A JS `Date` cannot be bound
// directly (@duckdb/node-api has no Date binding), and binding a bare
// `toISOString()` string straight into a TIMESTAMP column would store the UTC
// wall clock, which `next_retry_at > current_timestamp` would then misread by
// the local UTC offset. The double cast reproduces exactly what
// `DEFAULT current_timestamp` stores, so both the stored value and the
// comparison stay correct in any timezone.

/**
 * How a sourcing attempt ended, as classified by the orchestrator:
 * - `succeeded` — a real reference photo was found, downloaded and stored.
 * - `not_found` — a clean, completed search that genuinely turned up nothing
 *   usable (including a model-claimed URL that did not pan out). Permanent:
 *   never retried.
 * - `infrastructure_blocked` — the search never really happened (thrown error,
 *   timeout, non-zero exit, or a model response explicitly reporting a rate
 *   limit / CAPTCHA / access denial). Retried later with exponential backoff.
 */
export type SourcingOutcome = 'succeeded' | 'not_found' | 'infrastructure_blocked';

/**
 * Reports whether this exact (category, brand, partNumber) combo is currently
 * settled — i.e. whether a caller should skip re-attempting it.
 *
 * True for a combo whose recorded attempt was permanent (`succeeded` or
 * `not_found`, `next_retry_at` NULL), and for an infrastructure-blocked combo
 * whose backoff window has not reopened yet. False once that window has
 * passed, which is what lets a rate-limited/CAPTCHA'd combo be tried again
 * (Requirement 1) while a genuine not-found stays permanently skipped
 * (Requirement 2).
 */
export async function hasSourcingBeenAttempted(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM part_reference_sourcing_attempts
     WHERE category = $category AND brand = $brand AND part_number = $part_number
       AND (next_retry_at IS NULL OR next_retry_at > current_timestamp)`,
    { category, brand, part_number: partNumber },
  );
  return reader.getRowObjectsJson().length > 0;
}

/**
 * Records one sourcing attempt for a (category, brand, partNumber) combo,
 * classified by `outcome`.
 *
 * Flow: read the combo's accumulated `attempt_count` (absent row = 0), add
 * this attempt to it, and — only for `infrastructure_blocked` — compute the
 * next retry instant from that 1-indexed count via `computeNextRetryAt`, so
 * each successive infra failure for the same combo waits longer (5m, 10m,
 * 20m, ... capped at 24h). A `succeeded`/`not_found` outcome stores a NULL
 * `next_retry_at`, which is what permanently forecloses future attempts.
 * The row is then inserted (first attempt ever) or updated in place (a retry),
 * with `attempted_at` and `next_retry_at` both bound as parameters computed
 * from one single `new Date()` instant.
 *
 * A concurrent duplicate INSERT for the identical combo loses to the unique
 * index on (category, brand, part_number); that violation is caught, logged
 * and treated as "already recorded, skip" rather than thrown (same pattern as
 * referencePhotos.ts's insertReferencePhotoRow). Logs at Info on every branch.
 */
export async function recordSourcingAttempt(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
  outcome: SourcingOutcome,
): Promise<void> {
  const connection = await getConnection();
  const existingReader = await connection.runAndReadAll(
    `SELECT attempt_count FROM part_reference_sourcing_attempts
     WHERE category = $category AND brand = $brand AND part_number = $part_number`,
    { category, brand, part_number: partNumber },
  );
  const existingRows = existingReader.getRowObjectsJson();
  const priorAttemptCount = existingRows.length > 0 ? Number(existingRows[0].attempt_count ?? 0) : 0;
  const attemptCount = priorAttemptCount + 1;

  // One instant for the whole write: `attempted_at` and the backoff window it
  // anchors can never disagree, however slow the statements below are.
  const now = new Date();
  const nextRetryAt = outcome === 'infrastructure_blocked' ? computeNextRetryAt(attemptCount, now) : null;
  const values = {
    category,
    brand,
    part_number: partNumber,
    succeeded: outcome === 'succeeded',
    blocked: outcome === 'infrastructure_blocked',
    attempt_count: attemptCount,
    next_retry_at: nextRetryAt === null ? null : nextRetryAt.toISOString(),
    attempted_at: now.toISOString(),
  };

  if (existingRows.length > 0) {
    await connection.runAndReadAll(
      `UPDATE part_reference_sourcing_attempts
          SET succeeded = $succeeded,
              blocked = $blocked,
              attempt_count = $attempt_count,
              next_retry_at = CAST(CAST($next_retry_at AS TIMESTAMPTZ) AS TIMESTAMP),
              attempted_at = CAST(CAST($attempted_at AS TIMESTAMPTZ) AS TIMESTAMP)
        WHERE category = $category AND brand = $brand AND part_number = $part_number`,
      values,
    );
    logger.info(
      { category, brand, partNumber, outcome, attemptCount, nextRetryAt },
      'Updated reference photo sourcing attempt after retry',
    );
    return;
  }

  try {
    await connection.runAndReadAll(
      `INSERT INTO part_reference_sourcing_attempts
         (id, category, brand, part_number, attempted_at, succeeded, blocked, attempt_count, next_retry_at)
       VALUES
         ($id, $category, $brand, $part_number, CAST(CAST($attempted_at AS TIMESTAMPTZ) AS TIMESTAMP),
          $succeeded, $blocked, $attempt_count, CAST(CAST($next_retry_at AS TIMESTAMPTZ) AS TIMESTAMP))`,
      { id: newId(), ...values },
    );
    logger.info(
      { category, brand, partNumber, outcome, attemptCount, nextRetryAt },
      'Recorded reference photo sourcing attempt',
    );
  } catch (err) {
    // A racing-concurrent call for the identical combo inserted first and hit
    // the unique index: already recorded, nothing to do.
    if (err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message)) {
      logger.info(
        { category, brand, partNumber },
        'Reference photo sourcing attempt already recorded, skipping',
      );
      return;
    }
    throw err;
  }
}
