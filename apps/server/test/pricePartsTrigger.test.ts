// T4 proof: apps/server/src/jobs/pricePartsTrigger.ts (Req 5-7, 13-14) —
// the cache-hit/miss decision at nodes B-G of the feature's architecture
// diagram.
//
// This suite isolates the trigger from DuckDB by mocking the db/index.js
// barrel it imports, the same module-under-test isolation
// identifyPartsWorkerPool.test.ts uses for the sibling worker pool. What is
// under test here is purely the decision — which of propagate / insert /
// enqueue happens for which cache state — and the query functions it calls
// already have their own direct-DB suites (partPriceCache.test.ts,
// pricePartsJobs.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentCategory, ExpectedPart, PartPriceCacheEntry } from '../src/db/types.js';
import { logger } from '../src/logger.js';

const findPriceCacheEntry = vi.fn<[ComponentCategory, string, string], Promise<PartPriceCacheEntry | null>>();
const insertPriceCacheEntry = vi.fn<[ComponentCategory, string, string], Promise<{ inserted: boolean }>>();
const propagateCachedPriceToExpectedParts = vi.fn<[ComponentCategory, string, string, number], Promise<void>>();
const createQueuedPriceJobIfAbsent = vi.fn<[ComponentCategory, string, string], Promise<{ inserted: boolean }>>();

// Mocking the whole db/index.js barrel (rather than the two query files)
// matches how the trigger itself imports it, so vi.mock's specifier resolves
// to the exact module the trigger sees. vi.mock is hoisted above this file's
// imports, so the static import of pricePartsTrigger.js below already sees
// these mocks.
vi.mock('../src/db/index.js', () => ({
  findPriceCacheEntry: (...args: [ComponentCategory, string, string]) => findPriceCacheEntry(...args),
  insertPriceCacheEntry: (...args: [ComponentCategory, string, string]) => insertPriceCacheEntry(...args),
  propagateCachedPriceToExpectedParts: (...args: [ComponentCategory, string, string, number]) =>
    propagateCachedPriceToExpectedParts(...args),
  createQueuedPriceJobIfAbsent: (...args: [ComponentCategory, string, string]) =>
    createQueuedPriceJobIfAbsent(...args),
}));

import { triggerPriceLookups } from '../src/jobs/pricePartsTrigger.js';

