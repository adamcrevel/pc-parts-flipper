// @vitest-environment jsdom
//
// Proof for on-demand AI part identification in the Listing form
// (identify-parts-button.tsx + listing-form.tsx): the control is gated on a
// saved Listing id the same way photo upload is, the round trip is visibly
// in-flight while it runs (it really can take 30s+, so a silent wait would
// read as a dead button), suggestions are *appended* to whatever rows the
// user already has, run-level `notes` surface as a dismissible banner only
// when non-empty, and a failure shows the backend's real message rather than
// an empty result standing in for it.
//
// listings-api is mocked in every test — nothing here touches the network,
// and the mocked identifyListingParts is driven through a manually-resolved
// promise so the "working" state can be observed mid-flight rather than
// inferred. Mounts the real ListingForm with react-dom/client + act(),
// following listings-page.test.tsx's pattern (no RTL in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { CreateListingInput, IdentifyPartsResponse, ListingDetail, Source } from '@pc-parts-flipper/shared';
import { ApiError } from '../src/lib/api-client';
import { ListingForm } from '../src/features/listings/listing-form';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const identifyListingPartsMock = vi.fn();
const uploadListingPhotosMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  identifyListingParts: (...args: unknown[]) => identifyListingPartsMock(...args),
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  identifyListingPartsMock.mockReset();
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

/** Every row's description input, in render order — rows are what identification appends to. */
function descriptionValues(el: HTMLElement): string[] {
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
    const el = await mountForm(undefined);

    expect(findIdentifyButton(el)).toBeUndefined();
    expect(el.textContent).toContain('Save the listing to identify parts with AI.');
    expect(identifyListingPartsMock).not.toHaveBeenCalled();
  });

  it('offers the Identify Parts button in edit mode, where a Listing id exists', async () => {
    const el = await mountForm(savedListing);

    expect(findIdentifyButton(el)).toBeDefined();
    expect(el.textContent).not.toContain('Save the listing to identify parts with AI.');
  });
});

describe('Identify Parts in-flight state', () => {
  it('disables the button and says it is working until the (slow) call resolves', async () => {
    let resolveCall: (value: IdentifyPartsResponse) => void = () => {};
    identifyListingPartsMock.mockReturnValue(
      new Promise<IdentifyPartsResponse>((resolve) => {
        resolveCall = resolve;
      }),
    );

    const el = await mountForm(savedListing);
    const button = findIdentifyButton(el)!;
    expect(button.disabled).toBe(false);

    await act(async () => button.click());

    expect(identifyListingPartsMock).toHaveBeenCalledWith('listing-1');
    const working = findIdentifyButton(el)!;
    expect(working.disabled).toBe(true);
    expect(working.textContent).toBe('Identifying parts…');
    expect(el.textContent).toContain('this can take 30 seconds or more');

    await act(async () => {
      resolveCall({ parts: [], notes: '' });
    });

    // Re-enabled with its resting label once the round trip finishes, so a
    // second identification is possible.
    const settled = findIdentifyButton(el)!;
    expect(settled.disabled).toBe(false);
    expect(settled.textContent).toBe('Identify Parts');
  });
});

