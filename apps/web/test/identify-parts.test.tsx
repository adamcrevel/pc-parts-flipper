// @vitest-environment jsdom
//
// Proof for async on-demand AI part identification in the Listing form
// (identify-parts-button.tsx + listing-form.tsx): the control is gated on a
// saved Listing id the same way photo upload is, the enqueue is visibly
// in-flight and shows per-stage progress while it runs, suggestions are
// *appended* to whatever rows the user already has, run-level `notes` surface
// as a dismissible banner only when non-empty, a failure shows the backend's
// real message, 409 conflicts on enqueue are recovered by resuming the active
// job, and mount resumes any existing non-terminal job.
//
// listings-api is mocked in every test — nothing here touches the network.
// Mounts the real ListingForm with react-dom/client + act(), following
// listings-page.test.tsx's pattern (no RTL in this workspace).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { CreateListingInput, ExpectedPart, IdentifyPartsJob, IdentifyPartsResponse, ListingDetail, Source } from '@pc-parts-flipper/shared';
import { ApiError } from '../src/lib/api-client';
import { ListingForm } from '../src/features/listings/listing-form';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const enqueueIdentifyPartsJobMock = vi.fn();
const fetchIdentifyPartsJobMock = vi.fn();
const fetchLatestIdentifyPartsJobMock = vi.fn();
const fetchListingMock = vi.fn();
const ackIdentifyPartsJobMock = vi.fn();
const uploadListingPhotosMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  enqueueIdentifyPartsJob: (...args: unknown[]) => enqueueIdentifyPartsJobMock(...args),
  fetchIdentifyPartsJob: (...args: unknown[]) => fetchIdentifyPartsJobMock(...args),
  fetchLatestIdentifyPartsJob: (...args: unknown[]) => fetchLatestIdentifyPartsJobMock(...args),
  fetchListing: (...args: unknown[]) => fetchListingMock(...args),
  ackIdentifyPartsJob: (...args: unknown[]) => ackIdentifyPartsJobMock(...args),
  uploadListingPhotos: (...args: unknown[]) => uploadListingPhotosMock(...args),
}));

const sources: Source[] = [
  {
    id: 'source-1',
    name: 'Test Source',
    platformType: 'ebay',
    url: null,
    notes: null,
    active: true,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  },
];

