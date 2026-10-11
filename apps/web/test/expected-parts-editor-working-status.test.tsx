// @vitest-environment jsdom
//
// Proof for T6's per-Expected-Part working-status control
// (expected-parts-editor.tsx, Req 11, 17): the "Working" / "Not Working"
// control renders only when the editor's `listingNonWorking` prop is true,
// and its handler (updateWorkingStatus) resets an auto-owned or undecided
// row's price to undecided on a status change, while leaving a
// manually-owned row's exact price and priceSource untouched — the one
// deliberate exception to updateRow's otherwise-universal "any edit claims
// manual ownership" rule. Mounts the real component through react-dom/
// client + act(), following expected-parts-editor.test.tsx's own harness
// pattern (no RTL in this workspace).
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
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

// Holds the rows in state so the controlled editor's onChange round-trips,
// and captures each onChange call's argument directly — the handler's own
// output — rather than re-deriving it from re-rendered DOM state, which
// would only prove the render reflects state, not what the handler itself
// produced.
function EditorHarness({
  initialRows,
  rowErrors = [],
  listingNonWorking,
  onRowsChange,
}: {
  initialRows: ExpectedPartRow[];
  rowErrors?: ExpectedPartRowErrors[];
  listingNonWorking?: boolean;
  onRowsChange?: (rows: ExpectedPartRow[]) => void;
}) {
  const [rows, setRows] = useState<ExpectedPartRow[]>(initialRows);
  return (
    <ExpectedPartsEditor
      rows={rows}
      rowErrors={rowErrors}
      listingNonWorking={listingNonWorking}
      onChange={(next) => {
        setRows(next);
        onRowsChange?.(next);
      }}
    />
  );
}

function pricedRow(overrides: Partial<ExpectedPartRow> = {}): ExpectedPartRow {
  return {
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'pulled from a working rig',
    notes: '',
    estimatedResaleValue: '150.00',
    identityCandidates: [],
    workingStatus: 'working',
    ...overrides,
  };
}

/** Every row's own outer collapsible wrapper, in render order — scopes button lookups per row. */
function rowContainers(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll('select')).map((select) => select.closest('div.rounded-md') as HTMLElement);
}

function notWorkingButton(rowEl: HTMLElement): HTMLButtonElement {
  return Array.from(rowEl.querySelectorAll('button')).find((button) => button.textContent === 'Not Working') as HTMLButtonElement;
}

describe('ExpectedPartsEditor per-part working-status control visibility (Req 11)', () => {
  it('shows the Working Status control when listingNonWorking is true', async () => {
    const el = await mount(<EditorHarness initialRows={[pricedRow()]} listingNonWorking={true} />);
    expect(el.textContent).toContain('Working Status');
    expect(rowContainers(el)[0].querySelectorAll('button').length).toBeGreaterThanOrEqual(2);
  });

  it('omits the Working Status control when listingNonWorking is false', async () => {
    const el = await mount(<EditorHarness initialRows={[pricedRow()]} listingNonWorking={false} />);
    expect(el.textContent).not.toContain('Working Status');
  });

  it('omits the Working Status control when listingNonWorking is omitted', async () => {
    const el = await mount(<EditorHarness initialRows={[pricedRow()]} />);
    expect(el.textContent).not.toContain('Working Status');
  });
});

describe('ExpectedPartsEditor updateWorkingStatus price-reset-on-change (Req 17)', () => {
  it('clears estimatedResaleValue and priceSource on an auto-owned priced row toggled to non-working', async () => {
    let latestRows: ExpectedPartRow[] = [];
    const el = await mount(
      <EditorHarness
        initialRows={[pricedRow({ priceSource: 'auto', estimatedResaleValue: '150.00', workingStatus: 'working' })]}
        listingNonWorking={true}
        onRowsChange={(rows) => {
          latestRows = rows;
        }}
      />,
    );

    await act(async () => {
      notWorkingButton(rowContainers(el)[0]).click();
    });

    expect(latestRows).toHaveLength(1);
    expect(latestRows[0].workingStatus).toBe('non_working');
    expect(latestRows[0].estimatedResaleValue).toBe('');
    expect(latestRows[0].priceSource).toBeUndefined();
  });

  it('keeps the exact price and priceSource unchanged on a manual-owned priced row toggled to non-working', async () => {
    let latestRows: ExpectedPartRow[] = [];
    const el = await mount(
      <EditorHarness
        initialRows={[pricedRow({ priceSource: 'manual', estimatedResaleValue: '275.50', workingStatus: 'working' })]}
        listingNonWorking={true}
        onRowsChange={(rows) => {
          latestRows = rows;
        }}
      />,
    );

    await act(async () => {
      notWorkingButton(rowContainers(el)[0]).click();
    });

    expect(latestRows).toHaveLength(1);
    expect(latestRows[0].workingStatus).toBe('non_working');
    expect(latestRows[0].estimatedResaleValue).toBe('275.50');
    expect(latestRows[0].priceSource).toBe('manual');
  });

  it('does not fire onChange, and does not clear an auto-owned price, when re-clicking the already-active status (MF-5)', async () => {
    let onChangeCallCount = 0;
    const el = await mount(
      <EditorHarness
        initialRows={[pricedRow({ priceSource: 'auto', estimatedResaleValue: '150.00', workingStatus: 'working' })]}
        listingNonWorking={true}
        onRowsChange={() => {
          onChangeCallCount += 1;
        }}
      />,
    );

    await act(async () => {
      (Array.from(rowContainers(el)[0].querySelectorAll('button')).find((button) => button.textContent === 'Working') as HTMLButtonElement).click();
    });

    // Re-clicking "Working" on a row that is already working must be a true
    // no-op: the handler returns before calling onChange at all, so a real,
    // already-researched price is never at risk of being cleared by this
    // path — asserting the call count (not just the eventual price) is what
    // distinguishes "didn't change" from "changed back to the same value".
    expect(onChangeCallCount).toBe(0);
  });

  it('leaves the estimated-resale-value input showing the real researched price, and never updates priceSource, when re-clicking the already-active status (MF-5)', async () => {
    let latestRows: ExpectedPartRow[] | null = null;
    const el = await mount(
      <EditorHarness
        initialRows={[pricedRow({ priceSource: 'auto', estimatedResaleValue: '150.00', workingStatus: 'working' })]}
        listingNonWorking={true}
        onRowsChange={(rows) => {
          latestRows = rows;
        }}
      />,
    );

    const priceInput = rowContainers(el)[0].querySelector('input[aria-label="Expected part 1 estimated resale value"]') as HTMLInputElement;
    expect(priceInput.value).toBe('150.00');

    await act(async () => {
      (Array.from(rowContainers(el)[0].querySelectorAll('button')).find((button) => button.textContent === 'Working') as HTMLButtonElement).click();
    });

    // onRowsChange never fires (the handler short-circuits before calling
    // onChange at all), so priceSource can never have been touched either —
    // latestRows staying null is direct proof of that, not an inference from
    // the call count alone. The input is read straight off the DOM (the
    // controlled value React actually committed), not re-derived from the
    // row object this test itself constructed.
    expect(latestRows).toBeNull();
    expect(priceInput.value).toBe('150.00');
  });
});
