// Typed CRUD for the `part_catalog_sourcing_attempts` table
// (ai-catalog-sourcing feature T1, extended by sourcing-resilience T2).
// Records the latest catalog-mode sourcing attempt for one (category, brand)
// combo, so identify-parts' second pass never re-browses a brand's catalog it
// has already genuinely settled. Deliberately separate from
// sourcingAttempts.ts's (category, brand, part_number)-keyed table: that one
// records a single-product attempt for an already-known model; this one
// records a whole-catalog attempt for a brand whose model isn't known yet —
// the two never overlap (Requirement 1 is mutually exclusive by construction)
// and so never share a cache.
//
// "Settled" is outcome-aware (sourcing-resilience Requirements 1-3), exactly
// as in sourcingAttempts.ts: a clean `succeeded` or `not_found` attempt stays
// permanent with a NULL `next_retry_at`, while an `infrastructure_blocked`
// one (the omp call threw/timed out, or the model reported a rate limit /
// CAPTCHA / access denial) stores an exponentially growing `next_retry_at`
// (retryBackoff.ts) and becomes attemptable again once that window reopens,
// with no cap on how many times that can happen (Assumption A2).
//
// Writes are a plain SELECT-then-INSERT-or-UPDATE with every timestamp
// computed once here and bound as a parameter — never SQL `current_timestamp`
// inside a conflict-handling write (Requirement 10 / Assumption A5:
// duckdb/duckdb#14404). The narrow race that reintroduces is covered, as
// before, by the unique index on (category, brand): the loser's INSERT is a
// caught, logged, skipped no-op rather than a second row.
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { logger } from '../../logger.js';
import { computeNextRetryAt } from '../../retryBackoff.js';
import type { ComponentCategory } from '../types.js';
import type { SourcingOutcome } from './sourcingAttempts.js';

// Same pattern as sourcingAttempts.ts's UNIQUE_CONSTRAINT_MESSAGE: matches
// the DuckDB error text raised when the unique index on (category, brand) is
// violated by a second attempt row for the same combo.
const UNIQUE_CONSTRAINT_MESSAGE = /constraint error.*violates unique constraint/i;

// Timestamps are bound as ISO-8601 instant strings wrapped in
// `CAST(CAST($x AS TIMESTAMPTZ) AS TIMESTAMP)`, for the same reason spelled
// out in full in sourcingAttempts.ts: DuckDB's `current_timestamp` is a
// TIMESTAMPTZ whose local-naive rendering is what these TIMESTAMP columns
// hold, so binding a bare UTC `toISOString()` would skew every
// `next_retry_at > current_timestamp` comparison by the local UTC offset.

/**
 * Reports whether this exact (category, brand) combo is currently settled —
 * i.e. whether a caller should skip re-browsing that brand's catalog.
 *
 * True for a combo whose recorded attempt was permanent (`succeeded` or
 * `not_found`, `next_retry_at` NULL), and for an infrastructure-blocked combo
 * whose backoff window has not reopened yet. False once that window has
 * passed, which is what lets a rate-limited/CAPTCHA'd brand be tried again
 * (Requirement 1) while a genuinely empty catalog stays permanently skipped
 * (Requirement 2).
 */
export async function hasCatalogSourcingBeenAttempted(category: ComponentCategory, brand: string): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT 1 FROM part_catalog_sourcing_attempts
     WHERE category = $category AND brand = $brand
       AND (next_retry_at IS NULL OR next_retry_at > current_timestamp)`,
    { category, brand },
  );
  return reader.getRowObjectsJson().length > 0;
}

/**
 * Records one catalog-sourcing attempt for a (category, brand) combo,
 * classified by `outcome` and carrying how many products were found and
 * verified (0 for a blocked or empty catalog).
 *
 * Flow: read the combo's accumulated `attempt_count` (absent row = 0), add
 * this attempt to it, and — only for `infrastructure_blocked` — compute the
 * next retry instant from that 1-indexed count via `computeNextRetryAt`, so
 * each successive infra failure for the same brand waits longer (5m, 10m,
 * 20m, ... capped at 24h). A `succeeded`/`not_found` outcome stores a NULL
 * `next_retry_at`, which is what permanently forecloses future attempts. The
 * row is then inserted (first attempt ever) or updated in place (a retry),
 * with `attempted_at` and `next_retry_at` both bound as parameters computed
 * from one single `new Date()` instant.
 *
 * A concurrent duplicate INSERT for the identical combo loses to the unique
 * index on (category, brand); that violation is caught, logged and treated as
 * "already recorded, skip" rather than thrown — same pattern as
 * sourcingAttempts.ts's recordSourcingAttempt. Logs at Info on every branch.
 */
export async function recordCatalogSourcingAttempt(
  category: ComponentCategory,
  brand: string,
  outcome: SourcingOutcome,
  productsFound: number,
): Promise<void> {
  const connection = await getConnection();
  const existingReader = await connection.runAndReadAll(
    `SELECT attempt_count FROM part_catalog_sourcing_attempts
     WHERE category = $category AND brand = $brand`,
    { category, brand },
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
    succeeded: outcome === 'succeeded',
    blocked: outcome === 'infrastructure_blocked',
    products_found: productsFound,
    attempt_count: attemptCount,
    next_retry_at: nextRetryAt === null ? null : nextRetryAt.toISOString(),
    attempted_at: now.toISOString(),
  };

  if (existingRows.length > 0) {
    await connection.runAndReadAll(
      `UPDATE part_catalog_sourcing_attempts
          SET succeeded = $succeeded,
              blocked = $blocked,
              products_found = $products_found,
              attempt_count = $attempt_count,
              next_retry_at = CAST(CAST($next_retry_at AS TIMESTAMPTZ) AS TIMESTAMP),
              attempted_at = CAST(CAST($attempted_at AS TIMESTAMPTZ) AS TIMESTAMP)
        WHERE category = $category AND brand = $brand`,
      values,
    );
    logger.info(
      { category, brand, outcome, productsFound, attemptCount, nextRetryAt },
      'Updated catalog sourcing attempt after retry',
    );
    return;
  }

  try {
    await connection.runAndReadAll(
      `INSERT INTO part_catalog_sourcing_attempts
         (id, category, brand, attempted_at, succeeded, blocked, products_found, attempt_count, next_retry_at)
       VALUES
         ($id, $category, $brand, CAST(CAST($attempted_at AS TIMESTAMPTZ) AS TIMESTAMP),
          $succeeded, $blocked, $products_found, $attempt_count,
          CAST(CAST($next_retry_at AS TIMESTAMPTZ) AS TIMESTAMP))`,
      { id: newId(), ...values },
    );
    logger.info(
      { category, brand, outcome, productsFound, attemptCount, nextRetryAt },
      'Recorded catalog sourcing attempt',
    );
  } catch (err) {
    // A racing-concurrent call for the identical combo inserted first and hit
    // the unique index: already recorded, nothing to do.
    if (err instanceof Error && UNIQUE_CONSTRAINT_MESSAGE.test(err.message)) {
      logger.info({ category, brand }, 'Catalog sourcing attempt already recorded, skipping');
      return;
    }
    throw err;
  }
}