// A saved Listing with one hand-entered Expected Part, so "append, never
// replace" has something pre-existing to preserve.
const savedListing: ListingDetail = {
  id: 'listing-1',
  sourceId: 'source-1',
  title: 'Gaming PC bundle',
  description: 'Ryzen build',
  listingUrl: 'https://example.com/item/1',
  askingPrice: 400,
  listingDate: '2024-01-01',
  status: 'open',
  acquisitionFees: 0,
  photoPaths: ['photos/listing-1-aaaa.jpg'],
  externalSource: null,
  externalItemId: null,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  comparison: { totalExpectedResaleValue: 90, totalCost: 400, difference: -310 },
  expectedParts: [
    {
      id: 'part-1',
      listingId: 'listing-1',
      componentCategory: 'CPU',
      // Hand-entered and never identified further: nulls here are what the
      // editor must render as blank inputs.
      brand: null,
      partNumber: null,
      description: 'Ryzen 5 5600X',
      estimatedResaleValue: 90,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  ],
};

// The second part deliberately carries null brand/partNumber: the model is
// told to leave them null rather than guess, so both the identified and the
// unidentified shape have to survive the trip into the editor.
const twoPartResponse: IdentifyPartsResponse = {
  parts: [
    { category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3070', description: 'triple-fan cooler visible', confidence: 'high', source: 'image' },
    { category: 'PSU', brand: null, partNumber: null, description: 'Corsair RM750', confidence: 'medium', source: 'text' },
  ],
  notes: 'These look like stock photos, not the actual item.',
};

// What `fetchListing` returns once the server has already persisted
// `twoPartResponse.parts` into `expected_parts` — real rows with ids, on
// top of the pre-existing hand-entered one. The identify-parts flow never
// submits anything itself; it reads this back after a job completes
// (apps/server/src/jobs/identifyPartsWorkerPool.ts is what actually wrote
// these rows, server-side, independent of any client).
const listingAfterIdentification: ListingDetail = {
  ...savedListing,
  expectedParts: [
    ...savedListing.expectedParts,
    {
      id: 'part-2',
      listingId: 'listing-1',
      componentCategory: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      description: 'triple-fan cooler visible',
      estimatedResaleValue: null,
      identityCandidates: [],
      aiConfidence: 'high',
      aiSource: 'image',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
    {
      id: 'part-3',
      listingId: 'listing-1',
      componentCategory: 'PSU',
      brand: null,
      partNumber: null,
      description: 'Corsair RM750',
      estimatedResaleValue: null,
      identityCandidates: [],
      aiConfidence: 'medium',
      aiSource: 'text',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  ],
};

// T9's pricing-status poll loop (Req 16/A16): a single appended part the
// identify-parts job marked `priceSource: 'auto'` because it came back
// with both brand and part number, with no price yet — exactly the shape
// `applyTerminalJob` checks for to decide whether to start polling at all.
const unpricedAutoPart: ExpectedPart = {
  id: 'part-2',
  listingId: 'listing-1',
  componentCategory: 'GPU',
  brand: 'NVIDIA',
  partNumber: 'RTX 3070',
  description: 'triple-fan cooler visible',
  estimatedResaleValue: null,
  identityCandidates: [],
  aiConfidence: 'high',
  aiSource: 'image',
  priceSource: 'auto',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
};

const listingWithUnpricedPart: ListingDetail = {
  ...savedListing,
  expectedParts: [...savedListing.expectedParts, unpricedAutoPart],
};

// What a later pricing-poll fetch returns once the background pipeline
// has filled the value in: same part, now priced.
const listingWithPricedPart: ListingDetail = {
  ...savedListing,
  expectedParts: [savedListing.expectedParts[0], { ...unpricedAutoPart, estimatedResaleValue: 275 }],
};

// Sample job at various stages for testing.
function makeQueuedJob(): IdentifyPartsJob {
  return {
    id: 'job-1',
    listingId: 'listing-1',
    stage: 'queued',
    parts: null,
    notes: null,
    errorMessage: null,
    delivered: false,
    createdAt: '2024-01-01T12:00:00Z',
    startedAt: null,
    completedAt: null,
  };
}

function makeIdentifyingJob(): IdentifyPartsJob {
  return { ...makeQueuedJob(), stage: 'identifying', startedAt: '2024-01-01T12:00:01Z' };
}

function makeSourcingReferencesJob(): IdentifyPartsJob {
  return { ...makeQueuedJob(), stage: 'sourcing_references', startedAt: '2024-01-01T12:00:01Z' };
}

function makeComparingJob(): IdentifyPartsJob {
  return { ...makeQueuedJob(), stage: 'comparing', startedAt: '2024-01-01T12:00:01Z' };
}

function makeCompletedJob(parts: typeof twoPartResponse.parts = [], notes: string = ''): IdentifyPartsJob {
  return {
    id: 'job-1',
    listingId: 'listing-1',
    stage: 'completed',
    parts,
    notes: notes.length > 0 ? notes : null,
    errorMessage: null,
    delivered: false,
    createdAt: '2024-01-01T12:00:00Z',
    startedAt: '2024-01-01T12:00:01Z',
    completedAt: '2024-01-01T12:00:30Z',
  };
}

function makeFailedJob(errorMessage: string = 'Job failed'): IdentifyPartsJob {
  return {
    id: 'job-1',
    listingId: 'listing-1',
    stage: 'failed',
    parts: null,
    notes: null,
    errorMessage,
    delivered: false,
    createdAt: '2024-01-01T12:00:00Z',
    startedAt: '2024-01-01T12:00:01Z',
    completedAt: '2024-01-01T12:00:30Z',
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  enqueueIdentifyPartsJobMock.mockReset();
  fetchIdentifyPartsJobMock.mockReset();
  fetchLatestIdentifyPartsJobMock.mockReset();
  fetchListingMock.mockReset();
  ackIdentifyPartsJobMock.mockReset();
  uploadListingPhotosMock.mockReset();
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (input instanceof HTMLInputElement && setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Mounts ListingForm in edit mode (saved Listing) or create mode (`undefined`). */
async function mountForm(initialValue?: ListingDetail): Promise<HTMLDivElement> {
  return mount(
    <ListingForm initialValue={initialValue} sources={sources} onSubmit={async () => savedListing} onCancel={() => {}} onSaved={() => {}} />,
  );
}

function findIdentifyButton(el: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Identify') || b.textContent === 'Identifying parts…');
}

/** The "Pricing N part(s)…" status paragraph (T9), or undefined if none is shown. */
function findPricingStatus(el: HTMLElement): HTMLParagraphElement | undefined {
  return (Array.from(el.querySelectorAll('p')) as HTMLParagraphElement[]).find((p) => p.textContent?.startsWith('Pricing'));
}

// Every row's description input, in render order. Expands any row that
// started collapsed first (T3's per-row CollapsibleSection: every row
// seeded from already-saved data starts collapsed, with no exception for
// an unreviewed AI suggestion) — this helper's contract is "every row's
// description value", which requires each row open to read at all. Clicks
// one trigger at a time, re-querying after each: ExpectedPartsEditor's
// toggleRowCollapsed calls the non-functional `onChange(rows.map(...))`,
// so two clicks batched into the same tick (no render between them) would
// each build their replacement array from the same stale `rows` closure
// and the second click's result would clobber the first's.
async function descriptionValues(el: HTMLElement): Promise<string[]> {
  let collapsedTriggers = Array.from(el.querySelectorAll('button[aria-expanded="false"]')) as HTMLButtonElement[];
  while (collapsedTriggers.length > 0) {
    await act(async () => {
      collapsedTriggers[0].click();
    });
    collapsedTriggers = Array.from(el.querySelectorAll('button[aria-expanded="false"]')) as HTMLButtonElement[];
  }
  const inputs = Array.from(el.querySelectorAll('input')).filter((input) => input.getAttribute('aria-label')?.endsWith('description'));
  return inputs.map((input) => input.value);
}

/** Every row's category <select> value, in render order. */
function categoryValues(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('select'))
    .filter((select) => select.getAttribute('aria-label')?.endsWith('category'))
    .map((select) => select.value);
}

/** Every row's brand input value, in render order. */
function brandValues(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('input'))
    .filter((input) => input.getAttribute('aria-label')?.endsWith('brand'))
    .map((input) => input.value);
}

/** Every row's part number input value, in render order. */
function partNumberValues(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('input'))
    .filter((input) => input.getAttribute('aria-label')?.endsWith('part number'))
    .map((input) => input.value);
}

describe('Identify Parts gating on a saved Listing', () => {
  it('offers no Identify Parts control in create mode, showing the save-first hint instead', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    const el = await mountForm(undefined);

    expect(findIdentifyButton(el)).toBeUndefined();
    expect(el.textContent).toContain('Save the listing to identify parts with AI.');
    expect(enqueueIdentifyPartsJobMock).not.toHaveBeenCalled();
  });

  it('offers the Identify Parts button in edit mode, where a Listing id exists', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    const el = await mountForm(savedListing);

    expect(findIdentifyButton(el)).toBeDefined();
    expect(el.textContent).not.toContain('Save the listing to identify parts with AI.');
  });
});

describe('Identify Parts in-flight state', () => {
  it('disables the button and shows per-stage progress messages until the job completes', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeIdentifyingJob());

    const el = await mountForm(savedListing);
    const button = findIdentifyButton(el)!;
    expect(button.disabled).toBe(false);

    await act(async () => button.click());

    expect(enqueueIdentifyPartsJobMock).toHaveBeenCalledWith('listing-1');
    const workingButton = findIdentifyButton(el)!;
    expect(workingButton.disabled).toBe(true);
    expect(workingButton.textContent).toBe('Identifying parts…');
    // The queued job's message should be visible.
    expect(el.textContent).toContain('Waiting to run…');

    // Advance past the first poll (2000ms) to get the identifying stage update.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Now the identifying message should be visible.
    expect(el.textContent).toContain('Reading the listing text and photos with AI…');

    // Move to completion.
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Button should be re-enabled once the job completes.
    const settled = findIdentifyButton(el)!;
    expect(settled.disabled).toBe(false);
    expect(settled.textContent).toBe('Identify Parts');
    expect(ackIdentifyPartsJobMock).toHaveBeenCalledTimes(1);
  });

  it('renders distinct, stage-specific copy for each of the four non-terminal stages, never a generic "in progress" message (Req 9)', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeIdentifyingJob());

    const el = await mountForm(savedListing);
    await act(async () => findIdentifyButton(el)!.click());

    // queued: shown immediately on enqueue, before any poll has fired.
    expect(el.textContent).toContain('Waiting to run…');
    expect(el.textContent).not.toContain('Reading the listing text and photos with AI…');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // identifying: its own message replaces queued's, not alongside it.
    expect(el.textContent).toContain('Reading the listing text and photos with AI…');
    expect(el.textContent).not.toContain('Waiting to run…');
    expect(el.textContent).not.toContain('Sourcing reference photos from manufacturer sites…');

    fetchIdentifyPartsJobMock.mockResolvedValue(makeSourcingReferencesJob());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // sourcing_references: a case this suite had never exercised before.
    expect(el.textContent).toContain('Sourcing reference photos from manufacturer sites…');
    expect(el.textContent).not.toContain('Reading the listing text and photos with AI…');
    expect(el.textContent).not.toContain('Comparing photos against reference images…');

    fetchIdentifyPartsJobMock.mockResolvedValue(makeComparingJob());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // comparing: likewise never exercised before, and distinct from its neighbor.
    expect(el.textContent).toContain('Comparing photos against reference images…');
    expect(el.textContent).not.toContain('Sourcing reference photos from manufacturer sites…');
  });
});

