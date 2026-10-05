// @vitest-environment jsdom
//
// Proof that the Parts list surfaces a part's brand/model (parts-table.tsx).
// This is the payoff for carrying brand/partNumber from AI identification
// through teardown into the Part record: the Parts screen is where a user
// decides what to do with a part next, so an identified part must read as
// "NVIDIA RTX 3070" there rather than only as free-text description.
//
// PartsTable is a pure presentational component over props — no API module
// is imported, so nothing here can reach the network. It does use
// react-router's useNavigate, so it mounts inside a MemoryRouter.
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { PartSummary } from '@pc-parts-flipper/shared';
import { PartsTable } from '../src/features/parts/parts-table';

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

function makePart(overrides: Partial<PartSummary> = {}): PartSummary {
  return {
    id: 'part-1',
    purchaseId: 'purchase-1',
    category: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'light coil whine under load',
    status: 'ready_to_list',
    unsellableReason: null,
    identityCandidates: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    purchase: { id: 'purchase-1', listingTitle: 'Gaming PC bundle' },
    ...overrides,
  };
}

async function mountTable(parts: PartSummary[]): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <PartsTable parts={parts} onMarkUnsellable={async () => {}} />
      </MemoryRouter>,
    );
  });
  return container;
}

/** The cells of the first body row, in column order. */
function firstRowCells(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((cell) => cell.textContent ?? '');
}

describe('PartsTable brand/model display', () => {
  it('shows brand and part number together in their own labelled column', async () => {
    const el = await mountTable([makePart()]);

    // The column exists and is named, so the value is attributable rather
    // than an unlabelled string floating in the row.
    const headers = Array.from(el.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toContain('Brand / Model');

    // Positional, not a substring search of the whole table: asserting on
    // el.textContent would also pass if the identity were only concatenated
    // into the description cell. The brand/model cell sits between category
    // and description.
    const cells = firstRowCells(el);
    expect(cells[0]).toBe('GPU');
    expect(cells[1]).toBe('NVIDIA RTX 3070');
    expect(cells[2]).toBe('light coil whine under load');
  });

  it('shows just the brand when no part number was identified', async () => {
    const el = await mountTable([makePart({ partNumber: null })]);

    // Not 'NVIDIA null' and not 'NVIDIA ' with a trailing separator: a
    // template-literal join would produce exactly those.
    expect(firstRowCells(el)[1]).toBe('NVIDIA');
  });

  it('shows just the part number when no brand was identified', async () => {
    const el = await mountTable([makePart({ brand: null })]);

    expect(firstRowCells(el)[1]).toBe('RTX 3070');
  });

  it('falls back to a dash when neither brand nor part number was identified', async () => {
    const el = await mountTable([makePart({ brand: null, partNumber: null })]);

    // Both fields are nullable by design (never guessed), so the unidentified
    // case has to render as a visible placeholder, not an empty cell that
    // silently misaligns the column.
    expect(firstRowCells(el)[1]).toBe('—');
    // The row is otherwise intact — this is a blank cell, not a dropped row.
    expect(firstRowCells(el)[2]).toBe('light coil whine under load');
  });

  it('renders each part its own brand/model, not the first row repeated', async () => {
    const el = await mountTable([makePart(), makePart({ id: 'part-2', category: 'PSU', brand: 'Corsair', partNumber: 'RM750' })]);

    const brandCells = Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.querySelectorAll('td')[1].textContent);
    expect(brandCells).toEqual(['NVIDIA RTX 3070', 'Corsair RM750']);
  });

  it('shows alternate candidate pairings alongside the primary identity when the AI left some unresolved', async () => {
    const el = await mountTable([
      makePart({
        identityCandidates: [
          { brand: 'NVIDIA', partNumber: 'RTX 3070' }, // duplicate of the primary — dropped by formatIdentityCandidates
          { brand: 'NVIDIA', partNumber: 'RTX 3080' },
        ],
      }),
    ]);

    // Both the primary identity and the alternates note live in the same
    // cell; asserting the cell's exact text (not a whole-row substring
    // search) confirms the alternates annotation actually renders next to
    // the primary rather than merely that the component didn't crash.
    expect(firstRowCells(el)[1]).toBe('NVIDIA RTX 3070 (or NVIDIA RTX 3080)');
  });
});
