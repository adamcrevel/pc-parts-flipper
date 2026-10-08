// T2 proof: apps/server/src/jobs/identifyPartsWorkerPool.ts (Req 4, 5, 6).
//
// This suite isolates the worker pool from both DuckDB and the real AI
// pipeline by mocking the two modules it imports (db/index.js and
// ai/partIdentification.js), the same module-under-test isolation
// scheduler.test.ts uses for scanService.js. That keeps the focus on the
// pool's own logic — claim/process sequencing, onStage-to-updateJobStage
// wiring, and the activeCount bookkeeping that frees a slot for the next
// job — rather than re-proving identifyListingParts or the DB layer, which
// already have their own direct suites (partIdentification.test.ts,
// identifyPartsJobs's own callers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentifyPartsJob, IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import { logger } from '../src/logger.js';
import type { CreateExpectedPartInput, ExpectedPart, Listing } from '../src/db/index.js';

const claimNextQueuedJob = vi.fn<[], Promise<IdentifyPartsJob | null>>();
const completeJob = vi.fn<[string, IdentifyPartsResponse], Promise<void>>();
const failJob = vi.fn<[string, string], Promise<void>>();
const resetOrphanedJobsToQueued = vi.fn<[], Promise<string[]>>();
const updateJobStage = vi.fn<[string, 'sourcing_references' | 'comparing'], Promise<void>>();
const getListingById = vi.fn<[string], Promise<Listing | null>>();
// The three functions persistIdentifiedParts (Req 1-2's full-replace dedupe)
// drives directly: a real fake store (not just call-recording) backs these
// three in the "persistIdentifiedParts dedupe & job-failure data integrity"
// describe block below, so that suite can assert the Listing's *final* set
// of Expected Parts, not merely that some function was called.
const listExpectedPartsByListing = vi.fn<[string], Promise<ExpectedPart[]>>();
const deleteExpectedPart = vi.fn<[string], Promise<void>>();
const createExpectedPart = vi.fn<[CreateExpectedPartInput], Promise<ExpectedPart>>();

// Mocking the whole db/index.js barrel (rather than the single
// identifyPartsJobs.ts query file) matches how the worker pool itself
// imports it (`from '../db/index.js'`), so vi.mock's specifier resolves to
// the exact module the pool sees. vi.mock is hoisted above this file's
// imports, so the static import of identifyPartsWorkerPool.ts below
// already sees these mocks.
vi.mock('../src/db/index.js', () => ({
  claimNextQueuedJob: (...args: []) => claimNextQueuedJob(...args),
  completeJob: (...args: [string, IdentifyPartsResponse]) => completeJob(...args),
  failJob: (...args: [string, string]) => failJob(...args),
  resetOrphanedJobsToQueued: (...args: []) => resetOrphanedJobsToQueued(...args),
  updateJobStage: (...args: [string, 'sourcing_references' | 'comparing']) => updateJobStage(...args),
  getListingById: (...args: [string]) => getListingById(...args),
  listExpectedPartsByListing: (...args: [string]) => listExpectedPartsByListing(...args),
  deleteExpectedPart: (...args: [string]) => deleteExpectedPart(...args),
  createExpectedPart: (...args: [CreateExpectedPartInput]) => createExpectedPart(...args),
}));

// persistIdentifiedParts hands its freshly-created rows to triggerPriceLookups
// (pricePartsTrigger.ts) as its very last step. That module has its own
// direct suite (pricePartsTrigger.test.ts); mocking it away here keeps this
// file's focus on persistIdentifiedParts's own delete/create dedupe logic,
// the same way identifyListingParts (also separately tested) is mocked
// below rather than exercised for real.
const triggerPriceLookups = vi.fn<[ExpectedPart[]], Promise<void>>();
vi.mock('../src/jobs/pricePartsTrigger.js', () => ({
  triggerPriceLookups: (...args: [ExpectedPart[]]) => triggerPriceLookups(...args),
}));

type OnStage = (stage: 'sourcing_references' | 'comparing') => void;
const identifyListingParts = vi.fn<[Listing, unknown, OnStage | undefined], Promise<IdentifyPartsResponse>>();
vi.mock('../src/ai/partIdentification.js', () => ({
  identifyListingParts: (...args: [Listing, unknown, OnStage | undefined]) => identifyListingParts(...args),
}));