describe('Identify Parts results', () => {
  it('appends one AI-suggested row per returned part, keeping the rows that were already there', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);

    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X']);

    await act(async () => findIdentifyButton(el)!.click());

    // Advance to poll and complete the job.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The pre-existing row stays first and intact; the two suggestions are
    // added after it with the categories the response named.
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X', 'triple-fan cooler visible', 'Corsair RM750']);
    expect(categoryValues(el)).toEqual(['CPU', 'GPU', 'PSU']);

    // Only the two appended rows are badged — the user's own row is not.
    const badges = Array.from(el.querySelectorAll('span')).filter((span) => span.textContent === 'AI suggested');
    expect(badges).toHaveLength(2);

    // The model is never asked to price parts, so the appended rows leave
    // the estimated resale value for the user to fill in.
    const valueInputs = Array.from(el.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    expect(valueInputs.map((input) => input.value).slice(-2)).toEqual(['', '']);
  });

  it('fills each suggested row\'s brand and part number from those response fields, not from its description', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Row 1 is the pre-existing hand-entered part (null/null -> blank).
    // Row 2 carries the identified pair verbatim and, crucially, its brand
    // is 'NVIDIA' rather than its description 'triple-fan cooler visible':
    // a conversion that folded identity back into description, or re-used
    // the description for both fields, fails here.
    expect(brandValues(el)).toEqual(['', 'NVIDIA', '']);
    expect(partNumberValues(el)).toEqual(['', 'RTX 3070', '']);
    // Row 3's nulls stay blank rather than becoming the string 'null' or a
    // copy of its description — the never-guess rule, end to end.
    expect((await descriptionValues(el))[2]).toBe('Corsair RM750');
  });

  it('renders non-empty notes as a dismissible banner that the user can clear', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const banner = el.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('These look like stock photos, not the actual item.');

    const dismiss = banner!.querySelector('button') as HTMLButtonElement;
    await act(async () => dismiss.click());
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it('renders no notes banner when the response notes are empty', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, ''));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Rows still arrived — this is the empty-notes case, not a failed call.
    expect(await descriptionValues(el)).toHaveLength(3);
    expect(el.querySelector('[role="status"]')).toBeNull();
  });
});