/** Builds an Expected Part fixture; only the five fields the trigger reads matter. */
function partFixture(overrides: Partial<ExpectedPart> = {}): ExpectedPart {
  return {
    id: 'part-1',
    listingId: 'listing-1',
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3060',
    description: 'Pulled from the tower',
    estimatedResaleValue: null,
    identityCandidates: [],
    aiConfidence: 'high',
    aiSource: 'text',
    priceSource: 'auto',
    workingStatus: 'working',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function cacheFixture(estimatedResaleValue: number | null): PartPriceCacheEntry {
  return {
    id: 'cache-1',
    category: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3060',
    estimatedResaleValue,
    lastResearchedAt: estimatedResaleValue === null ? null : '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findPriceCacheEntry.mockResolvedValue(null);
  insertPriceCacheEntry.mockResolvedValue({ inserted: true });
  propagateCachedPriceToExpectedParts.mockResolvedValue(undefined);
  createQueuedPriceJobIfAbsent.mockResolvedValue({ inserted: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('triggerPriceLookups — cache hit with a value (diagram node D)', () => {
  it('writes the cached value onto matching rows and enqueues nothing', async () => {
    findPriceCacheEntry.mockResolvedValue(cacheFixture(275));

    await triggerPriceLookups([partFixture()]);

    expect(propagateCachedPriceToExpectedParts).toHaveBeenCalledTimes(1);
    expect(propagateCachedPriceToExpectedParts).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3060', 275);
    expect(insertPriceCacheEntry).not.toHaveBeenCalled();
    expect(createQueuedPriceJobIfAbsent).not.toHaveBeenCalled();
  });

  // A zero is a real researched value, not an absence — a truthiness check
  // on the cached value would silently drop it back into the "still null"
  // branch and leave the row unpriced forever.
  it('propagates a cached value of 0 rather than treating it as absent', async () => {
    findPriceCacheEntry.mockResolvedValue(cacheFixture(0));

    await triggerPriceLookups([partFixture()]);

    expect(propagateCachedPriceToExpectedParts).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3060', 0);
    expect(createQueuedPriceJobIfAbsent).not.toHaveBeenCalled();
  });
});

describe('triggerPriceLookups — cache hit still unpriced (diagram node E)', () => {
  it('does nothing further: no propagation, no insert, no second job', async () => {
    findPriceCacheEntry.mockResolvedValue(cacheFixture(null));

    await triggerPriceLookups([partFixture()]);

    expect(findPriceCacheEntry).toHaveBeenCalledTimes(1);
    expect(propagateCachedPriceToExpectedParts).not.toHaveBeenCalled();
    expect(insertPriceCacheEntry).not.toHaveBeenCalled();
    expect(createQueuedPriceJobIfAbsent).not.toHaveBeenCalled();
  });
});

describe('triggerPriceLookups — cache miss (diagram nodes F-G)', () => {
  it('inserts the cache row and atomically enqueues a research job', async () => {
    await triggerPriceLookups([partFixture()]);

    expect(insertPriceCacheEntry).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3060');
    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledTimes(1);
    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3060');
    expect(propagateCachedPriceToExpectedParts).not.toHaveBeenCalled();
  });

  // Req 13, race loser: another writer won the cache-insert race, so this
  // writer's insert reports inserted: false. The winner may not have
  // reached its own enqueue yet, so "I lost the race" is not evidence a job
  // exists — the atomic enqueue-unless-non-terminal call is still made, and
  // the DB's own WHERE NOT EXISTS is what actually answers whether a job
  // already exists (pricePartsJobs.test.ts, pricePartsTriggerRace.test.ts).
  it('still calls the atomic enqueue when it lost the insert race', async () => {
    insertPriceCacheEntry.mockResolvedValue({ inserted: false });

    await triggerPriceLookups([partFixture()]);

    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3060');
  });

  // Req 13, the duplicate guard's outcome at this layer: the atomic
  // enqueue reporting inserted: false (a job was already queued/pricing,
  // per the DB's own WHERE NOT EXISTS) ends resolveCombo with no further
  // action — nothing else is called off the back of that result.
  it('takes no further action when the atomic enqueue reports a duplicate was skipped', async () => {
    createQueuedPriceJobIfAbsent.mockResolvedValue({ inserted: false });

    await expect(triggerPriceLookups([partFixture()])).resolves.toBeUndefined();

    expect(insertPriceCacheEntry).toHaveBeenCalledTimes(1);
    expect(propagateCachedPriceToExpectedParts).not.toHaveBeenCalled();
  });
});

describe('triggerPriceLookups — eligibility (diagram node B)', () => {
  it('skips a part with no brand', async () => {
    await triggerPriceLookups([partFixture({ brand: null })]);
    expect(findPriceCacheEntry).not.toHaveBeenCalled();
  });

  it('skips a part with no part number', async () => {
    await triggerPriceLookups([partFixture({ partNumber: null })]);
    expect(findPriceCacheEntry).not.toHaveBeenCalled();
  });

  // Req 14: a row that already carries a price is never re-priced by the
  // pipeline, whoever put that figure there.
  it('skips a part that already has an estimated resale value', async () => {
    await triggerPriceLookups([partFixture({ estimatedResaleValue: 120 })]);
    expect(findPriceCacheEntry).not.toHaveBeenCalled();
    expect(createQueuedPriceJobIfAbsent).not.toHaveBeenCalled();
  });

  it('skips a part priced at 0, which is a real price and not an absent one', async () => {
    await triggerPriceLookups([partFixture({ estimatedResaleValue: 0 })]);
    expect(findPriceCacheEntry).not.toHaveBeenCalled();
  });

  it('processes only the eligible parts out of a mixed set', async () => {
    await triggerPriceLookups([
      partFixture({ id: 'a', brand: null }),
      partFixture({ id: 'b', componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-9700K' }),
      partFixture({ id: 'c', estimatedResaleValue: 50 }),
    ]);

    expect(findPriceCacheEntry).toHaveBeenCalledTimes(1);
    expect(findPriceCacheEntry).toHaveBeenCalledWith('CPU', 'Intel', 'i7-9700K');
  });
});

describe('triggerPriceLookups — de-duplication and failure isolation', () => {
  // Two rows of the same part in one Listing are one combo. Resolving it
  // twice would race the trigger against itself over the same cache row and
  // job queue, which is the very duplicate this module exists to prevent.
  it('resolves a combo once even when several parts share it', async () => {
    await triggerPriceLookups([partFixture({ id: 'a' }), partFixture({ id: 'b' })]);

    expect(findPriceCacheEntry).toHaveBeenCalledTimes(1);
    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('treats the same brand/part number under different categories as different combos', async () => {
    await triggerPriceLookups([
      partFixture({ id: 'a', componentCategory: 'GPU' }),
      partFixture({ id: 'b', componentCategory: 'Other' }),
    ]);

    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledTimes(2);
  });

  // Best-effort background trigger: the write it hangs off already
  // succeeded, so one combo blowing up must neither reject nor stop the
  // rest — the same contract promoteReferencesForExpectedParts holds.
  it('logs and continues when one combo fails, still resolving the others', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    findPriceCacheEntry.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      triggerPriceLookups([
        partFixture({ id: 'a' }),
        partFixture({ id: 'b', componentCategory: 'CPU', brand: 'Intel', partNumber: 'i7-9700K' }),
      ]),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledTimes(1);
    expect(createQueuedPriceJobIfAbsent).toHaveBeenCalledWith('CPU', 'Intel', 'i7-9700K');
  });
});