import { startIdentifyPartsWorkerPool } from '../src/jobs/identifyPartsWorkerPool.js';

// Builds a minimal Listing fixture; only `id` matters to the pool itself
// (it passes the whole Listing through to identifyListingParts, mocked
// here, so the remaining fields are never read).
function listingFixture(id: string): Listing {
  return {
    id,
    sourceId: 'source-1',
    title: 'Test listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2026-01-01',
    status: 'active',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function jobFixture(id: string, listingId: string): IdentifyPartsJob {
  return {
    id,
    listingId,
    stage: 'identifying',
    parts: null,
    notes: null,
    errorMessage: null,
    delivered: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  };
}

// Every pool handle started by a test is stopped in afterEach, so a test's
// 1000ms poll interval never outlives the test and leaks into the next one
// (or leaves vitest's process waiting on an open timer handle).
let activeHandle: { stop(): void } | null = null;

beforeEach(() => {
  claimNextQueuedJob.mockReset().mockResolvedValue(null);
  completeJob.mockReset().mockResolvedValue(undefined);
  failJob.mockReset().mockResolvedValue(undefined);
  resetOrphanedJobsToQueued.mockReset().mockResolvedValue([]);
  updateJobStage.mockReset().mockResolvedValue(undefined);
  getListingById.mockReset().mockResolvedValue(null);
  identifyListingParts.mockReset();
  listExpectedPartsByListing.mockReset().mockResolvedValue([]);
  deleteExpectedPart.mockReset().mockResolvedValue(undefined);
  createExpectedPart.mockReset();
  triggerPriceLookups.mockReset().mockResolvedValue(undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => logger);
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  activeHandle?.stop();
  activeHandle = null;
  vi.restoreAllMocks();
});

describe('startIdentifyPartsWorkerPool (T2, Req 4, 5, 6)', () => {
  it('resets orphaned jobs to queued on startup before any claim work runs', async () => {
    resetOrphanedJobsToQueued.mockResolvedValue(['orphan-1', 'orphan-2']);

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(resetOrphanedJobsToQueued).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        { resetCount: 2 },
        'Recovered orphaned identify-parts jobs',
      ),
    );
  });

  it("claims a queued job, wires onStage to updateJobStage in order, and completes it with the pipeline's result", async () => {
    const listing = listingFixture('listing-A');
    const job = jobFixture('job-A', 'listing-A');
    const fakeResult: IdentifyPartsResponse = { parts: [], notes: 'done' };

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockImplementation(async (_listing, _options, onStage) => {
      onStage?.('sourcing_references');
      onStage?.('comparing');
      return fakeResult;
    });

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    // identifyListingParts is called with the claimed job's Listing, no
    // OmpRunOptions (production never passes any), and a stage callback.
    expect(identifyListingParts).toHaveBeenCalledWith(listing, undefined, expect.any(Function));

    // Both stage transitions reached the DB in the order the pipeline
    // raised them, scoped to this job's id.
    expect(updateJobStage).toHaveBeenNthCalledWith(1, 'job-A', 'sourcing_references');
    expect(updateJobStage).toHaveBeenNthCalledWith(2, 'job-A', 'comparing');
    expect(updateJobStage).toHaveBeenCalledTimes(2);

    expect(completeJob).toHaveBeenCalledWith('job-A', fakeResult);
    expect(failJob).not.toHaveBeenCalled();
  });

  it('never calls updateJobStage when the pipeline never raises a stage transition (e.g. no eligible parts)', async () => {
    const listing = listingFixture('listing-B');
    const job = jobFixture('job-B', 'listing-B');
    const fakeResult: IdentifyPartsResponse = { parts: [], notes: '' };

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue(fakeResult);

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    expect(updateJobStage).not.toHaveBeenCalled();
    expect(completeJob).toHaveBeenCalledWith('job-B', fakeResult);
  });

  it('fails a job without calling identifyListingParts when its Listing has been deleted', async () => {
    const job = jobFixture('job-C', 'listing-deleted');

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(null);

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(failJob).toHaveBeenCalledTimes(1));

    expect(failJob).toHaveBeenCalledWith('job-C', 'Listing no longer exists');
    expect(identifyListingParts).not.toHaveBeenCalled();
    expect(completeJob).not.toHaveBeenCalled();
  });

  // Proves the pool's own activeCount bookkeeping (the part the
  // falsification question for this task singles out): with the default
  // pool size of 1, after the first claimed job finishes (successfully or
  // not) the slot it held must be freed so the very next pump() call can
  // claim and process a second job. If the pool never decremented
  // activeCount on completion, job-2 would never be claimed and
  // identifyListingParts would be called exactly once instead of twice.
  it('frees its slot after a job fails, so the pool immediately claims and processes the next queued job', async () => {
    const listingFailing = listingFixture('listing-fail');
    const listingOk = listingFixture('listing-ok');
    const job1 = jobFixture('job-1', 'listing-fail');
    const job2 = jobFixture('job-2', 'listing-ok');
    const fakeResult: IdentifyPartsResponse = { parts: [], notes: 'second job' };

    claimNextQueuedJob
      .mockResolvedValueOnce(job1)
      .mockResolvedValueOnce(job2)
      .mockResolvedValue(null);
    getListingById.mockImplementation(async (id) => (id === 'listing-fail' ? listingFailing : listingOk));
    identifyListingParts.mockImplementation(async (listing) => {
      if (listing.id === 'listing-fail') {
        throw new Error('boom');
      }
      return fakeResult;
    });

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    expect(failJob).toHaveBeenCalledWith('job-1', 'boom');
    expect(completeJob).toHaveBeenCalledWith('job-2', fakeResult);
    expect(identifyListingParts).toHaveBeenCalledTimes(2);
  });

  it('stop() clears the poll interval so no further claim attempt is made', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    activeHandle = startIdentifyPartsWorkerPool();
    await vi.waitFor(() => expect(claimNextQueuedJob).toHaveBeenCalled());

    activeHandle.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

// T1 proof: identifyPartsWorkerPool.ts's persistIdentifiedParts (Req 1-2).
// Runs through the real startIdentifyPartsWorkerPool -> processJob ->
// persistIdentifiedParts path (the same harness as the describe block
// above), but backs listExpectedPartsByListing/deleteExpectedPart/
// createExpectedPart with an in-memory store keyed by listingId instead of
// just recording calls, so these tests can assert the Listing's *final*
// set of Expected Parts after the job runs — not merely that some function
// was called with some argument.
describe('persistIdentifiedParts dedupe & job-failure data integrity (T1, Req 1-2)', () => {
  it('rerunning Identify Parts replaces a hand-entered part and a prior AI-sourced part with exactly the newly identified set, no duplicates', async () => {
    const listing = listingFixture('listing-dedupe');
    const job = jobFixture('job-dedupe', 'listing-dedupe');

    const handEntered: ExpectedPart = {
      id: 'hand-1',
      listingId: 'listing-dedupe',
      componentCategory: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX-OLD',
      description: 'Hand-entered GPU',
      estimatedResaleValue: 200,
      identityCandidates: [],
      aiConfidence: null,
      aiSource: null,
      priceSource: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const priorAiPart: ExpectedPart = {
      id: 'ai-old-1',
      listingId: 'listing-dedupe',
      componentCategory: 'CPU',
      brand: 'Intel',
      partNumber: 'i5-old',
      description: 'Prior AI CPU',
      estimatedResaleValue: null,
      identityCandidates: [],
      aiConfidence: 'high',
      aiSource: 'text',
      priceSource: 'auto',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = new Map<string, ExpectedPart[]>([['listing-dedupe', [handEntered, priorAiPart]]]);

    listExpectedPartsByListing.mockImplementation(async (listingId) => store.get(listingId) ?? []);
    deleteExpectedPart.mockImplementation(async (id) => {
      for (const [key, parts] of store) {
        store.set(key, parts.filter((p) => p.id !== id));
      }
    });
    let createdCounter = 0;
    createExpectedPart.mockImplementation(async (input) => {
      createdCounter += 1;
      const row: ExpectedPart = {
        id: `new-${createdCounter}`,
        listingId: input.listingId,
        componentCategory: input.componentCategory,
        brand: input.brand,
        partNumber: input.partNumber,
        description: input.description,
        estimatedResaleValue: input.estimatedResaleValue,
        identityCandidates: input.identityCandidates,
        aiConfidence: input.aiConfidence,
        aiSource: input.aiSource,
        priceSource: input.priceSource ?? null,
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      };
      store.set(input.listingId, [...(store.get(input.listingId) ?? []), row]);
      return row;
    });

    const freshResult: IdentifyPartsResponse = {
      parts: [
        {
          category: 'GPU',
          brand: 'NVIDIA',
          partNumber: 'RTX-NEW',
          description: 'Newly identified GPU',
          confidence: 'high',
          source: 'text',
          identityCandidates: [],
        },
      ],
      notes: 'rerun',
    };

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue(freshResult);

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    // Both the hand-entered part and the prior AI-sourced part were
    // deleted — deletion is not filtered by aiSource.
    expect(deleteExpectedPart).toHaveBeenCalledWith('hand-1');
    expect(deleteExpectedPart).toHaveBeenCalledWith('ai-old-1');
    expect(deleteExpectedPart).toHaveBeenCalledTimes(2);

    // Exactly one new part was created, carrying the fresh result's own
    // data (full object, not a subset) through persistIdentifiedParts's
    // own field mapping. listing.nonWorking is falsy on this fixture (the
    // field is simply absent), so persistIdentifiedParts's else-branch
    // stamps workingStatus explicitly 'working' (Req 6) rather than ever
    // omitting the field.
    expect(createExpectedPart).toHaveBeenCalledTimes(1);
    expect(createExpectedPart).toHaveBeenCalledWith({
      listingId: 'listing-dedupe',
      componentCategory: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX-NEW',
      description: 'Newly identified GPU',
      estimatedResaleValue: null,
      identityCandidates: [],
      aiConfidence: 'high',
      aiSource: 'text',
      priceSource: 'auto',
      workingStatus: 'working',
    });

    // The store (standing in for the Listing's real Expected Parts) now
    // holds exactly the one newly-identified part: the old hand-entered and
    // prior-AI rows are gone, and nothing is duplicated.
    const finalParts = store.get('listing-dedupe') ?? [];
    expect(finalParts.map((p) => p.id)).toEqual(['new-1']);
    expect(finalParts[0]).toMatchObject({ brand: 'NVIDIA', partNumber: 'RTX-NEW' });

    // Only the freshly-created part is handed downstream to price lookups —
    // the deleted rows never reach it.
    expect(triggerPriceLookups).toHaveBeenCalledTimes(1);
    expect(triggerPriceLookups).toHaveBeenCalledWith([expect.objectContaining({ id: 'new-1' })]);
  });

  it('leaves existing Expected Parts completely untouched when the job fails (identifyListingParts throws)', async () => {
    const listing = listingFixture('listing-fail-keep');
    const job = jobFixture('job-fail-keep', 'listing-fail-keep');

    const original: ExpectedPart[] = [
      {
        id: 'hand-2',
        listingId: 'listing-fail-keep',
        componentCategory: 'PSU',
        brand: null,
        partNumber: null,
        description: 'Hand PSU',
        estimatedResaleValue: 40,
        identityCandidates: [],
        aiConfidence: null,
        aiSource: null,
        priceSource: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'ai-2',
        listingId: 'listing-fail-keep',
        componentCategory: 'RAM',
        brand: 'Corsair',
        partNumber: 'CMK16',
        description: 'Prior AI RAM',
        estimatedResaleValue: null,
        identityCandidates: [],
        aiConfidence: 'medium',
        aiSource: 'photo',
        priceSource: 'auto',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const store = new Map<string, ExpectedPart[]>([['listing-fail-keep', original]]);

    listExpectedPartsByListing.mockImplementation(async (listingId) => store.get(listingId) ?? []);
    deleteExpectedPart.mockImplementation(async (id) => {
      for (const [key, parts] of store) {
        store.set(key, parts.filter((p) => p.id !== id));
      }
    });
    createExpectedPart.mockImplementation(async () => {
      throw new Error('createExpectedPart must not be called when the job fails');
    });

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockRejectedValue(new Error('AI pipeline exploded'));

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(failJob).toHaveBeenCalledTimes(1));

    expect(failJob).toHaveBeenCalledWith('job-fail-keep', 'AI pipeline exploded');
    expect(completeJob).not.toHaveBeenCalled();
    expect(listExpectedPartsByListing).not.toHaveBeenCalled();
    expect(deleteExpectedPart).not.toHaveBeenCalled();
    expect(createExpectedPart).not.toHaveBeenCalled();
    expect(triggerPriceLookups).not.toHaveBeenCalled();

    // Same ids, same rows — nothing deleted or added.
    expect(store.get('listing-fail-keep')).toEqual(original);
  });
});

// T2 Cycle-0 fix proof: an empty-string or non-numeric
// IDENTIFY_PARTS_POOL_SIZE must not silently become POOL_SIZE 0/NaN (which
// makes pump()'s `activeCount < POOL_SIZE` false forever, so jobs enqueue
// but are never claimed). process.env.IDENTIFY_PARTS_POOL_SIZE is read
// once, at module load, into the module-scope POOL_SIZE constant — the
// static import at the top of this file already evaluated it with
// whatever the env var was at file-load time, so exercising a *different*
// raw value here requires setting the env var, clearing vitest's module
// cache with vi.resetModules(), and re-importing the module so POOL_SIZE
// is recomputed. vi.mock registrations (db/index.js,
// ai/partIdentification.js) survive resetModules — only the module cache
// is cleared, not the mock registry — so the fresh module instance still
// resolves to this file's same claimNextQueuedJob/completeJob/etc. mock
// functions. Placed last in the file (after every test using the
// originally statically-imported startIdentifyPartsWorkerPool) so
// resetModules here can't affect any earlier test's already-captured
// import bindings.
describe('parsePoolSize fallback for IDENTIFY_PARTS_POOL_SIZE (T2 fix)', () => {
  const originalPoolSize = process.env.IDENTIFY_PARTS_POOL_SIZE;

  afterEach(() => {
    if (originalPoolSize === undefined) {
      delete process.env.IDENTIFY_PARTS_POOL_SIZE;
    } else {
      process.env.IDENTIFY_PARTS_POOL_SIZE = originalPoolSize;
    }
  });

  async function assertPoolStillProcessesAJob(): Promise<void> {
    vi.resetModules();

    const listing = listingFixture('listing-fallback');
    const job = jobFixture('job-fallback', 'listing-fallback');
    const fakeResult: IdentifyPartsResponse = { parts: [], notes: 'fallback' };

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue(fakeResult);

    // Exception to static-import preference: this module's POOL_SIZE is a
    // module-scope constant computed once at import time from
    // process.env.IDENTIFY_PARTS_POOL_SIZE, so a static top-of-file import
    // can only ever observe the env var as it was when this test file
    // first loaded. Proving the fallback for a *different* raw value
    // requires setting the env var and re-triggering module evaluation at
    // runtime via vi.resetModules() + a dynamic import — a static import
    // genuinely cannot do this, matching this rule's own "test cases that
    // intentionally exercise module loading boundaries" exception.
    const { startIdentifyPartsWorkerPool: freshStart } = await import(
      '../src/jobs/identifyPartsWorkerPool.js'
    );
    activeHandle = freshStart();

    // If parsePoolSize had let POOL_SIZE become 0 (empty string via the old
    // `Number(raw ?? 1)`) or NaN (non-numeric string), pump()'s
    // `activeCount < POOL_SIZE` comparison is false on every call, so
    // claimNextQueuedJob is never invoked and completeJob never fires —
    // this wait would time out and fail the test instead of resolving.
    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));
    expect(completeJob).toHaveBeenCalledWith('job-fallback', fakeResult);
  }

  it('falls back to POOL_SIZE 1 and still claims+completes a queued job when IDENTIFY_PARTS_POOL_SIZE is an empty string', async () => {
    process.env.IDENTIFY_PARTS_POOL_SIZE = '';
    await assertPoolStillProcessesAJob();
  });

  it('falls back to POOL_SIZE 1 and still claims+completes a queued job when IDENTIFY_PARTS_POOL_SIZE is a non-numeric string', async () => {
    process.env.IDENTIFY_PARTS_POOL_SIZE = 'not-a-number';
    await assertPoolStillProcessesAJob();
  });
});