describe('Identify Parts failure', () => {
  it('shows the backend error message in an ErrorBanner and adds no rows', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeFailedJob('omp CLI is not logged in'));

    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const alerts = Array.from(el.querySelectorAll('[role="alert"]'));
    // Asserts on the message, not merely that *an* alert exists: the form
    // has its own submit-error banner, and a generic fallback string would
    // satisfy a presence-only check while hiding the real cause.
    expect(alerts.some((alert) => alert.textContent === 'omp CLI is not logged in')).toBe(true);
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X']);
    expect(findIdentifyButton(el)!.disabled).toBe(false);
    expect(ackIdentifyPartsJobMock).toHaveBeenCalledTimes(1);
  });
});

describe('Identify Parts 409 conflict recovery', () => {
  it('fetches and resumes the active job when enqueue returns 409', async () => {
    // Mount's own resume lookup must see no active job (call #1 = null);
    // only the post-409 recovery lookup (call #2) should find the active
    // job — two chained `mockResolvedValueOnce`s pin that order explicitly,
    // rather than a bare default that the mount call would consume first.
    fetchLatestIdentifyPartsJobMock.mockResolvedValueOnce(null);
    enqueueIdentifyPartsJobMock.mockRejectedValue(new ApiError(409, null, 'A job is already active for this listing'));
    const activeJob = makeIdentifyingJob();
    fetchLatestIdentifyPartsJobMock.mockResolvedValueOnce(activeJob);
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);
    const button = findIdentifyButton(el)!;

    await act(async () => button.click());

    // Should show the info message about already identifying.
    expect(el.textContent).toContain('Already identifying this listing\'s parts');
    // Req 14: the button must be disabled the moment a 409 reveals an
    // active job, not only once that job is later found via mount or just
    // enqueued by this same click.
    expect(findIdentifyButton(el)!.disabled).toBe(true);

    // Advance to poll and complete.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Job completion re-fetches the Listing and reflects what the server
    // already saved, not a locally reconstructed copy.
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X', 'triple-fan cooler visible', 'Corsair RM750']);
    expect(ackIdentifyPartsJobMock).toHaveBeenCalledTimes(1);
  });
});

