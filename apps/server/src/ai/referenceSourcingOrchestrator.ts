// Decides whether one identified part needs a reference photo auto-sourced,
// and if so performs the whole attempt synchronously: tools-enabled omp call
// (ompSourcingRunner.ts), parse (imageSourcingParser.ts), verified download +
// insert (db/queries/referencePhotos.ts), and the attempt record that stops
// the same combo ever being tried twice (db/queries/sourcingAttempts.ts).
//
// Lives beside partIdentification.ts rather than inside it so that file stays
// near this project's ~200-line convention: identifyListingParts only has to
// call the sourcer once per eligible part, before looking that part's
// reference photos up, so a photo sourced here is visible to the very same
// call's second pass (Requirement 5).
//
// Requirement 3 governs every failure path below: a sourcing attempt that
// times out, cannot spawn `omp`, returns unparseable output, or returns a URL
// that fails verification is an EXPECTED outcome, not a bug — it is logged at
// Info, recorded as an attempt, and never propagated to the caller.
//
// sourcing-resilience T6 changes only HOW that attempt is recorded: instead of
// one binary succeeded/failed flag, each attempt is classified three ways
// (succeeded / not_found / infrastructure_blocked) so an infrastructure
// failure can be retried later with backoff while a genuine not-found stays
// permanent (Requirements 1-2). The `omp` call itself now also runs under the
// per-brand concurrency cap (sourcingConcurrencyLimiter.ts, Requirement 4).
import type { AiIdentifiedPart } from '@pc-parts-flipper/shared';
import {
  hasCatalogSourcingBeenAttempted,
  hasReferencePhotoForExactMatch,
  hasSourcingBeenAttempted,
  insertSourcedReferencePhoto,
  recordSourcingAttempt,
} from '../db/index.js';
import type { ComponentCategory, SourcingOutcome } from '../db/index.js';
import { logger } from '../logger.js';
import { sourceCatalogIfNeeded } from './catalogSourcingOrchestrator.js';
import { buildImageSourcingPrompt } from './imageSourcingPrompt.js';
import { parseImageSourcingResponse } from './imageSourcingParser.js';
import { DEFAULT_OMP_SOURCING_TIMEOUT_MS, getOmpSourcingRunner } from './ompSourcingRunner.js';
import { runWithBrandLimit } from './sourcingConcurrencyLimiter.js';

/**
 * Hard ceiling on tools-enabled sourcing calls one identify-parts request may
 * trigger (Requirement 7). Each call is allowed up to
 * DEFAULT_OMP_SOURCING_TIMEOUT_MS (5 minutes) of browsing, and they run one
 * after another, so this is what bounds the request's worst-case wall time —
 * 3 keeps that ceiling at ~15 minutes while still covering the common case of
 * a listing with a couple of newly-identified parts.
 */
export const MAX_SOURCING_ATTEMPTS_PER_CALL = 3;

/**
 * The part fields sourcing actually reads — a structural subset of the
 * identified-part shape identifyListingParts already holds, so callers pass
 * their existing object straight through with no mapping step.
 */
export type SourceablePart = Pick<AiIdentifiedPart, 'category' | 'brand' | 'partNumber'>;

/** Call-scoped sourcer: attempts (at most) one sourcing call for one part. */
export type ReferenceSourcer = (part: SourceablePart) => Promise<void>;

/**
 * Runs one sourcing attempt end to end and classifies how it ended, for the
 * attempt record the caller writes. Resolves — never throws — for every
 * failure mode, exactly as before (Requirement 3).
 *
 * The classification (sourcing-resilience Requirements 1-2) is what decides
 * whether this combo may ever be attempted again:
 * - `infrastructure_blocked` — the runner timed out, could not spawn `omp`,
 *   exited non-zero, or returned output `parseImageSourcingResponse` rejected
 *   (all thrown), OR the model itself reported `blocked: true` (rate limit,
 *   CAPTCHA, access denied). The model never got a real chance to search, so
 *   the combo is retried later with exponential backoff.
 * - `not_found` — a clean, completed search that genuinely found nothing.
 *   Permanent: this combo is never attempted again.
 * - `succeeded` — a clean answer whose URL downloaded and verified as a real
 *   image, so a photo is now in the library.
 *
 * The `omp` call runs inside runWithBrandLimit so concurrent attempts for the
 * same brand do not hit that manufacturer's site at once (Requirement 4).
 */
