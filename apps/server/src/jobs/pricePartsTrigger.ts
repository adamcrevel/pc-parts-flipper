// The central cache-hit/miss decision of the part-price-estimation feature —
// nodes B through G of the feature's architecture diagram. Every write path
// that creates Expected Parts (the identify-parts worker pool, and the
// Listing create/update routes) hands its freshly-created rows here, and
// this module decides, per distinct (category, brand, partNumber) combo,
// which of three things happens:
//
//   B  a part is eligible at all — brand and partNumber both known, and no
//      estimated resale value of its own yet (a part the user already priced
//      is never touched, Req 14);
//   C  look the combo up in part_price_cache;
//   D  hit with a value present -> write that value straight onto every
//      matching auto-owned Expected Part now (no AI call, no job: this is
//      the whole point of the cache);
//   E  hit with the value still null -> do nothing. The row's existence
//      means some writer already took responsibility for researching this
//      combo, so a second job here would be a duplicate;
//   F  miss -> insert the cache row (race-safe: a concurrent writer may win,
//      in which case insertPriceCacheEntry reports inserted: false rather
//      than throwing);
//   G  then enqueue a price_parts_job, unless one is already queued or
//      pricing for this combo.
//
// The enqueue at G goes through the atomic createQueuedPriceJobIfAbsent in
// every path, not only when this writer won the insert race: the race
// winner may not have reached its own enqueue yet when the loser looks, so
// "I lost the insert" is not on its own evidence that a job exists.
// Checking (and inserting into) the job table as one atomic statement is
// what actually delivers Req 13's "never two duplicate jobs" — a separate
// SELECT-then-INSERT pair left a window where two concurrent first
// encounters of the same combo could both observe "no job yet" before
// either insert landed.
//
// Nothing here is awaited by a request handler: price research is a
// background queued job, never synchronous work inside the triggering
// request (Req 5).
import { logger } from '../logger.js';
import {
  createQueuedPriceJobIfAbsent,
  findPriceCacheEntry,
  insertPriceCacheEntry,
  propagateCachedPriceToExpectedParts,
  type ComponentCategory,
  type ExpectedPart,
} from '../db/index.js';

/** One distinct combo to resolve, after eligibility filtering and de-duplication. */
interface PriceCombo {
  category: ComponentCategory;
  brand: string;
  partNumber: string;
}

/**
 * Nodes C-G for one combo. Sequential by design: the cache read, the
 * insert and the job check are three statements, and running the same combo
 * through them twice concurrently is exactly the duplicate-job race the
 * gating exists to prevent — which is why callers de-duplicate first and
 * resolve combos one at a time.
 */
async function resolveCombo(combo: PriceCombo): Promise<void> {
  const { category, brand, partNumber } = combo;
  const cached = await findPriceCacheEntry(category, brand, partNumber);

  if (cached !== null) {
    // Node E: the combo is already known but unpriced — research is already
    // someone's responsibility, so there is nothing to start here.
    if (cached.estimatedResaleValue === null) {
      return;
    }
    // Node D: a researched value is already on hand. Writing it now is what
    // makes the second listing containing the same part priced instantly.
    await propagateCachedPriceToExpectedParts(category, brand, partNumber, cached.estimatedResaleValue);
    return;
  }

  // Node F. The `inserted` flag is deliberately not used to gate the
  // enqueue — see this file's header: losing the insert race says nothing
  // about whether the winner has enqueued its job yet.
  await insertPriceCacheEntry(category, brand, partNumber);

  // Node G: atomic enqueue-unless-already-non-terminal, closing the race
  // window a separate check-then-insert pair would leave open.
  await createQueuedPriceJobIfAbsent(category, brand, partNumber);
}

/**
 * Runs the cache-hit/miss decision for every Expected Part in `parts` that
 * is eligible for automatic pricing, enqueueing background research for the
 * combos that need it and applying already-cached values to the rest.
 *
 * Combos are de-duplicated first: one Listing can easily hold two rows of
 * the same part, and resolving the same combo twice would race against
 * itself over the cache row and the job queue.
 *
 * A failure on one combo is logged and skipped rather than thrown: this is
 * a best-effort background trigger hanging off a write that has already
 * succeeded, and failing it must not fail (or abort) the write — the same
 * per-item try/catch routes/listings.ts's promoteReferencesForExpectedParts
 * already uses for the same reason.
 */
export async function triggerPriceLookups(expectedParts: ExpectedPart[]): Promise<void> {
  const combos = new Map<string, PriceCombo>();
  for (const part of expectedParts) {
    // Node B: eligible only when fully identified (brand *and* partNumber —
    // a half-identified part cannot be researched, and neither is ever
    // guessed) and carrying no price of its own. A part that already has an
    // estimated resale value is left alone, whoever put it there.
    if (part.brand === null || part.partNumber === null || part.estimatedResaleValue !== null) {
      continue;
    }
    combos.set(`${part.componentCategory}\u0000${part.brand}\u0000${part.partNumber}`, {
      category: part.componentCategory,
      brand: part.brand,
      partNumber: part.partNumber,
    });
  }

  for (const combo of combos.values()) {
    try {
      await resolveCombo(combo);
    } catch (err) {
      logger.error({ err, ...combo }, 'Failed to trigger price lookup for part combo');
    }
  }
}