describe('Identify Parts mount resume', () => {
  it('resumes polling a non-terminal job found on mount', async () => {
    const existingJob = makeIdentifyingJob();
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(existingJob);
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);

    // Button should be disabled immediately because there's a non-terminal job.
    expect(findIdentifyButton(el)!.disabled).toBe(true);

    // Advance to poll and complete.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // Job completion re-fetches the Listing and reflects what the server
    // already saved, not a locally reconstructed copy.
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X', 'triple-fan cooler visible', 'Corsair RM750']);
    expect(ackIdentifyPartsJobMock).toHaveBeenCalledTimes(1);
  });

  it('applies a terminal undelivered job found on mount without polling', async () => {
    const terminalJob = makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes);
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(terminalJob);
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const el = await mountForm(savedListing);

    // Should apply immediately without needing to poll.
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X', 'triple-fan cooler visible', 'Corsair RM750']);
    expect(ackIdentifyPartsJobMock).toHaveBeenCalledTimes(1);
    expect(fetchIdentifyPartsJobMock).not.toHaveBeenCalled();
  });

  it('does not re-apply, re-fetch, or re-acknowledge a terminal job already marked delivered (Req 11)', async () => {
    // The job completed and was applied on a prior mount (or the same
    // mount, earlier) — the server already has `delivered: true` for it.
    // Reopening the listing must not re-fetch or re-display the same two
    // suggestions again, and must not ack a job that was already acked.
    const alreadyDeliveredJob = { ...makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes), delivered: true };
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(alreadyDeliveredJob);

    const el = await mountForm(savedListing);

    // Only the one hand-entered row from before — the two AI suggestions
    // from this already-delivered job were never re-displayed a second time.
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X']);
    expect(fetchListingMock).not.toHaveBeenCalled();
    expect(ackIdentifyPartsJobMock).not.toHaveBeenCalled();
    expect(fetchIdentifyPartsJobMock).not.toHaveBeenCalled();
  });
});

