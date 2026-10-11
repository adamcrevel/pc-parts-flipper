// @vitest-environment jsdom
//
// Proof for T5's new IdentityCandidatesPicker (identity-candidates-picker.tsx)
// and its wiring into ExpectedPartsEditor (Req 9): a row carrying a
// non-empty identityCandidates list renders clickable candidate chips, a row
// with an empty (or already-fully-matched) list renders none, clicking a
// chip writes both brand and partNumber into that row in a single onChange
// — never two separate edits — and a row with unpicked candidates is never
// blocked from saving by validateExpectedPartRows. Mounts the real
// components through a tiny stateful harness (the editor is fully
// controlled), following expected-parts-editor.test.tsx's react-dom/client +
// act() pattern — no RTL in this workspace.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
import type { IdentityCandidate } from '@pc-parts-flipper/shared';
import { ExpectedPartsEditor, type ExpectedPartRow } from '../src/features/listings/expected-parts-editor';
import { IdentityCandidatesPicker } from '../src/features/listings/identity-candidates-picker';
import { validateExpectedPartRows } from '../src/features/listings/validate-listing';

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

// Candidate chips render as <button type="button"> elements inside the
// "Also possible:" group — every other button on the row (Add Part, Remove,
// and T3's per-row CollapsibleSection trigger, identified by the
// aria-expanded attribute Radix sets only on that button) carries its own
// distinct label or marker, so filtering excludes all three.
function candidateButtons(el: HTMLElement): HTMLButtonElement[] {
  return (Array.from(el.querySelectorAll('button')) as HTMLButtonElement[]).filter(
    (button) => button.textContent !== 'Add Part' && button.textContent !== 'Remove' && !button.hasAttribute('aria-expanded'),
  );
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

// Holds the rows in state so the controlled editor's onChange actually
// round-trips, exactly as ListingForm's own `setRows` does. Also counts
// onChange invocations so a test can prove a single click produced exactly
// one state update rather than two sequential ones.
function EditorHarness({ initialRows, onChangeCount }: { initialRows: ExpectedPartRow[]; onChangeCount?: { count: number } }) {
  const [rows, setRows] = useState<ExpectedPartRow[]>(initialRows);
  return (
    <ExpectedPartsEditor
      rows={rows}
      rowErrors={[]}
      onChange={(next) => {
        if (onChangeCount) onChangeCount.count += 1;
        setRows(next);
      }}
    />
  );
}

describe('IdentityCandidatesPicker component', () => {
  it('renders one chip per candidate when given a non-empty list that differs from the current identity', async () => {
    const candidates: IdentityCandidate[] = [
      { brand: 'NVIDIA', partNumber: 'RTX 3070' },
      { brand: 'NVIDIA', partNumber: 'RTX 3070 Ti' },
    ];
    const el = await mount(<IdentityCandidatesPicker candidates={candidates} brand="" partNumber="" onPick={() => {}} />);

    expect(candidateButtons(el)).toHaveLength(2);
    expect(candidateButtons(el).map((button) => button.textContent)).toEqual(['NVIDIA RTX 3070', 'NVIDIA RTX 3070 Ti']);
  });

  it('excludes a candidate that exactly matches the current brand and partNumber from the rendered chips', async () => {
    const candidates: IdentityCandidate[] = [
      { brand: 'NVIDIA', partNumber: 'RTX 3070' },
      { brand: 'NVIDIA', partNumber: 'RTX 3070 Ti' },
    ];
    // brand/partNumber match the first candidate exactly, so that one must
    // be filtered out — only the genuinely different alternate remains.
    const el = await mount(<IdentityCandidatesPicker candidates={candidates} brand="NVIDIA" partNumber="RTX 3070" onPick={() => {}} />);

    expect(candidateButtons(el)).toHaveLength(1);
    expect(candidateButtons(el)[0].textContent).toBe('NVIDIA RTX 3070 Ti');
  });

  it('renders nothing for an empty candidate list', async () => {
    const el = await mount(<IdentityCandidatesPicker candidates={[]} brand="" partNumber="" onPick={() => {}} />);
    expect(candidateButtons(el)).toHaveLength(0);
    expect(el.textContent).toBe('');
  });
});

describe('ExpectedPartsEditor identity candidates wiring (Req 9)', () => {
  it('renders clickable candidate chips for a row whose identityCandidates is non-empty', async () => {
    const candidates: IdentityCandidate[] = [{ brand: 'NVIDIA', partNumber: 'RTX 3080' }];
    const el = await mount(<EditorHarness initialRows={[manualRow({ identityCandidates: candidates })]} />);

    expect(candidateButtons(el)).toHaveLength(1);
    expect(el.textContent).toContain('Also possible:');
  });

  it('renders no candidate chips for a row whose identityCandidates is empty', async () => {
    const el = await mount(<EditorHarness initialRows={[manualRow({ identityCandidates: [] })]} />);

    expect(candidateButtons(el)).toHaveLength(0);
    expect(el.textContent).not.toContain('Also possible:');
  });

  it('keeps per-row scoping: only the row carrying candidates shows chips, its sibling shows none', async () => {
    const candidates: IdentityCandidate[] = [{ brand: 'EVGA', partNumber: 'RTX 3070' }];
    const el = await mount(
      <EditorHarness initialRows={[manualRow({ identityCandidates: [] }), manualRow({ brand: 'NVIDIA', partNumber: 'RTX 3070', identityCandidates: candidates })]} />,
    );

    // Exactly one chip rendered overall, and it belongs to the second row's
    // container — a leak onto the first row (or a missing chip on the
    // second) both fail this.
    expect(candidateButtons(el)).toHaveLength(1);
    const rowContainers = Array.from(el.querySelectorAll('select')).map((select) => select.closest('div.rounded-md')!);
    expect(rowContainers[0].textContent).not.toContain('Also possible:');
    expect(rowContainers[1].textContent).toContain('Also possible:');
  });

  it('clicking a candidate sets both brand and partNumber in a single onChange, not two separate edits', async () => {
    const candidates: IdentityCandidate[] = [{ brand: 'NVIDIA', partNumber: 'RTX 3080' }];
    const onChangeCount = { count: 0 };
    const el = await mount(<EditorHarness initialRows={[manualRow({ brand: '', partNumber: '', identityCandidates: candidates })]} onChangeCount={onChangeCount} />);

    const chip = candidateButtons(el)[0];
    await act(async () => chip.click());

    // Exactly one state update for the one click: two sequential updates
    // (e.g. a separate call each for brand and partNumber) would read 2
    // here even though the end state looked the same.
    expect(onChangeCount.count).toBe(1);

    const brandInput = el.querySelector('input[aria-label$="brand"]') as HTMLInputElement;
    const partNumberInput = el.querySelector('input[aria-label$="part number"]') as HTMLInputElement;
    // Both fields landed from that one click — a picker wired to only one
    // field, or requiring a second interaction to fill the other, fails one
    // of these two.
    expect(brandInput.value).toBe('NVIDIA');
    expect(partNumberInput.value).toBe('RTX 3080');
  });

  it('a row with an unpicked, non-empty candidate list produces no validation errors blocking save (Req 9)', () => {
    const candidates: IdentityCandidate[] = [
      { brand: 'NVIDIA', partNumber: 'RTX 3070' },
      { brand: 'NVIDIA', partNumber: 'RTX 3070 Ti' },
    ];
    // A fully-valid-otherwise row (category/description/value all filled) so
    // the only variable under test is identityCandidates itself — any
    // non-empty error object proves something gates on an unpicked list.
    const row = manualRow({ identityCandidates: candidates });

    const errors = validateExpectedPartRows([row]);

    expect(errors).toEqual([{}]);
  });

  it('does not clear aiSuggested when picking a candidate — only a free-text edit does', async () => {
    const candidates: IdentityCandidate[] = [{ brand: 'NVIDIA', partNumber: 'RTX 3080' }];
    const el = await mount(<EditorHarness initialRows={[manualRow({ aiSuggested: true, identityCandidates: candidates })]} />);
    expect(Array.from(el.querySelectorAll('span')).some((span) => span.textContent === 'AI suggested')).toBe(true);

    const chip = candidateButtons(el)[0];
    await act(async () => chip.click());

    // Picking an alternate is still reviewing the AI's own suggestion, not
    // a free-text edit of it — the badge must survive the click. A picker
    // wired through updateRow (which always sets aiSuggested: false) fails
    // this.
    expect(Array.from(el.querySelectorAll('span')).some((span) => span.textContent === 'AI suggested')).toBe(true);
    const brandInput = el.querySelector('input[aria-label$="brand"]') as HTMLInputElement;
    expect(brandInput.value).toBe('NVIDIA');
  });
});
