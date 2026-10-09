// T4 proof: the identify-parts write path claims every fully-identified
// part it persists for the price pipeline and hands the saved rows to the
// trigger (part-price-estimation feature, Req 1 and 3).
//
// Isolated the same way identifyPartsWorkerPool.test.ts isolates the pool —
// the db/index.js barrel and ai/partIdentification.js are mocked — plus
// jobs/pricePartsTrigger.js, so what is asserted here is the wiring
// (priceSource decided per part, trigger called with the created rows) and
// not the trigger's own decision, which pricePartsTrigger.test.ts proves
// separately.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentifyPartsJob, IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import type { CreateExpectedPartInput, ExpectedPart, Listing } from '../src/db/index.js';
import { logger } from '../src/logger.js';

const claimNextQueuedJob = vi.fn<[], Promise<IdentifyPartsJob | null>>();
const completeJob = vi.fn<[string, IdentifyPartsResponse], Promise<void>>();
const failJob = vi.fn<[string, string], Promise<void>>();
const retryOrFailJob = vi.fn<[string, string], Promise<void>>();
const resetOrphanedJobsToQueued = vi.fn<[], Promise<string[]>>();
const updateJobStage = vi.fn<[string, 'sourcing_references' | 'comparing'], Promise<void>>();
const getListingById = vi.fn<[string], Promise<Listing | null>>();
const listExpectedPartsByListing = vi.fn<[string], Promise<ExpectedPart[]>>();
const deleteExpectedPart = vi.fn<[string], Promise<void>>();
const createExpectedPart = vi.fn<[CreateExpectedPartInput], Promise<ExpectedPart>>();

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

const triggerPriceLookups = vi.fn<[ExpectedPart[]], Promise<void>>();
vi.mock('../src/jobs/pricePartsTrigger.js', () => ({
  triggerPriceLookups: (...args: [ExpectedPart[]]) => triggerPriceLookups(...args),
}));

import { startIdentifyPartsWorkerPool } from '../src/jobs/identifyPartsWorkerPool.js';

function listingFixture(id: string): Listing {
  return {
    id,
    sourceId: 'source-1',
    title: 'Test listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2026-01-01',
    status: 'open',
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

// Echoes the insert back as the stored row would read, so the test can
// assert on exactly what the trigger was handed.
function storedRow(input: CreateExpectedPartInput, id: string): ExpectedPart {
  return {
    id,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

type OnStage = (stage: 'sourcing_references' | 'comparing') => void;
const identifyListingParts = vi.fn<[Listing, unknown, OnStage | undefined], Promise<IdentifyPartsResponse>>();
vi.mock('../src/ai/partIdentification.js', () => ({
  identifyListingParts: (...args: [Listing, unknown, OnStage | undefined]) => identifyListingParts(...args),
}));

let activeHandle: { stop(): void } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  claimNextQueuedJob.mockResolvedValue(null);
  resetOrphanedJobsToQueued.mockResolvedValue([]);
  getListingById.mockResolvedValue(null);
  listExpectedPartsByListing.mockResolvedValue([]);
  deleteExpectedPart.mockResolvedValue(undefined);
  triggerPriceLookups.mockResolvedValue(undefined);
  let rowCounter = 0;
  createExpectedPart.mockImplementation(async (input) => {
    rowCounter += 1;
    return storedRow(input, `row-${rowCounter}`);
  });
  vi.spyOn(logger, 'info').mockImplementation(() => logger);
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  activeHandle?.stop();
  activeHandle = null;
  vi.restoreAllMocks();
});

describe('persistIdentifiedParts — price pipeline hand-off (Req 1, 3)', () => {
  it('claims a fully-identified part, leaves a half-identified one unclaimed, and triggers once with every saved row', async () => {
    const listing = listingFixture('listing-P');
    claimNextQueuedJob.mockResolvedValueOnce(jobFixture('job-P', 'listing-P')).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue({
      parts: [
        { category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3060', description: 'Card', confidence: 'high', source: 'image', identityCandidates: [] },
        { category: 'Storage', brand: 'Samsung', partNumber: null, description: 'NVMe', confidence: 'low', source: 'text', identityCandidates: [] },
        { category: 'RAM', brand: null, partNumber: null, description: '16GB', confidence: 'low', source: 'text', identityCandidates: [] },
      ],
      notes: 'done',
    });

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1));

    const inserts = createExpectedPart.mock.calls.map(([input]) => input);
    expect(inserts).toHaveLength(3);
    // Req 1: brand + part number both known -> the pipeline owns the price.
    expect(inserts.find((i) => i.componentCategory === 'GPU')?.priceSource).toBe('auto');
    // Req 3: a part missing either half is never auto-researched, so it is
    // never claimed either.
    expect(inserts.find((i) => i.componentCategory === 'Storage')?.priceSource).toBeNull();
    expect(inserts.find((i) => i.componentCategory === 'RAM')?.priceSource).toBeNull();

    // One hand-off, after every row is in, carrying the stored rows (not the
    // model's raw output) — the trigger reads each row's own fields.
    expect(triggerPriceLookups).toHaveBeenCalledTimes(1);
    const handedOver = triggerPriceLookups.mock.calls[0][0];
    expect(handedOver.map((part) => part.componentCategory).sort()).toEqual(['GPU', 'RAM', 'Storage']);
    expect(handedOver.find((part) => part.componentCategory === 'GPU')?.priceSource).toBe('auto');
  });

  // The job must not report success over a hand-off that never happened:
  // persistIdentifiedParts awaits the trigger, so a throwing trigger fails
  // the job the same way a failing insert already does.
  it('fails the job rather than completing it when the trigger throws', async () => {
    const listing = listingFixture('listing-Q');
    claimNextQueuedJob.mockResolvedValueOnce(jobFixture('job-Q', 'listing-Q')).mockResolvedValue(null);
    getListingById.mockResolvedValue(listing);
    identifyListingParts.mockResolvedValue({
      parts: [
        { category: 'CPU', brand: 'Intel', partNumber: 'i7-9700K', description: 'Chip', confidence: 'high', source: 'text', identityCandidates: [] },
      ],
      notes: '',
    });
    triggerPriceLookups.mockRejectedValue(new Error('price trigger exploded'));

    activeHandle = startIdentifyPartsWorkerPool();

    await vi.waitFor(() => expect(retryOrFailJob).toHaveBeenCalledTimes(1));
    expect(retryOrFailJob).toHaveBeenCalledWith('job-Q', 'price trigger exploded');
    expect(completeJob).not.toHaveBeenCalled();
  });
});
