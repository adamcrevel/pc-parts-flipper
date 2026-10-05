// @vitest-environment jsdom
//
// Proof for brand/part number on the teardown "Additional Parts found"
// editor (additional-parts-editor.tsx) and on the request body it feeds
// (teardown-form-state.ts's buildSubmitTeardownInput): the two inputs render
// per row, write back into that row only, and reach the POST body as the
// typed value or as null — never as '' and never guessed — while the
// client-only draft shape stays out of the payload entirely.
//
// Nothing here touches the network: the editor is a pure controlled
// component and buildSubmitTeardownInput is a pure function, so no API
// module is imported at all. Mounts the real component through a small
// stateful harness (the editor is fully controlled, so without one onChange
// would go nowhere), following expected-parts-editor.test.tsx's
// react-dom/client + act() pattern — no RTL in this workspace.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
import { AdditionalPartsEditor } from '../src/features/teardown/additional-parts-editor';
import {
  buildSubmitTeardownInput,
  emptyAdditionalPartRow,
  type AdditionalPartRow,
  type TeardownRow,
} from '../src/features/teardown/teardown-form-state';

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

/** Every input carrying the given per-row aria-label suffix, in render order. */
function inputsLabelled(el: HTMLElement, suffix: string): HTMLInputElement[] {
  return (Array.from(el.querySelectorAll('input')) as HTMLInputElement[]).filter((input) => input.getAttribute('aria-label')?.endsWith(suffix));
}

// Holds the rows in state so the controlled editor's onChange round-trips,
// exactly as TeardownPage's own `setAdditionalRows` does.
function EditorHarness({ initialRows }: { initialRows: AdditionalPartRow[] }) {
  const [rows, setRows] = useState<AdditionalPartRow[]>(initialRows);
  return <AdditionalPartsEditor rows={rows} rowErrors={[]} onChange={setRows} />;
}

function row(overrides: Partial<AdditionalPartRow> = {}): AdditionalPartRow {
  return { category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3070', description: 'found in the spare bay', note: '', ...overrides };
}

describe('AdditionalPartsEditor brand and part number fields', () => {
  it('renders one brand and one part number input per row, seeded from the row state', async () => {
    const el = await mount(<EditorHarness initialRows={[row(), row({ category: 'PSU', brand: 'Corsair', partNumber: 'RM750' })]} />);

    // Per-row values, not just a presence check: an input dropped from the
    // second row, or a single shared input, fails on the array shape.
    expect(inputsLabelled(el, 'brand').map((input) => input.value)).toEqual(['NVIDIA', 'Corsair']);
    expect(inputsLabelled(el, 'part number').map((input) => input.value)).toEqual(['RTX 3070', 'RM750']);
  });

  it('starts a freshly added row with blank brand and part number', async () => {
    const el = await mount(<EditorHarness initialRows={[emptyAdditionalPartRow()]} />);

    // The never-guess rule at the point of entry: a new row offers empty
    // fields rather than any placeholder or defaulted identity.
    expect(inputsLabelled(el, 'brand')[0].value).toBe('');
    expect(inputsLabelled(el, 'part number')[0].value).toBe('');
  });

  it('writes a typed brand back into that row only, leaving its siblings untouched', async () => {
    const el = await mount(<EditorHarness initialRows={[row(), row({ brand: 'AMD', partNumber: 'RX 6600' })]} />);

    await act(async () => setValue(inputsLabelled(el, 'brand')[1], 'XFX'));

    expect(inputsLabelled(el, 'brand').map((input) => input.value)).toEqual(['NVIDIA', 'XFX']);
    // The edited row's other identity field must survive the patch — a
    // replace-the-row update (rather than a merge) would blank this.
    expect(inputsLabelled(el, 'part number')[1].value).toBe('RX 6600');
  });

  it('writes a typed part number back into that row only', async () => {
    const el = await mount(<EditorHarness initialRows={[row(), row({ brand: 'AMD', partNumber: 'RX 6600' })]} />);

    await act(async () => setValue(inputsLabelled(el, 'part number')[0], 'RTX 3070 Ti'));

    expect(inputsLabelled(el, 'part number').map((input) => input.value)).toEqual(['RTX 3070 Ti', 'RX 6600']);
    expect(inputsLabelled(el, 'brand').map((input) => input.value)).toEqual(['NVIDIA', 'AMD']);
  });
});

describe('buildSubmitTeardownInput additional-part identity', () => {
  const checklistRows: TeardownRow[] = [
    {
      expectedPartId: 'expected-1',
      category: 'CPU',
      description: 'Ryzen 5 5600X',
      estimatedResaleValue: 90,
      result: 'present_as_expected',
      note: '',
    },
  ];

  it('sends the typed brand and part number, trimmed, on an identified additional part', async () => {
    const input = buildSubmitTeardownInput(checklistRows, [row({ brand: '  NVIDIA  ', partNumber: '  RTX 3070  ' })]);

    expect(input.additionalParts[0].brand).toBe('NVIDIA');
    expect(input.additionalParts[0].partNumber).toBe('RTX 3070');
  });

  it('sends null, never an empty string, for an additional part left unidentified', async () => {
    // Whitespace-only as well as empty: a `row.brand || null` without the
    // trim would let a ' ' string through as a real identity.
    const input = buildSubmitTeardownInput(checklistRows, [row({ brand: '', partNumber: '   ' })]);

    expect(input.additionalParts[0].brand).toBeNull();
    expect(input.additionalParts[0].partNumber).toBeNull();
  });

  it('builds the additional part field by field, with no client-only row state leaking through', async () => {
    const input = buildSubmitTeardownInput(checklistRows, [row({ note: ' second GPU ' })]);

    // Exact-shape equality rather than a key spot check: a spread-based
    // row→input mapping would be invisible to anything weaker, and the row
    // type is free to grow editor-only fields later.
    expect(input.additionalParts).toEqual([
      { category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3070', description: 'found in the spare bay', note: 'second GPU' },
    ]);
  });
});
