// T5 proof (part 1 of 3 — the identify-parts call path; see
// workingStatusTriggerGate.test.ts for Req 12's direct trigger-gate proof
// and workingStatusManualSaveRoute.test.ts for the manual-save call path /
// Req 10 / Req 16 / Req 14, both against the real server + real DB):
// apps/server/src/jobs/identifyPartsWorkerPool.ts's persistIdentifiedParts
// (Req 6, 13).
//
// This file isolates the worker pool from DuckDB the same way
// identifyPartsWorkerPool.test.ts already does (mocking the db/index.js
// barrel it imports), so what is proven here is purely
// persistIdentifiedParts's working-status threading + $1 override — not the
// DB layer, which already has its own direct suites.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentifyPartsJob, IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import type { CreateExpectedPartInput, ExpectedPart, Listing } from '../src/db/index.js';

const claimNextQueuedJob = vi.fn<[], Promise<IdentifyPartsJob | null>>();
const completeJob = vi.fn<[string, IdentifyPartsResponse], Promise<void>>();
const failJob = vi.fn<[string, string], Promise<void>>();
// T4 Cycle-0 test-fix: this file's db/index.js mock predated the
// sourcing-resilience feature's retryOrFailJob requeue-with-backoff path
// (identifyPartsWorkerPool.ts's processJob catches any thrown error and
// always routes it through retryOrFailJob, never failJob). Before this
// feature, nothing in this suite's own path ever threw, so the gap in the
// mock never mattered; a part missing the now-required `notes` field used
// to throw inside persistIdentifiedParts's `part.notes.trim()`, which (with
// retryOrFailJob undefined on the mock) surfaced as an unrelated-looking
// "No retryOrFailJob export is defined on mock" error instead of the real
// TypeError. Mocking it here, matching identifyPartsWorkerPool.test.ts's
// own pattern, keeps this suite correct regardless of which error path a
// future change exercises.
const retryOrFailJob = vi.fn<[string, string], Promise<void>>();
const resetOrphanedJobsToQueued = vi.fn<[], Promise<string[]>>();
const updateJobStage = vi.fn<[string, 'sourcing_references' | 'comparing'], Promise<void>>();
const getListingById = vi.fn<[string], Promise<Listing | null>>();
const listExpectedPartsByListing = vi.fn<[string], Promise<ExpectedPart[]>>();
const deleteExpectedPart = vi.fn<[string], Promise<void>>();
const createExpectedPart = vi.fn<[CreateExpectedPartInput], Promise<ExpectedPart>>();

// Mocking the whole db/index.js barrel, matching the exact specifier
// identifyPartsWorkerPool.ts imports from (`from '../db/index.js'`), the
// same isolation identifyPartsWorkerPool.test.ts uses. vi.mock is hoisted
// above this file's imports, so the static imports below already see these.
vi.mock('../src/db/index.js', () => ({
  claimNextQueuedJob: (...args: []) => claimNextQueuedJob(...args),
  completeJob: (...args: [string, IdentifyPartsResponse]) => completeJob(...args),
  failJob: (...args: [string, string]) => failJob(...args),
  retryOrFailJob: (...args: [string, string]) => retryOrFailJob(...args),
  resetOrphanedJobsToQueued: (...args: []) => resetOrphanedJobsToQueued(...args),
  updateJobStage: (...args: [string, 'sourcing_references' | 'comparing']) => updateJobStage(...args),
  getListingById: (...args: [string]) => getListingById(...args),
  listExpectedPartsByListing: (...args: [string]) => listExpectedPartsByListing(...args),
  deleteExpectedPart: (...args: [string]) => deleteExpectedPart(...args),
  createExpectedPart: (...args: [CreateExpectedPartInput]) => createExpectedPart(...args),
}));

// persistIdentifiedParts's very last step hands its freshly-created rows to
// triggerPriceLookups (pricePartsTrigger.ts). Mocked away here (a real,
// unmocked import is used lower in this file for the direct Req 12 suite)
// so the identify-parts-path tests assert only persistIdentifiedParts's own
// field mapping — not the trigger's decision, which is the second half of
// this file's job.
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