describe('Identify Parts results', () => {
  it('appends one AI-suggested row per returned part, keeping the rows that were already there', async () => {
    identifyListingPartsMock.mockResolvedValue(twoPartResponse);
    const el = await mountForm(savedListing);

    expect(descriptionValues(el)).toEqual(['Ryzen 5 5600X']);

    await act(async () => findIdentifyButton(el)!.click());

    // The pre-existing row stays first and intact; the two suggestions are
    // added after it with the categories the response named.
    expect(descriptionValues(el)).toEqual(['Ryzen 5 5600X', 'triple-fan cooler visible', 'Corsair RM750']);
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
    identifyListingPartsMock.mockResolvedValue(twoPartResponse);
    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    // Row 1 is the pre-existing hand-entered part (null/null -> blank).
    // Row 2 carries the identified pair verbatim and, crucially, its brand
    // is 'NVIDIA' rather than its description 'triple-fan cooler visible':
    // a conversion that folded identity back into description, or re-used
    // the description for both fields, fails here.
    expect(brandValues(el)).toEqual(['', 'NVIDIA', '']);
    expect(partNumberValues(el)).toEqual(['', 'RTX 3070', '']);
    // Row 3's nulls stay blank rather than becoming the string 'null' or a
    // copy of its description — the never-guess rule, end to end.
    expect(descriptionValues(el)[2]).toBe('Corsair RM750');
  });

  it('renders non-empty notes as a dismissible banner that the user can clear', async () => {
    identifyListingPartsMock.mockResolvedValue(twoPartResponse);
    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    const banner = el.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('These look like stock photos, not the actual item.');

    const dismiss = banner!.querySelector('button') as HTMLButtonElement;
    await act(async () => dismiss.click());
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it('renders no notes banner when the response notes are empty', async () => {
    identifyListingPartsMock.mockResolvedValue({ parts: twoPartResponse.parts, notes: '' });
    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    // Rows still arrived — this is the empty-notes case, not a failed call.
    expect(descriptionValues(el)).toHaveLength(3);
    expect(el.querySelector('[role="status"]')).toBeNull();
  });
});

describe('Identify Parts failure', () => {
  it('shows the backend error message in an ErrorBanner and adds no rows', async () => {
    identifyListingPartsMock.mockRejectedValue(new ApiError(500, null, 'omp CLI is not logged in'));
    const el = await mountForm(savedListing);

    await act(async () => findIdentifyButton(el)!.click());

    const alerts = Array.from(el.querySelectorAll('[role="alert"]'));
    // Asserts on the message, not merely that *an* alert exists: the form
    // has its own submit-error banner, and a generic fallback string would
    // satisfy a presence-only check while hiding the real cause.
    expect(alerts.some((alert) => alert.textContent === 'omp CLI is not logged in')).toBe(true);
    expect(descriptionValues(el)).toEqual(['Ryzen 5 5600X']);
    expect(findIdentifyButton(el)!.disabled).toBe(false);
  });
});

describe('Identify Parts draft state never reaches the backend', () => {
  it('submits the AI-originated rows as plain ExpectedPartInputs, with no client-only draft fields', async () => {
    identifyListingPartsMock.mockResolvedValue(twoPartResponse);
    const onSubmit = vi.fn(async () => savedListing);
    const el = await mount(<ListingForm initialValue={savedListing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    await act(async () => findIdentifyButton(el)!.click());

    // The AI is not asked to price parts, so the user must supply the two
    // appended rows' values before the form will validate — which is also
    // the only realistic route to submitting a suggestion at all.
    const valueInputs = (Array.from(el.querySelectorAll('input')) as HTMLInputElement[]).filter((input) =>
      input.getAttribute('aria-label')?.endsWith('estimated resale value'),
    );
    await act(async () => {
      setValue(valueInputs[1], '300');
      setValue(valueInputs[2], '70');
    });

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as CreateListingInput;
    // Exact-shape equality, not a key-absence spot check: `aiSuggested`,
    // `aiConfidence` and `aiSource` are editor-only draft state, and a
    // spread-based row→input mapping would quietly carry all three into the
    // request body. toEqual on the whole array is what notices that.
    // Both brand/partNumber shapes appear here: the GPU row sends the
    // identified pair, the CPU and PSU rows send null (not '') for fields
    // nobody filled in.
    expect(payload.expectedParts).toEqual([
      { componentCategory: 'CPU', brand: null, partNumber: null, description: 'Ryzen 5 5600X', estimatedResaleValue: 90, identityCandidates: [] },
      { componentCategory: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3070', description: 'triple-fan cooler visible', estimatedResaleValue: 300, identityCandidates: [] },
      { componentCategory: 'PSU', brand: null, partNumber: null, description: 'Corsair RM750', estimatedResaleValue: 70, identityCandidates: [] },
    ]);
  });

  it('sends a hand-typed brand and part number, and null for one left whitespace-only', async () => {
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
