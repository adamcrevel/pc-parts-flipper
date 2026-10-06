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
// Info, recorded as a failed attempt, and never propagated to the caller.
import type { AiIdentifiedPart } from '@pc-parts-flipper/shared';
import {
  hasReferencePhotoForExactMatch,
  hasSourcingBeenAttempted,
  insertSourcedReferencePhoto,
  recordSourcingAttempt,
} from '../db/index.js';
import type { ComponentCategory } from '../db/index.js';
import { logger } from '../logger.js';
import { buildImageSourcingPrompt } from './imageSourcingPrompt.js';
import { parseImageSourcingResponse } from './imageSourcingParser.js';
import { DEFAULT_OMP_SOURCING_TIMEOUT_MS, getOmpSourcingRunner } from './ompSourcingRunner.js';

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
 * Runs one sourcing attempt end to end and reports whether a verified photo
 * was actually added to the library. Resolves false — never throws — for
 * every failure mode: runner timeout/ENOENT/non-zero exit, a structurally
 * unparseable response, a "not found" answer, or a URL whose download or
 * real-image verification fails inside insertSourcedReferencePhoto.
 */
async function attemptSourcing(
  category: ComponentCategory,
  brand: string,
  partNumber: string,
): Promise<boolean> {
  try {
    const prompt = buildImageSourcingPrompt(category, brand, partNumber);
    const rawStdout = await getOmpSourcingRunner()(prompt, { timeoutMs: DEFAULT_OMP_SOURCING_TIMEOUT_MS });
    const result = parseImageSourcingResponse(rawStdout);

    // parseImageSourcingResponse already coerces a malformed url to
    // found:false, so a non-null url here is the only case worth downloading.
    if (!result.found || result.url === null) {
      logger.info({ category, brand, partNumber }, 'Reference photo sourcing found no manufacturer photo');
      return false;
    }

    // insertSourcedReferencePhoto does its own download + real-image
    // verification and reports inserted:false rather than throwing for a bad URL.
    const { inserted } = await insertSourcedReferencePhoto(category, brand, partNumber, result.url);
    logger.info({ category, brand, partNumber, url: result.url, inserted }, 'Reference photo sourcing attempt finished');
    return inserted;
  } catch (err) {
    // Info, not Error: Requirement 3 makes a failed sourcing attempt an
    // expected outcome of an on-demand best-effort call, not a server fault.
    const message = err instanceof Error ? err.message : String(err);
    logger.info({ category, brand, partNumber, message }, 'Reference photo sourcing attempt failed; continuing without a sourced photo');
    return false;
  }
}

/**
 * Builds a sourcer whose Requirement 7 attempt budget is private to this one
 * identifyListingParts invocation. The counter lives in this closure rather
 * than at module scope deliberately: two concurrent identify-parts requests
 * must each get their own full budget, which a module-level counter would
 * silently share (and never reset).
 *
 * The returned function sources a reference photo for `part` only when all of
 * these hold: the part's own brand AND partNumber are both known
 * (Requirement 1 — a brand-only part is not specific enough to search for),
 * no part_reference_photos row exists for that exact combo already, no
 * sourcing attempt has ever been recorded for it (Requirement 6), and this
 * call's budget is not yet spent. It resolves without throwing in every case.
 */
export function createReferenceSourcer(): ReferenceSourcer {
  let attemptsUsed = 0;

  return async function sourceMissingReferenceIfNeeded(part: SourceablePart): Promise<void> {
    const { category, brand, partNumber } = part;

    // Requirement 1: only an exact product (brand AND part number) is
    // specific enough to search the manufacturer's site for.
    if (brand === null || partNumber === null) {
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

    const inserted = await attemptSourcing(category, brand, partNumber);

    try {
      // Recorded regardless of outcome — the attempt record is what makes
      // Requirement 6's "never re-attempt the same combo" true for failures too.
      await recordSourcingAttempt(category, brand, partNumber, inserted);
    } catch (err) {
      // A failure to write the bookkeeping row must not fail identify-parts
      // either; the worst case is one wasted re-attempt on a later request.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ category, brand, partNumber, message }, 'Failed to record reference photo sourcing attempt');
    }
  };
}
