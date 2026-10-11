// @vitest-environment jsdom
//
// Proof for the AI-suggested draft marking on ExpectedPartsEditor
// (expected-parts-editor.tsx): the "AI suggested" badge is scoped to rows
// carrying `aiSuggested: true`, and any edit to such a row clears it —
// editing a suggestion is how the user reviews/confirms it (product
// decision), so the badge must not survive the first keystroke. Mounts the
// real component through a tiny stateful harness (the editor is fully
// controlled, so without one `onChange` would go nowhere and the "clears on
// edit" case could never be observed), following source-ebay-connector
// .test.tsx's react-dom/client + act() pattern — no RTL in this workspace.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
import { ExpectedPartsEditor, type ExpectedPartRow, type ExpectedPartRowErrors } from '../src/features/listings/expected-parts-editor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

/** Counts rendered "AI suggested" badges — one per still-unreviewed suggestion. */
function badgeCount(el: HTMLElement): number {
  return Array.from(el.querySelectorAll('span')).filter((span) => span.textContent === 'AI suggested').length;
}

/** Every input carrying the given per-row aria-label suffix, in render order. */
function inputsLabelled(el: HTMLElement, suffix: string): HTMLInputElement[] {
  return (Array.from(el.querySelectorAll('input')) as HTMLInputElement[]).filter((input) => input.getAttribute('aria-label')?.endsWith(suffix));
}

// Holds the rows in state so the controlled editor's onChange actually
// round-trips, exactly as ListingForm's own `setRows` does.
function EditorHarness({
  initialRows,
  rowErrors = [],
  isExistingListing,
}: {
  initialRows: ExpectedPartRow[];
  rowErrors?: ExpectedPartRowErrors[];
  isExistingListing?: boolean;
}) {
  const [rows, setRows] = useState<ExpectedPartRow[]>(initialRows);
  return <ExpectedPartsEditor rows={rows} rowErrors={rowErrors} onChange={setRows} isExistingListing={isExistingListing} />;
}

function aiRow(overrides: Partial<ExpectedPartRow> = {}): ExpectedPartRow {
  return {
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'pulled from a working rig',
    notes: '',
    estimatedResaleValue: '',
    identityCandidates: [],
    aiSuggested: true,
    aiConfidence: 'high',
    aiSource: 'image',
    ...overrides,
  };
}

function manualRow(overrides: Partial<ExpectedPartRow> = {}): ExpectedPartRow {
  return {
    componentCategory: 'CPU',
    brand: 'AMD',
    partNumber: 'Ryzen 5 5600X',
    description: 'boxed, with cooler',
    notes: '',
    estimatedResaleValue: '90',
    identityCandidates: [],
    ...overrides,
  };
}

describe('ExpectedPartsEditor AI-suggested badge', () => {
  it('renders the badge only on rows flagged aiSuggested, not on hand-entered rows', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow(), aiRow()]} />);

    // Both halves matter: a badge on every row (gate dropped) and a badge on
    // no row (gate inverted/removed) each fail exactly one of these.
    expect(badgeCount(el)).toBe(1);
    const rowContainers = Array.from(el.querySelectorAll('select')).map((select) => select.closest('div.rounded-md')!);
    expect(rowContainers[0].textContent).not.toContain('AI suggested');
    expect(rowContainers[1].textContent).toContain('AI suggested');
  });

  it('renders no badge at all when every row is hand-entered', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow(), manualRow({ description: 'Corsair RM750' })]} />);
    expect(badgeCount(el)).toBe(0);
  });

  it('shows the suggestion provenance (confidence and evidence) beside the badge', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow({ aiConfidence: 'low', aiSource: 'text' })]} />);
    expect(el.textContent).toContain('low confidence · from the listing text');
  });

  // Each source gets its own case: one shared assertion on 'text' would stay
  // green if the 'image' or 'both' wording were changed or dropped, and the
  // three labels are distinct user-facing claims about what the model saw.
  it('captions an image-sourced suggestion as drawn from the photos', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow({ aiConfidence: 'medium', aiSource: 'image' })]} />);
    expect(el.textContent).toContain('medium confidence · from the photos');
  });

  it('captions a both-sourced suggestion as drawn from the text and the photos', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow({ aiConfidence: 'high', aiSource: 'both' })]} />);
    expect(el.textContent).toContain('high confidence · from the listing text and photos');
  });

  it('drops the badge from a row whose description the user edits, leaving other suggestions marked', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow(), aiRow({ componentCategory: 'RAM', description: '16GB DDR4' })]} />);
    expect(badgeCount(el)).toBe(2);

    const descriptionInputs = inputsLabelled(el, 'description');
    await act(async () => setValue(descriptionInputs[0], 'light coil whine'));

    // Only the edited row is reviewed; the untouched one stays flagged —
    // a blanket clear (or clearing the wrong index) fails here. Row
    // identity, not just the count: the badge must survive on row 2
    // specifically, whose description is untouched.
    expect(badgeCount(el)).toBe(1);
    const rowContainers = Array.from(el.querySelectorAll('select')).map((select) => select.closest('div.rounded-md')!);
    expect(rowContainers[0].textContent).not.toContain('AI suggested');
    expect(rowContainers[1].textContent).toContain('AI suggested');
    expect(inputsLabelled(el, 'description').map((input) => input.value)).toEqual(['light coil whine', '16GB DDR4']);
  });

  it('drops the badge when the user edits the row category instead of its text', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow()]} />);
    const select = el.querySelector('select') as HTMLSelectElement;
    await act(async () => setValue(select, 'Motherboard'));

    expect(badgeCount(el)).toBe(0);
  });

  it('drops the badge when the user fills in the estimated resale value the AI left blank', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow()]} />);
    const valueInput = el.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => setValue(valueInput, '250'));

    expect(badgeCount(el)).toBe(0);
  });
});