/** Builds a minimal Listing fixture; `nonWorking` is the one field each test below varies. */
function listingFixture(id: string, nonWorking: boolean): Listing {
  return {
    id,
    sourceId: 'source-1',
    title: 'Test listing',
    description: 'Sold as-is',
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2026-01-01',
    status: 'active',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    nonWorking,
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

let activeHandle: { stop(): void } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  listExpectedPartsByListing.mockResolvedValue([]);
  deleteExpectedPart.mockResolvedValue(undefined);
  resetOrphanedJobsToQueued.mockResolvedValue([]);
  updateJobStage.mockResolvedValue(undefined);
  triggerPriceLookups.mockResolvedValue(undefined);
});

afterEach(() => {
  activeHandle?.stop();
  activeHandle = null;
  vi.restoreAllMocks();
});

describe('persistIdentifiedParts — Req 13 ($1 override) on the identify-parts call path, and Req 6 (explicit working on a non-flagged Listing)', () => {
  it('a fully-identified part resolved non_working by Identify Parts on a non-working Listing is stored workingStatus non_working with estimatedResaleValue exactly 1', async () => {
    const listing = listingFixture('listing-nonworking', true);
    const job = jobFixture('job-1', 'listing-nonworking');

    let created: CreateExpectedPartInput | null = null;
    createExpectedPart.mockImplementation(async (input) => {
      created = input;
      return {
        id: 'new-1',
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
        workingStatus: input.workingStatus ?? 'working',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      };
    });

    const result: IdentifyPartsResponse = {
      parts: [
        {
          category: 'GPU',
          brand: 'NVIDIA',
          partNumber: 'RTX-BROKEN',
          description: 'Reported dead on arrival',
          confidence: 'high',
          source: 'text',
          identityCandidates: [],
          // Explicit non_working signal: resolveWorkingStatuses (the real,
          // unmocked function) resolves this part to 'non_working' under
          // both its branches, since its own signal is specifically
          // "non_working" (Req 8's rule).
          workingStatus: 'non_working',
          notes: '',
        },
      ],
      notes: '',
    };

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue(result);

    activeHandle = startIdentifyPartsWorkerPool();
    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    expect(created).not.toBeNull();
    expect(created!.workingStatus).toBe('non_working');
    expect(created!.estimatedResaleValue).toBe(1);
    expect(created!.priceSource).toBe('auto');
  });

  it('a fully-identified part on a Listing NOT flagged non-working is stored with workingStatus exactly "working" (never omitted/null) and is not $1-overridden', async () => {
    const listing = listingFixture('listing-working', false);
    const job = jobFixture('job-2', 'listing-working');

    let created: CreateExpectedPartInput | null = null;
    createExpectedPart.mockImplementation(async (input) => {
      created = input;
      return {
        id: 'new-2',
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
        workingStatus: input.workingStatus ?? 'working',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      };
    });

    const result: IdentifyPartsResponse = {
      parts: [
        {
          category: 'CPU',
          brand: 'Intel',
          partNumber: 'i7-10700',
          description: 'Pulled from a working tower',
          confidence: 'high',
          source: 'text',
          identityCandidates: [],
          notes: '',
          // No workingStatus signal at all (the field identifyPartsWorkerPool
          // never asks the AI pipeline to set on a non-flagged Listing,
          // mirroring buildIdentificationPrompt only appending the rule
          // when listing.nonWorking is true).
        },
      ],
      notes: '',
    };

    claimNextQueuedJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue(result);

    activeHandle = startIdentifyPartsWorkerPool();
    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    expect(created).not.toBeNull();
    // Asserted as a literal string equality, not a truthy/defined check:
    // `undefined !== 'non_working'` would also read as "not non_working",
    // so only an exact-match assertion actually proves the field is the
    // literal string 'working' rather than merely absent.
    expect(created!.workingStatus).toBe('working');
    expect(created!.estimatedResaleValue).toBeNull();
  });
});
