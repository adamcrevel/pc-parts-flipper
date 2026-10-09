// Catalog-mode sourcing: when a part's brand is known but its model isn't,
// browses the manufacturer's site for several distinct products in that
// category and saves each one under its own brand+partNumber
// (ai-catalog-sourcing feature T3, Requirements 1-6, 8). Kept in its own
// file rather than inside referenceSourcingOrchestrator.ts, for the same
// ~200-line reason that file's own header already explains — adding this
// whole branch there directly would push it well past the convention.
//
// The shared per-identify-parts-call sourcing-attempt budget
// (MAX_SOURCING_ATTEMPTS_PER_CALL, Requirement 7) is NOT duplicated here:
// referenceSourcingOrchestrator.ts's createReferenceSourcer closure owns
// that counter and the hasCatalogSourcingBeenAttempted pre-check, exactly
// mirroring how it already owns both for single-product sourcing before
// ever calling that file's own private attemptSourcing helper — this file's
// sourceCatalogIfNeeded is that same kind of "perform one already-budgeted
// attempt" helper, just exported because it is non-trivial enough to need
// its own tests.
import { insertSourcedReferencePhoto, recordCatalogSourcingAttempt } from '../db/index.js';
import type { ComponentCategory, SourcingOutcome } from '../db/index.js';
import { logger } from '../logger.js';
import { buildCatalogSourcingPrompt } from './catalogSourcingPrompt.js';
import { parseCatalogSourcingResponse } from './catalogSourcingParser.js';
import { getOmpSourcingRunner } from './ompSourcingRunner.js';
import { runWithBrandLimit } from './sourcingConcurrencyLimiter.js';

/**
 * Catalog browsing needs more real browsing time than finding one already-
 * named product (single-product sourcing's DEFAULT_OMP_SOURCING_TIMEOUT_MS)
 * — a whole category page plus an unbounded number of product pages
 * (Requirement 8). This is the ONLY bound on how long one catalog call may
 * run — there is no separate cap on how many products it may report (user
 * steering, Cycle 0 log).
 */
export const DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS = 600_000;

/**
 * Runs one catalog-sourcing attempt end to end for `(category, brand)`:
 * browses the manufacturer's site for every distinct product it can find (no
 * cap), verifies and inserts each one that downloads as a real image
 * (Requirements 2-4, 6), and records the attempt so the caller's
 * already-attempted check (Requirement 5) finds it on every future call for
 * this combo. Resolves without throwing in every case — Requirement 3's "a
 * failed attempt is an expected outcome" rule from single-product sourcing
 * applies identically here: a timeout, spawn failure, or unparseable
 * response is logged at Info and recorded, never propagated to the caller.
 * Does NOT itself check whether this combo was already attempted or whether
 * budget remains — the caller owns both (see file header).
 *
 * The `omp` call runs inside runWithBrandLimit, so concurrent sourcing calls
 * for the same brand — from this path or the single-product one — do not hit
 * that manufacturer's site at once (sourcing-resilience Requirement 4).
 *
 * How the attempt is recorded is three-way (sourcing-resilience Requirements
 * 1-2), and that is what decides whether this brand may be browsed again:
 * - `infrastructure_blocked` — anything thrown (runner timeout/spawn failure/
 *   non-zero exit, or a parser rejection), OR a clean response the model
 *   itself marked `blocked` (rate limit, CAPTCHA, access denied). The site
 *   was never genuinely browsed, so the combo is retried later with backoff.
 * - `not_found` — a clean, completed browse that verified no product at all.
 *   Permanent: this combo is never attempted again.
 * - `succeeded` — at least one product downloaded and verified as a real image.
 *
 * A blocked response that still carried some candidates has them inserted
 * first and is STILL recorded `infrastructure_blocked`: the photos it did
 * manage to report are real and worth keeping now, and the rest of the
 * catalog is still worth retrying later.
 */
export async function sourceCatalogIfNeeded(category: ComponentCategory, brand: string): Promise<void> {
  let insertedCount = 0;
  // Deliberately pessimistic default: anything thrown below leaves the
  // outcome here, which is the retryable classification (Requirement 1) —
  // the clean paths all assign explicitly before the try block ends.
  let outcome: SourcingOutcome = 'infrastructure_blocked';
  try {
    const prompt = buildCatalogSourcingPrompt(category, brand);
    const rawStdout = await runWithBrandLimit(brand, () =>
      getOmpSourcingRunner()(prompt, { timeoutMs: DEFAULT_OMP_CATALOG_SOURCING_TIMEOUT_MS }),
    );
    const { candidates, blocked } = parseCatalogSourcingResponse(rawStdout);

    // Sequential, not Promise.all: each insert does a real network download,
    // so one at a time avoids hammering the manufacturer's site with many
    // simultaneous requests for one attempt, regardless of how many
    // candidates it reported.
    for (const candidate of candidates) {
      // insertSourcedReferencePhoto does its own download + real-image
      // verification and its own per-row dedup (Requirement 6); it reports
      // inserted:false rather than throwing for a bad URL or a duplicate.
      const { inserted } = await insertSourcedReferencePhoto(category, brand, candidate.partNumber, candidate.url);
      if (inserted) {
        insertedCount += 1;
      }
    }

    // `blocked` wins over the insert count: a browse the model was denied
    // never proved this brand has nothing more to offer. Without it, a
    // zero-insert blocked attempt would be mistaken for a genuine empty
    // catalog and foreclosed forever. Note a candidate whose download or
    // verification failed leaves this 'not_found', NOT blocked — our
    // infrastructure worked; the model's claimed URL simply did not pan out,
    // which is a model-content problem and would repeat on a retry.
    outcome = blocked ? 'infrastructure_blocked' : insertedCount > 0 ? 'succeeded' : 'not_found';
    logger.info(
      { category, brand, found: candidates.length, insertedCount, blocked },
      'Catalog sourcing attempt finished',
    );
  } catch (err) {
    // Info, not Error: Requirement 3's "a failed attempt is an expected
    // outcome" rule from single-product sourcing applies identically here.
    const message = err instanceof Error ? err.message : String(err);
    logger.info(
      { category, brand, message },
      'Catalog sourcing attempt failed; continuing without new reference photos',
    );
  }

  try {
    // Recorded on every outcome — the attempt record is what makes
    // Requirement 5's "never re-attempt the same combo" true for a genuine
    // not-found too, while an 'infrastructure_blocked' one is stamped with a
    // growing next_retry_at and becomes attemptable again later (T2).
    await recordCatalogSourcingAttempt(category, brand, outcome, insertedCount);
  } catch (err) {
    // A failure to write the bookkeeping row must not fail identify-parts
    // either; the worst case is one wasted re-attempt on a later request.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ category, brand, message }, 'Failed to record catalog sourcing attempt');
  }
}
