// T5: Per-brand concurrency cap for AI sourcing calls (Req 4). The two
// live-observed failure modes this feature addresses (HTTP 429 on
// crucial.com, a bot-detection CAPTCHA on zotac.com) both happened when
// multiple identify-parts jobs for the same brand ran their sourcing calls
// concurrently and hit the same manufacturer's site at once. This module
// provides a pure, in-process counting semaphore keyed per brand so no more
// than SOURCING_PER_BRAND_CONCURRENCY sourcing calls for the same brand run
// at the same time — overall identify-parts pool concurrency
// (IDENTIFY_PARTS_POOL_SIZE) is untouched; this only throttles sourcing
// calls, and only within a shared brand.
//
// Has no DB/network dependency of its own, so it is fully unit-testable
// with fake async functions and manually controlled resolution order.

/**
 * Maximum number of concurrent sourcing calls permitted per brand, parsed
 * from SOURCING_PER_BRAND_CONCURRENCY. Same defensive-parsing rule as
 * identifyPartsWorkerPool.ts's own parsePoolSize: a missing, empty, or
 * non-numeric value falls back to the default of 1 (`Number(raw ?? 1)`
 * alone only catches a strictly-nullish env var — an empty string parses to
 * 0 and a non-numeric string parses to NaN). Unlike pool size, 0 is a valid
 * value in parsePoolSize's own convention and is kept valid here too for
 * consistency — but note the hazard is different: a worker pool with
 * POOL_SIZE 0 simply never claims a job (jobs sit queued, harmlessly), while
 * a brand limit of 0 would mean `active < 0` is never true for any waiter,
 * so every sourcing call for every brand would wait forever and the whole
 * sourcing pipeline would deadlock. This is a real footgun of the 0-is-valid
 * convention reused here verbatim; it is documented rather than
 * special-cased away, matching parsePoolSize's own precedent exactly.
 */
function parseBrandConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

const SOURCING_PER_BRAND_CONCURRENCY = parseBrandConcurrency(process.env.SOURCING_PER_BRAND_CONCURRENCY);

/** Per-brand semaphore state: how many calls are currently running, and the FIFO queue of callers waiting for a slot. */
interface BrandSlotState {
  active: number;
  waiters: Array<() => void>;
}

// Module-level map, keyed on normalized brand, so every call site across the
// whole process (both referenceSourcingOrchestrator.ts and
// catalogSourcingOrchestrator.ts, per T6) shares the same slot accounting
// for a given brand.
const brandState = new Map<string, BrandSlotState>();

/**
 * Blocks (by returning a never-otherwise-resolved promise) until a slot for
 * `state` is free, then claims it. Resolves immediately, without entering
 * the FIFO queue, when `state.active` is already below the cap.
 */
function acquireSlot(state: BrandSlotState): Promise<void> {
  if (state.active < SOURCING_PER_BRAND_CONCURRENCY) {
    state.active += 1;
    return Promise.resolve();
  }
  // Uses a `new Promise` executor rather than `Promise.withResolvers`
  // deliberately, matching db/download.ts's own precedent: this package's
  // tsconfig pins `lib: ["ES2022"]` (tsconfig.base.json), which doesn't
  // declare `Promise.withResolvers` (ES2024) and fails `tsc` build even
  // though vitest's transpile-only runner doesn't catch it.
  return new Promise<void>((resolve) => {
    state.waiters.push(() => {
      state.active += 1;
      resolve();
    });
  });
}

/** Releases a slot held for `state`, waking the next FIFO waiter (if any) rather than leaving the slot idle. */
function releaseSlot(state: BrandSlotState): void {
  const next = state.waiters.shift();
  if (next) {
    // Hand the freed slot straight to the next waiter in arrival order
    // instead of decrementing active — next() re-increments it itself, so
    // the slot count never dips to let a non-FIFO latecomer race in ahead
    // of an already-queued waiter.
    next();
  } else {
    state.active -= 1;
  }
}

/**
 * Runs `fn()` under a per-brand concurrency cap: at most
 * SOURCING_PER_BRAND_CONCURRENCY calls for the same normalized brand run at
 * once, with any call beyond the cap queued FIFO until a slot frees up.
 * `fn`'s own resolution/rejection is passed straight through; the slot is
 * always released in a `finally`, so a thrown error from `fn` still frees
 * the slot for the next waiter instead of leaking it.
 */
export async function runWithBrandLimit<T>(brand: string, fn: () => Promise<T>): Promise<T> {
  // Normalize so casing/whitespace differences across model responses for
  // the same real brand share one limit.
  const key = brand.trim().toLowerCase();
  let state = brandState.get(key);
  if (!state) {
    state = { active: 0, waiters: [] };
    brandState.set(key, state);
  }

  await acquireSlot(state);
  try {
    return await fn();
  } finally {
    releaseSlot(state);
  }
}
