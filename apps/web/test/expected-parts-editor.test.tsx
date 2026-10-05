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
import { ExpectedPartsEditor, type ExpectedPartRow } from '../src/features/listings/expected-parts-editor';

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
function EditorHarness({ initialRows }: { initialRows: ExpectedPartRow[] }) {
  const [rows, setRows] = useState<ExpectedPartRow[]>(initialRows);
  return <ExpectedPartsEditor rows={rows} rowErrors={[]} onChange={setRows} />;
}

function aiRow(overrides: Partial<ExpectedPartRow> = {}): ExpectedPartRow {
  return {
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'pulled from a working rig',
    estimatedResaleValue: '',
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
    estimatedResaleValue: '90',
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