describe('Identify Parts results are saved server-side, never via a form submit', () => {
  it('never calls onSubmit when a job completes — the server already persisted the parts before the UI ever saw "completed"', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, twoPartResponse.notes));
    fetchListingMock.mockResolvedValue(listingAfterIdentification);

    const onSubmit = vi.fn(async () => savedListing);
    const el = await mount(<ListingForm initialValue={savedListing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // apps/server/src/jobs/identifyPartsWorkerPool.ts inserts every
    // identified part directly into expected_parts the instant the job
    // completes — this component only ever reads that back (fetchListing),
    // it never submits a save of its own. A regression here (going back to
    // a client-side auto-save) would make onSubmit fire once.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchListingMock).toHaveBeenCalledWith('listing-1');
    // The displayed rows still reflect exactly what the server returned.
    expect(await descriptionValues(el)).toEqual(['Ryzen 5 5600X', 'triple-fan cooler visible', 'Corsair RM750']);
  });
});

describe('Manual Save still strips client-only draft fields', () => {
  it('sends a hand-typed brand and part number, and null for one left whitespace-only', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    const onSubmit = vi.fn(async () => savedListing);
    const el = await mount(<ListingForm initialValue={savedListing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    const brandInput = (Array.from(el.querySelectorAll('input')) as HTMLInputElement[]).find((input) => input.getAttribute('aria-label')?.endsWith('brand'))!;
    const partNumberInput = (Array.from(el.querySelectorAll('input')) as HTMLInputElement[]).find(
      (input) => input.getAttribute('aria-label')?.endsWith('part number'),
    )!;
    await act(async () => {
      setValue(brandInput, '  AMD  ');
      // Whitespace-only is still "not identified": it must not survive as a
      // ' ' string, which a `row.partNumber || null` without the trim would
      // let through.
      setValue(partNumberInput, '   ');
    });

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as CreateListingInput;
    expect(payload.expectedParts[0].brand).toBe('AMD');
    expect(payload.expectedParts[0].partNumber).toBeNull();
  });
});

// T9: identify-parts-button.tsx's second poll loop (Req 16, A16) — the
// status text keeps reporting progress past the identify-parts job's own
// completion until every part it triggered pricing for has resolved, and
// every tick also pushes the freshly-fetched values back into the parent
// via onPartsSaved, not just the status text.
describe('Identify Parts price-research status (Req 16, A16)', () => {
  it('shows "Pricing N part(s)…" once the job completes with a priceSource:auto part still missing a value, and re-fetches the Listing again 2s later', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, ''));
    fetchListingMock
      .mockResolvedValueOnce(listingWithUnpricedPart) // applyTerminalJob's own fetch
      .mockResolvedValueOnce(listingWithUnpricedPart); // first pricing-poll tick: still unpriced

    const el = await mountForm(savedListing);
    await act(async () => findIdentifyButton(el)!.click());

    // t=2000ms: the job-stage poll fires, the job is completed, and
    // applyTerminalJob's own fetchListing (call #1) finds one auto-priced
    // part still null -> starts the pricing-poll loop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(findPricingStatus(el)?.textContent).toBe('Pricing 1 part(s)…');
    expect(fetchListingMock).toHaveBeenCalledTimes(1);

    // t=4000ms: the pricing-poll loop's own 2s interval fires independently
    // of the (already-cleared) job-stage poll and re-fetches the Listing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchListingMock).toHaveBeenCalledTimes(2);
    expect(fetchListingMock).toHaveBeenNthCalledWith(2, 'listing-1');
    expect(findPricingStatus(el)?.textContent).toBe('Pricing 1 part(s)…');
  });

  it('clears the pricing status, and stops polling, once a tick finds zero parts still unpriced', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, ''));
    fetchListingMock
      .mockResolvedValueOnce(listingWithUnpricedPart) // applyTerminalJob's own fetch: still unpriced
      .mockResolvedValueOnce(listingWithPricedPart); // first pricing-poll tick: the price arrived

    const el = await mountForm(savedListing);
    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(findPricingStatus(el)?.textContent).toBe('Pricing 1 part(s)…');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(findPricingStatus(el)).toBeUndefined();

    // The interval was cleared, not merely quiet this tick: a third 2s
    // produces no further fetchListing call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchListingMock).toHaveBeenCalledTimes(2);
  });

  it('gives up silently after 60 polls (2 minutes) if a part never resolves a price, with no error banner', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, ''));
    fetchListingMock.mockResolvedValue(listingWithUnpricedPart); // every call: still unpriced

    const el = await mountForm(savedListing);
    await act(async () => findIdentifyButton(el)!.click());

    // t=2000ms: job completes and starts the 60-poll pricing loop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(findPricingStatus(el)?.textContent).toBe('Pricing 1 part(s)…');

    // 60 pricing-poll ticks, each still finding the part unpriced.
    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }

    expect(findPricingStatus(el)).toBeUndefined();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    // 1 (applyTerminalJob) + 60 (exhausted polls) fetches, then the
    // interval is gone -- a 61st tick produces no further call.
    expect(fetchListingMock).toHaveBeenCalledTimes(61);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchListingMock).toHaveBeenCalledTimes(61);
  });

  it('updates the displayed estimated resale value via onPartsSaved on each pricing-poll tick, not just the status text (A16)', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    enqueueIdentifyPartsJobMock.mockResolvedValue(makeQueuedJob());
    fetchIdentifyPartsJobMock.mockResolvedValue(makeCompletedJob(twoPartResponse.parts, ''));
    fetchListingMock
      .mockResolvedValueOnce(listingWithUnpricedPart)
      .mockResolvedValueOnce(listingWithPricedPart);

    const el = await mountForm(savedListing);
    await act(async () => findIdentifyButton(el)!.click());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const beforePoll = Array.from(el.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    expect(beforePoll[1].value).toBe('');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const afterPoll = Array.from(el.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
    expect(afterPoll[1].value).toBe('275');
  });
});

describe('Identify Parts price-research status — manual save never shows one (Req 17)', () => {
  it('shows no pricing status for a Listing saved without ever clicking Identify Parts', async () => {
    fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
    const onSubmit = vi.fn(async () => savedListing);
    const el = await mount(<ListingForm initialValue={savedListing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(findPricingStatus(el)).toBeUndefined();
    // Not merely absent right now: Identify Parts was never clicked, so
    // startPricingPolling (only ever reachable from applyTerminalJob) was
    // never invoked at all.
    expect(enqueueIdentifyPartsJobMock).not.toHaveBeenCalled();
  });
});
