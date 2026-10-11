// @vitest-environment jsdom
//
// Proof for the `priceSource` threading through the editor (Req 14-15),
// updated by T13 for the three-state field (assumption A22, correcting A8):
// undefined/null = undecided, 'auto' = the background pipeline owns the
// price, 'manual' = the user does. A cached, auto-priced value must survive
// being round-tripped through the editor untouched, but the instant the
// user edits any field on that row it must become 'manual' — not merely
// cleared, which would read as undecided and let the server re-claim the
// row (and re-fill the price the user had just deleted) on the next save.
//
// Part 1 (expectedPartToRow, via listing-form-state.ts) needs no React
// mounting — it's a plain data-transform function, matching
// listing-form-state.test.ts's own aiConfidence/aiSource precedent.
// Part 2 (updateRow's clear-on-edit) mounts the real ExpectedPartsEditor
// through a tiny stateful harness, matching expected-parts-editor.test.tsx's
// "clears on edit" pattern for the AI-suggested badge, adapted for
// priceSource. Part 3 (persistListing's outgoing payload) mounts the real
// ListingForm and submits it, matching identify-parts.test.tsx's own
// `onSubmit.mock.calls[0][0]` payload-inspection pattern.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
import type { CreateListingInput, ExpectedPart, ListingDetail, Source } from '@pc-parts-flipper/shared';
import { initialExpectedPartRows } from '../src/features/listings/listing-form-state';
import { ExpectedPartsEditor, type ExpectedPartRow, type ExpectedPartRowErrors } from '../src/features/listings/expected-parts-editor';
import { ListingForm } from '../src/features/listings/listing-form';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchLatestIdentifyPartsJobMock = vi.fn();

// ListingForm mounts IdentifyPartsButton, which calls
// fetchLatestIdentifyPartsJob on mount to resume any non-terminal job —
// mocked here (resolving to null, no job to resume) purely so Part 3's
// mount doesn't hit the real network, matching identify-parts.test.tsx's
// own mocking of this module.
vi.mock('@/features/listings/listings-api', () => ({
  enqueueIdentifyPartsJob: vi.fn(),
  fetchIdentifyPartsJob: vi.fn(),
  fetchLatestIdentifyPartsJob: (...args: unknown[]) => fetchLatestIdentifyPartsJobMock(...args),
  fetchListing: vi.fn(),
  ackIdentifyPartsJob: vi.fn(),
  uploadListingPhotos: vi.fn(),
}));