describe('ExpectedPartsEditor brand and part number fields', () => {
  it('renders one brand and one part number input per row, seeded from the row state', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow(), aiRow()]} />);

    // Per-row counts, not just "at least one": a single shared input (or an
    // input dropped from the second row's sub-line) fails here.
    expect(inputsLabelled(el, 'brand').map((input) => input.value)).toEqual(['AMD', 'NVIDIA']);
    expect(inputsLabelled(el, 'part number').map((input) => input.value)).toEqual(['Ryzen 5 5600X', 'RTX 3070']);
  });

  it('renders brand and part number as empty inputs on a row that has neither', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ brand: '', partNumber: '' })]} />);

    // The never-guess rule reaching the UI: an unidentified part shows blank
    // fields, not the description or any other stand-in value.
    expect(inputsLabelled(el, 'brand')[0].value).toBe('');
    expect(inputsLabelled(el, 'part number')[0].value).toBe('');
  });

  it('writes a typed brand back into that row only, leaving its sibling row untouched', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow(), manualRow({ brand: 'Intel', partNumber: 'i5-12400' })]} />);

    await act(async () => setValue(inputsLabelled(el, 'brand')[1], 'Corsair'));

    // Both rows asserted: a patch applied to every row (or to the wrong
    // index) changes row 1's value too, which this notices.
    expect(inputsLabelled(el, 'brand').map((input) => input.value)).toEqual(['AMD', 'Corsair']);
    // The sibling field on the edited row must survive the patch — a patch
    // that replaced the row instead of merging into it would blank this.
    expect(inputsLabelled(el, 'part number')[1].value).toBe('i5-12400');
  });

  it('writes a typed part number back into that row only', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow(), manualRow({ brand: 'Intel', partNumber: 'i5-12400' })]} />);

    await act(async () => setValue(inputsLabelled(el, 'part number')[0], '5700X'));

    expect(inputsLabelled(el, 'part number').map((input) => input.value)).toEqual(['5700X', 'i5-12400']);
    expect(inputsLabelled(el, 'brand').map((input) => input.value)).toEqual(['AMD', 'Intel']);
  });

  // Brand and part number get their own badge-clearing cases rather than one
  // shared case: they are separate onChange call sites, and a missing
  // `aiSuggested: false` on either one is invisible to a test that only
  // exercises the other.
  it('drops the badge when the user edits the brand the AI suggested', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow(), aiRow({ componentCategory: 'RAM' })]} />);
    expect(badgeCount(el)).toBe(2);

    await act(async () => setValue(inputsLabelled(el, 'brand')[0], 'EVGA'));

    expect(badgeCount(el)).toBe(1);
    const rowContainers = Array.from(el.querySelectorAll('select')).map((select) => select.closest('div.rounded-md')!);
    expect(rowContainers[0].textContent).not.toContain('AI suggested');
    expect(rowContainers[1].textContent).toContain('AI suggested');
  });

  it('drops the badge when the user edits the part number the AI suggested', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow(), aiRow({ componentCategory: 'RAM' })]} />);
    expect(badgeCount(el)).toBe(2);

    await act(async () => setValue(inputsLabelled(el, 'part number')[0], 'RTX 3070 Ti'));

    expect(badgeCount(el)).toBe(1);
    const rowContainers = Array.from(el.querySelectorAll('select')).map((select) => select.closest('div.rounded-md')!);
    expect(rowContainers[0].textContent).not.toContain('AI suggested');
    expect(rowContainers[1].textContent).toContain('AI suggested');
  });
});

