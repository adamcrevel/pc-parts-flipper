// T5 proof (part 2 of 3 — Req 12's direct gate proof; see
// workingStatusIdentifyParts.test.ts for the identify-parts call path and
// workingStatusManualSaveRoute.test.ts for the manual-save call path / Req
// 10 / Req 16 / Req 14, both against the real server + real DB):
// apps/server/src/jobs/pricePartsTrigger.ts's node-B eligibility gate must
// exclude a part whose workingStatus is 'non_working', even when that part
// still carries a null estimatedResaleValue — the one other gate condition
// that, alone, would otherwise mark it eligible. This isolates
// workingStatus as the single, specific reason the part is excluded, the
// exact counter-example R5's review brief names (a part whose workingStatus
// is non_working but whose estimatedResaleValue is still null, e.g. a
// toggle-then-resave).
//
// Isolated from DuckDB the same way pricePartsTrigger.test.ts's own suite
// is, mocking the four db/index.js functions resolveCombo touches, with the
// real, unmocked triggerPriceLookups under test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentCategory, ExpectedPart, PartPriceCacheEntry } from '../src/db/types.js';

const findPriceCacheEntry = vi.fn<[ComponentCategory, string, string], Promise<PartPriceCacheEntry | null>>();
const insertPriceCacheEntry = vi.fn<[ComponentCategory, string, string], Promise<{ inserted: boolean }>>();
const propagateCachedPriceToExpectedParts = vi.fn<[ComponentCategory, string, string, number], Promise<void>>();
const createQueuedPriceJobIfAbsent = vi.fn<[ComponentCategory, string, string], Promise<{ inserted: boolean }>>();

vi.mock('../src/db/index.js', () => ({
  findPriceCacheEntry: (...args: [ComponentCategory, string, string]) => findPriceCacheEntry(...args),
  insertPriceCacheEntry: (...args: [ComponentCategory, string, string]) => insertPriceCacheEntry(...args),
  propagateCachedPriceToExpectedParts: (...args: [ComponentCategory, string, string, number]) =>
    propagateCachedPriceToExpectedParts(...args),
  createQueuedPriceJobIfAbsent: (...args: [ComponentCategory, string, string]) => createQueuedPriceJobIfAbsent(...args),
}));

import { triggerPriceLookups } from '../src/jobs/pricePartsTrigger.js';

/** An otherwise-fully-eligible part (brand+partNumber known, no price of its own) except for its workingStatus. */
function nonWorkingPartFixture(): ExpectedPart {
  return {
    id: 'part-nonworking',
    listingId: 'listing-1',
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3060',
    description: 'Dead GPU',
    estimatedResaleValue: null,
    identityCandidates: [],
    aiConfidence: 'high',
    aiSource: 'text',
    priceSource: 'auto',
    workingStatus: 'non_working',
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

describe('triggerPriceLookups — Req 12: a non_working part is never passed to resolveCombo', () => {
  it('a fully-identified, unpriced, non_working part triggers no cache read, no cache insert, no propagation, and no enqueue', async () => {
    await triggerPriceLookups([nonWorkingPartFixture()]);

    // Never passed to resolveCombo: none of node C-G's four calls fired.
    expect(findPriceCacheEntry).not.toHaveBeenCalled();
    expect(insertPriceCacheEntry).not.toHaveBeenCalled();
    expect(propagateCachedPriceToExpectedParts).not.toHaveBeenCalled();
    expect(createQueuedPriceJobIfAbsent).not.toHaveBeenCalled();
  });

  // Control case for the test above: flipping only workingStatus back to
  // 'working' (every other field identical) makes the same part eligible
  // again, confirming workingStatus is genuinely what gated it — not some
  // other field this fixture happens to carry.
  it('control: the identical part with workingStatus working IS passed to resolveCombo (reaches the cache read)', async () => {
    const workingPart: ExpectedPart = { ...nonWorkingPartFixture(), workingStatus: 'working' };

    await triggerPriceLookups([workingPart]);

    expect(findPriceCacheEntry).toHaveBeenCalledTimes(1);
    expect(findPriceCacheEntry).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3060');
  });
});