async function attemptSourcing(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<SourcingOutcome> {
  try {
    const prompt = buildImageSourcingPrompt(category, brand, partNumber);
    const rawStdout = await runWithBrandLimit(brand, () =>
      getOmpSourcingRunner()(prompt, { timeoutMs: DEFAULT_OMP_SOURCING_TIMEOUT_MS }),
    );
    const result = parseImageSourcingResponse(rawStdout);

    // Checked before `found`: a blocked model never completed a real search,
    // so whatever it reported is not a genuine not-found (Requirement 1).
    if (result.blocked) {
      logger.info(
        { category, brand, partNumber },
        'Reference photo sourcing was blocked (rate limit/CAPTCHA/access denied); will be retried after backoff',
      );
      return 'infrastructure_blocked';
    }

    // parseImageSourcingResponse already coerces a malformed url to
    // found:false, so a non-null url here is the only case worth downloading.
    if (!result.found || result.url === null) {
      logger.info({ category, brand, partNumber }, 'Reference photo sourcing found no manufacturer photo');
      return 'not_found';
    }

    // insertSourcedReferencePhoto does its own download + real-image
    // verification and reports inserted:false rather than throwing for a bad URL.
    const { inserted } = await insertSourcedReferencePhoto(category, brand, partNumber, result.url);
    logger.info({ category, brand, partNumber, url: result.url, inserted }, 'Reference photo sourcing attempt finished');

    // Deliberate edge case, not an oversight: a found:true answer whose URL
    // fails to download or verify is classified 'not_found', NOT
    // 'infrastructure_blocked'. Our infrastructure worked fine — the model's
    // claimed URL simply did not pan out, which is a model-content problem,
    // and retrying the identical search would only produce the same bad URL.
    return inserted ? 'succeeded' : 'not_found';
  } catch (err) {
    // Info, not Error: Requirement 3 makes a failed sourcing attempt an
    // expected outcome of an on-demand best-effort call, not a server fault.
    // Every throw reaching here — runner spawn/timeout/non-zero exit, or a
    // parser rejection — is an infrastructure failure worth retrying.
    const message = err instanceof Error ? err.message : String(err);
    logger.info({ category, brand, partNumber, message }, 'Reference photo sourcing attempt failed; continuing without a sourced photo');
    return 'infrastructure_blocked';
  }
}

/**
 * Builds a sourcer whose Requirement 7 attempt budget is private to this one
 * identifyListingParts invocation. The counter lives in this closure rather
 * than at module scope deliberately: two concurrent identify-parts requests
 * must each get their own full budget, which a module-level counter would
 * silently share (and never reset).
 *
 * The returned function sources a reference photo for `part` in one of two
 * mutually-exclusive ways (Requirement 1): when brand AND partNumber are both
 * known, it single-product-sources that exact product (unchanged from
 * ai-reference-autosourcing) when no photo and no prior attempt exists for
 * it; when only brand is known (partNumber null), it instead catalog-sources
 * several of that brand's products in the category, via
 * catalogSourcingOrchestrator.ts, when no catalog attempt has ever been
 * recorded for that (category, brand) combo (Requirement 5). A part with no
 * brand at all triggers neither — there is nothing to search the
 * manufacturer's site for. Both paths draw from the same Requirement 7
 * budget below, so a listing with several not-yet-sourceable parts cannot
 * chain unbounded calls of either kind. It resolves without throwing in
 * every case.
 */
export function createReferenceSourcer(): ReferenceSourcer {
  let attemptsUsed = 0;

  return async function sourceMissingReferenceIfNeeded(part: SourceablePart): Promise<void> {
    const { category, brand, partNumber } = part;

    // Neither sourcing mode can search without at least a brand name.
    if (brand === null) {
      return;
    }

    if (partNumber === null) {
      // Requirement 1: brand known, model not — catalog-mode sourcing
      // browses the brand's whole category catalog instead of one named
      // product (catalogSourcingOrchestrator.ts).
      if (await hasCatalogSourcingBeenAttempted(category, brand)) {
        logger.info({ category, brand }, 'Catalog sourcing already attempted for this brand, skipping');
        return;
      }

      // Requirement 7: budget is spent for this identify-parts call.
      if (attemptsUsed >= MAX_SOURCING_ATTEMPTS_PER_CALL) {
        logger.info(
          { category, brand, maxAttempts: MAX_SOURCING_ATTEMPTS_PER_CALL },
          'Reference photo sourcing attempt cap reached for this identification call, skipping',
        );
        return;
      }

      // Counted before the call, so a throwing attempt still consumes
      // budget — same rule the single-product path below follows.
      attemptsUsed += 1;
      logger.info({ category, brand, attemptsUsed }, 'Starting catalog sourcing attempt');
      await sourceCatalogIfNeeded(category, brand);
      return;
    }

    // Already in the library for this exact product: nothing is missing.
    if (await hasReferencePhotoForExactMatch(category, brand, partNumber)) {
      return;
    }

    // Requirement 6: one attempt per combo, ever — a previous failure is not
    // retried, so a permanently unfindable part cannot cost a call every time.
    if (await hasSourcingBeenAttempted(category, brand, partNumber)) {
      logger.info({ category, brand, partNumber }, 'Reference photo sourcing already attempted for this part, skipping');
      return;
    }

    // Requirement 7: budget is spent for this identify-parts call.
    if (attemptsUsed >= MAX_SOURCING_ATTEMPTS_PER_CALL) {
      logger.info(
        { category, brand, partNumber, maxAttempts: MAX_SOURCING_ATTEMPTS_PER_CALL },
        'Reference photo sourcing attempt cap reached for this identification call, skipping',
      );
      return;
    }

    // Counted before the call, so a throwing attempt still consumes budget.
    attemptsUsed += 1;
    logger.info({ category, brand, partNumber, attemptsUsed }, 'Starting reference photo sourcing attempt');

    const outcome = await attemptSourcing(category, brand, partNumber);

    try {
      // Recorded on every outcome — the attempt record is what makes
      // Requirement 6's "never re-attempt the same combo" true for a genuine
      // not-found too. An 'infrastructure_blocked' outcome is the one kind
      // that stays retryable: recordSourcingAttempt stamps it with a growing
      // next_retry_at instead of foreclosing the combo forever (T2).
      await recordSourcingAttempt(category, brand, partNumber, outcome);
    } catch (err) {
      // A failure to write the bookkeeping row must not fail identify-parts
      // either; the worst case is one wasted re-attempt on a later request.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ category, brand, partNumber, message }, 'Failed to record reference photo sourcing attempt');
    }
  };
}