function makeExpectedPart(overrides: Partial<ExpectedPart> = {}): ExpectedPart {
  return {
    id: 'part-1',
    listingId: 'listing-1',
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'pulled from a working rig',
    estimatedResaleValue: 300,
    identityCandidates: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

function makeListingDetail(expectedParts: ExpectedPart[]): ListingDetail {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Test Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comparison: { totalExpectedResaleValue: 300, totalCost: 100, difference: 200 },
    expectedParts,
  };
}

describe('expectedPartToRow reads priceSource off the persisted part', () => {
  it('carries priceSource: "auto" onto the row for a part the cache auto-priced', () => {
    const rows = initialExpectedPartRows(makeListingDetail([makeExpectedPart({ priceSource: 'auto' })]));
    expect(rows[0].priceSource).toBe('auto');
  });

  // Without this, a row the user took over would reopen as undecided and be
  // re-claimed by the server on the very next save — the A22 bug, reached
  // through a reload rather than through a single edit.
  it('carries priceSource: "manual" onto the row for a part the user has taken over', () => {
    const rows = initialExpectedPartRows(makeListingDetail([makeExpectedPart({ priceSource: 'manual' })]));
    expect(rows[0].priceSource).toBe('manual');
  });

  it('leaves priceSource undefined for a part with no priceSource claim', () => {
    const rows = initialExpectedPartRows(makeListingDetail([makeExpectedPart({ priceSource: null })]));
    expect(rows[0].priceSource).toBeUndefined();
  });

  it('leaves priceSource undefined for a part that omits the field entirely', () => {
    const rows = initialExpectedPartRows(makeListingDetail([makeExpectedPart()]));
    expect(rows[0].priceSource).toBeUndefined();
  });
});

// Part 2: updateRow hands an auto row's price to the user on any edit.
let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
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

function inputsLabelled(el: HTMLElement, suffix: string): HTMLInputElement[] {
  return (Array.from(el.querySelectorAll('input')) as HTMLInputElement[]).filter((input) => input.getAttribute('aria-label')?.endsWith(suffix));
}

// Holds the rows in state so the controlled editor's onChange actually
// round-trips, exactly as ListingForm's own `setRows` does. Also renders
// each row's current `priceSource` into a plain-text <output> element —
// ExpectedPartsEditor itself renders no visible priceSource indicator (no
// badge, unlike aiSuggested), so this is the only way a test can observe
// updateRow's clearing of it directly, rather than inferring it indirectly
// through a DOM input's own value.
function EditorHarness({ initialRows, rowErrors = [] }: { initialRows: ExpectedPartRow[]; rowErrors?: ExpectedPartRowErrors[] }) {
  const [rows, setRows] = useState<ExpectedPartRow[]>(initialRows);
  return (
    <div>
      <ExpectedPartsEditor rows={rows} rowErrors={rowErrors} onChange={setRows} />
      <output data-testid="price-sources">{rows.map((row) => row.priceSource ?? 'none').join(',')}</output>
    </div>
  );
}

function autoPricedRow(overrides: Partial<ExpectedPartRow> = {}): ExpectedPartRow {
  return {
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'pulled from a working rig',
    notes: '',
    estimatedResaleValue: '300',
    identityCandidates: [],
    priceSource: 'auto',
    ...overrides,
  };
}

describe('ExpectedPartsEditor updateRow flips priceSource to manual on edit', () => {
  it('flips priceSource from auto to manual the moment the row description is edited', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow()]} />);
    const descriptionInput = inputsLabelled(el, 'description')[0];

    expect(el.querySelector('output')!.textContent).toBe('auto');
    await act(async () => setValue(descriptionInput, 'slightly scuffed shroud'));

    expect(inputsLabelled(el, 'description')[0].value).toBe('slightly scuffed shroud');
    expect(el.querySelector('output')!.textContent).toBe('manual');
  });

  it('flips priceSource to manual when the row category is edited instead of its text', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow()]} />);
    const select = el.querySelector('select') as HTMLSelectElement;

    await act(async () => setValue(select, 'Motherboard'));

    expect(select.value).toBe('Motherboard');
    expect(el.querySelector('output')!.textContent).toBe('manual');
  });

  // The case the whole three-state field exists for: deleting the
  // auto-filled price is itself an edit, so the row becomes the user's. If
  // this cleared to undecided instead, the next save would re-claim the row
  // and the server would put the cached price straight back.
  it('flips priceSource to manual when the user clears the auto-filled price itself', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow()]} />);
    const valueInput = inputsLabelled(el, 'estimated resale value')[0];

    await act(async () => setValue(valueInput, ''));

    expect(inputsLabelled(el, 'estimated resale value')[0].value).toBe('');
    expect(el.querySelector('output')!.textContent).toBe('manual');
  });

  // The rule is specifically "an auto row becomes the user's". A row that
  // was never auto-managed has nothing to take over, so editing it must not
  // invent a claim out of an undecided row.
  it('leaves an undecided row undecided when it is edited', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow({ priceSource: undefined })]} />);
    const descriptionInput = inputsLabelled(el, 'description')[0];

    expect(el.querySelector('output')!.textContent).toBe('none');
    await act(async () => setValue(descriptionInput, 'edited'));

    expect(inputsLabelled(el, 'description')[0].value).toBe('edited');
    expect(el.querySelector('output')!.textContent).toBe('none');
  });

  it('leaves an already-manual row manual when it is edited again', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow({ priceSource: 'manual' })]} />);
    const descriptionInput = inputsLabelled(el, 'description')[0];

    await act(async () => setValue(descriptionInput, 'edited again'));

    expect(inputsLabelled(el, 'description')[0].value).toBe('edited again');
    expect(el.querySelector('output')!.textContent).toBe('manual');
  });

  // MF1 regression: a price the user types himself (a row that was never
  // 'auto') and then clears must not silently fall back to 'undecided' —
  // that would let the server re-claim and re-fill it from the shared
  // cache on the very next save, identically to the never-claimed case.
  it('flips a never-auto row to manual when its price is typed then cleared', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow({ priceSource: undefined, estimatedResaleValue: '' })]} />);
    const valueInput = inputsLabelled(el, 'estimated resale value')[0];

    expect(el.querySelector('output')!.textContent).toBe('none');
    await act(async () => setValue(valueInput, '250'));
    await act(async () => setValue(inputsLabelled(el, 'estimated resale value')[0], ''));

    expect(inputsLabelled(el, 'estimated resale value')[0].value).toBe('');
    expect(el.querySelector('output')!.textContent).toBe('manual');
  });

  it('leaves a second, untouched auto-priced row alone when only the first is edited', async () => {
    const el = await mount(<EditorHarness initialRows={[autoPricedRow(), autoPricedRow({ componentCategory: 'PSU', brand: 'Corsair', partNumber: 'RM750', description: 'boxed' })]} />);
    const descriptionInputs = inputsLabelled(el, 'description');

    expect(el.querySelector('output')!.textContent).toBe('auto,auto');
    await act(async () => setValue(descriptionInputs[0], 'edited'));

    expect(descriptionInputs[0].value).toBe('edited');
    expect(inputsLabelled(el, 'description')[1].value).toBe('boxed');
    // Row identity matters: only index 0 changed hands, index 1 is still 'auto'.
    expect(el.querySelector('output')!.textContent).toBe('manual,auto');
  });
});