// Radix's CollapsibleTrigger is the only button in a row that carries
// aria-expanded — Remove doesn't, so this reliably finds each row's own
// toggle regardless of how many other buttons the row renders.
function triggerButtons(el: HTMLElement): HTMLButtonElement[] {
  return Array.from(el.querySelectorAll('button[aria-expanded]')) as HTMLButtonElement[];
}

describe('ExpectedPartsEditor collapsible rows (T3)', () => {
  it('a row built with collapsed: true starts closed — identification fields shown, description/badge/picker not mounted', async () => {
    const el = await mount(
      <EditorHarness initialRows={[aiRow({ collapsed: true, identityCandidates: [{ brand: 'NVIDIA', partNumber: 'RTX 3070 Ti' }] })]} />,
    );

    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('false');
    // Identification fields stay mounted and showing their real values even
    // while collapsed — the whole point of keeping them in the trigger
    // rather than CollapsibleContent.
    expect(inputsLabelled(el, 'brand')[0]?.value).toBe('NVIDIA');
    expect(inputsLabelled(el, 'part number')[0]?.value).toBe('RTX 3070');
    // Content-only fields are unmounted while collapsed.
    expect(inputsLabelled(el, 'description')).toHaveLength(0);
    expect(badgeCount(el)).toBe(0);
    expect(el.textContent).not.toContain('Also possible:');
  });

  it('a row built with collapsed: false (or omitted) starts open — description/badge/picker mounted', async () => {
    const el = await mount(<EditorHarness initialRows={[aiRow({ collapsed: false })]} />);

    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('true');
    expect(inputsLabelled(el, 'description')).toHaveLength(1);
    expect(badgeCount(el)).toBe(1);
  });

  it('clicking "Add Part" appends a row that starts expanded, not collapsed', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ collapsed: true })]} />);
    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('false');

    const addButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Add Part') as HTMLButtonElement;
    await act(async () => addButton.click());

    // Row 1 (pre-existing, built collapsed) is untouched; row 2 (new) opens
    // by default — a shared default would make one of these two fail.
    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('false');
    expect(triggerButtons(el)[1].getAttribute('aria-expanded')).toBe('true');
    expect(inputsLabelled(el, 'description')).toHaveLength(1);
  });

  it('clicking a row\'s trigger toggles only that row\'s open state, leaving its sibling untouched', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ collapsed: false }), manualRow({ collapsed: false, brand: 'Intel' })]} />);
    expect(triggerButtons(el).map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'true']);

    await act(async () => triggerButtons(el)[0].click());

    expect(triggerButtons(el).map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });

  it('toggling a row collapsed and back open never clears its aiSuggested flag or any field value', async () => {
    const candidates = [{ brand: 'NVIDIA', partNumber: 'RTX 3080' }];
    const el = await mount(<EditorHarness initialRows={[aiRow({ collapsed: false, identityCandidates: candidates })]} />);
    expect(badgeCount(el)).toBe(1);

    await act(async () => triggerButtons(el)[0].click()); // collapse
    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('false');
    // Trigger-line values must survive the round trip unchanged.
    expect(inputsLabelled(el, 'brand')[0].value).toBe('NVIDIA');
    expect(inputsLabelled(el, 'part number')[0].value).toBe('RTX 3070');

    await act(async () => triggerButtons(el)[0].click()); // re-expand
    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('true');
    // If toggling had gone through updateRow (or added its own `aiSuggested:
    // false`), the badge would be gone here even though nothing was edited.
    expect(badgeCount(el)).toBe(1);
    expect(el.textContent).toContain('Also possible:');
    expect(inputsLabelled(el, 'brand')[0].value).toBe('NVIDIA');
    expect(inputsLabelled(el, 'part number')[0].value).toBe('RTX 3070');
  });

  it('shows a destructive error indicator on a collapsed row with an active validation error, independent of its open state', async () => {
    const row = manualRow({ collapsed: true });
    const el = await mount(<EditorHarness initialRows={[row]} rowErrors={[{ estimatedResaleValue: 'Must be a number' }]} />);

    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[aria-label="Expected part 1 has an error"]')).not.toBeNull();

    // The indicator must not force the row open, and the row must still
    // toggle normally — both directions, from this same error state.
    await act(async () => triggerButtons(el)[0].click());
    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[aria-label="Expected part 1 has an error"]')).not.toBeNull();

    await act(async () => triggerButtons(el)[0].click());
    expect(triggerButtons(el)[0].getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('[aria-label="Expected part 1 has an error"]')).not.toBeNull();
  });

  it('shows no error indicator on a row with no validation errors', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ collapsed: true })]} rowErrors={[{}]} />);
    expect(el.querySelector('[aria-label="Expected part 1 has an error"]')).toBeNull();
  });

  it('expanding a collapsed row reveals its description, AI badge, and identity-candidates picker', async () => {
    const candidates = [{ brand: 'NVIDIA', partNumber: 'RTX 3080 Ti' }];
    const el = await mount(<EditorHarness initialRows={[aiRow({ collapsed: true, identityCandidates: candidates })]} />);

    expect(inputsLabelled(el, 'description')).toHaveLength(0);
    expect(badgeCount(el)).toBe(0);
    expect(el.textContent).not.toContain('Also possible:');

    await act(async () => triggerButtons(el)[0].click());

    expect(inputsLabelled(el, 'description')).toHaveLength(1);
    expect(inputsLabelled(el, 'description')[0].value).toBe('pulled from a working rig');
    expect(badgeCount(el)).toBe(1);
    expect(el.textContent).toContain('Also possible:');
  });
});

describe('ExpectedPartsEditor notes field (Req 1)', () => {
  it('renders the notes input seeded from the row, and edits route through updateRow like every other field', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ notes: 'from the original owner' })]} />);

    const notesInputs = inputsLabelled(el, 'notes');
    expect(notesInputs).toHaveLength(1);
    expect(notesInputs[0].value).toBe('from the original owner');

    // Edit it on an AI-suggested row: updateRow's shared "any edit reviews
    // the suggestion and claims the price" behavior must fire for notes
    // exactly as it does for description/category/brand (Req 1 wires notes
    // through the same handler, not a one-off setter).
    const aiEl = await mount(<EditorHarness initialRows={[aiRow({ priceSource: 'auto', estimatedResaleValue: '150' })]} />);
    await act(async () => setValue(inputsLabelled(aiEl, 'notes')[0], 'light scratches on the shroud'));

    expect(badgeCount(aiEl)).toBe(0);
    expect(inputsLabelled(aiEl, 'notes')[0].value).toBe('light scratches on the shroud');
  });
});

describe('ExpectedPartsEditor unpriced-row indicator (Req 13)', () => {
  function unpricedIcon(el: HTMLElement, index: number): Element | null {
    return el.querySelector(`[aria-label="Expected part ${index + 1} is not priced"]`);
  }

  it('shows the unpriced indicator for a row with no estimated resale value, only once the listing already exists', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ estimatedResaleValue: '' })]} isExistingListing={true} />);
    expect(unpricedIcon(el, 0)).not.toBeNull();
  });

  it('never shows the unpriced indicator on a brand-new (not-yet-saved) listing, even with an unpriced row', async () => {
    const elUndefined = await mount(<EditorHarness initialRows={[manualRow({ estimatedResaleValue: '' })]} />);
    expect(unpricedIcon(elUndefined, 0)).toBeNull();

    const elFalse = await mount(<EditorHarness initialRows={[manualRow({ estimatedResaleValue: '' })]} isExistingListing={false} />);
    expect(unpricedIcon(elFalse, 0)).toBeNull();
  });

  it('hides the unpriced indicator on an existing listing once the row has a price', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ estimatedResaleValue: '150' })]} isExistingListing={true} />);
    expect(unpricedIcon(el, 0)).toBeNull();
  });

  it('renders both the validation-error and unpriced indicators together on the same row, neither suppressing the other', async () => {
    const el = await mount(
      <EditorHarness
        initialRows={[manualRow({ estimatedResaleValue: '', componentCategory: '' })]}
        rowErrors={[{ componentCategory: 'Category is required.' }]}
        isExistingListing={true}
      />,
    );
    expect(el.querySelector('[aria-label="Expected part 1 has an error"]')).not.toBeNull();
    expect(unpricedIcon(el, 0)).not.toBeNull();
  });
});