// Part 3: persistListing's outgoing payload (mounted ListingForm, real submit).
const sources: Source[] = [
  { id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
];

function listingWithParts(expectedParts: ExpectedPart[]): ListingDetail {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Gaming PC bundle',
    description: 'Ryzen build',
    listingUrl: 'https://example.com/item/1',
    askingPrice: 400,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comparison: { totalExpectedResaleValue: 300, totalCost: 400, difference: -100 },
    expectedParts,
  };
}

beforeEach(() => {
  fetchLatestIdentifyPartsJobMock.mockResolvedValue(null);
});

afterEach(() => {
  fetchLatestIdentifyPartsJobMock.mockReset();
});

describe('ListingForm persistListing sends priceSource for Expected Parts', () => {
  it('sends priceSource: "auto" for an untouched auto-priced row', async () => {
    const listing = listingWithParts([makeExpectedPart({ priceSource: 'auto' })]);
    const onSubmit = vi.fn(async () => listing);
    const el = await mount(<ListingForm initialValue={listing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as CreateListingInput;
    expect(payload.expectedParts[0].priceSource).toBe('auto');
  });

  // The wire-level half of the A22 fix: the edited row must go out as an
  // explicit 'manual' claim. Sending null here would tell the server
  // "undecided", and the server would re-claim the row for the pipeline.
  it('sends priceSource: "manual" for an auto-priced row the user has since edited', async () => {
    const listing = listingWithParts([makeExpectedPart({ priceSource: 'auto' })]);
    const onSubmit = vi.fn(async () => listing);
    const el = await mount(<ListingForm initialValue={listing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    const brandInput = inputsLabelled(el, 'brand')[0];
    await act(async () => setValue(brandInput, 'ASUS'));

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as CreateListingInput;
    expect(payload.expectedParts[0].priceSource).toBe('manual');
  });

  // Reopening a Listing whose row the user took over in an earlier session:
  // the claim must survive the round trip, not decay back to undecided.
  it('sends priceSource: "manual" for an untouched row the user had already taken over', async () => {
    const listing = listingWithParts([makeExpectedPart({ priceSource: 'manual' })]);
    const onSubmit = vi.fn(async () => listing);
    const el = await mount(<ListingForm initialValue={listing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as CreateListingInput;
    expect(payload.expectedParts[0].priceSource).toBe('manual');
  });

  it('sends priceSource: null for a row nobody has claimed', async () => {
    const listing = listingWithParts([makeExpectedPart({ priceSource: null })]);
    const onSubmit = vi.fn(async () => listing);
    const el = await mount(<ListingForm initialValue={listing} sources={sources} onSubmit={onSubmit} onCancel={() => {}} onSaved={() => {}} />);

    const form = el.querySelector('form') as HTMLFormElement;
    await act(async () => form.requestSubmit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as CreateListingInput;
    expect(payload.expectedParts[0].priceSource).toBeNull();
  });
});
