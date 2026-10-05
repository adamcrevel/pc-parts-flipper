// @vitest-environment jsdom
//
// Proof that the teardown checklist names each row by the part's identity
// (teardown-checklist.tsx + teardown-form-state.ts).
//
// This is the screen a user reads while physically reconciling parts by
// hand, so it is where brand/model matters most. This feature moved identity
// out of the free-text `description`, which means a row rendered from
// `description` alone now reads "GPU — triple-fan cooler visible" instead of
// "GPU — NVIDIA RTX 3070". Two layers are covered here, because the identity
// was missing from both: initialTeardownRows must carry brand/partNumber into
// row state at all, and the checklist must render them.
//
// TeardownChecklist is a pure presentational component over props — no API
// module is imported, so nothing here can reach the network, and it uses no
// router hooks, so it mounts bare. Mounting follows parts-table.test.tsx's
// react-dom/client + act() pattern (no RTL dependency in this workspace).
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ExpectedPart } from '@pc-parts-flipper/shared';
import { TeardownChecklist } from '../src/features/teardown/teardown-checklist';
import { initialTeardownRows, type TeardownRow } from '../src/features/teardown/teardown-form-state';

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

/** One Expected Part exactly as GET /api/purchases/:id/teardown returns it. */
function makeExpectedPart(overrides: Partial<ExpectedPart> = {}): ExpectedPart {
  return {
    id: 'ep-1',
    listingId: 'listing-1',
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'triple-fan cooler visible',
    estimatedResaleValue: 220,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

/**
 * Mounts the checklist over rows built by initialTeardownRows, so the test
 * exercises the real state-building path rather than hand-written row
 * objects — a TeardownRow that never receives brand/partNumber would make
 * the display assertions fail here even though the JSX is correct.
 */
async function mountChecklist(expectedParts: ExpectedPart[]): Promise<HTMLDivElement> {
  const rows = initialTeardownRows(expectedParts);
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(<TeardownChecklist rows={rows} rowErrors={[]} onChange={() => {}} />);
  });
  return container;
}

/** The identity line of the row at `index`, addressed positionally. */
function identityLine(el: HTMLElement, index = 0): string {
  return el.querySelectorAll('[data-testid="teardown-row-identity"]')[index].textContent ?? '';
}

describe('initialTeardownRows carries part identity into row state', () => {
  it('copies brand and partNumber from the Expected Part', () => {
    const [row] = initialTeardownRows([makeExpectedPart()]);

    expect(row.brand).toBe('NVIDIA');
    expect(row.partNumber).toBe('RTX 3070');
  });

  it('keeps an unidentified part null rather than defaulting or guessing', () => {
    const [row] = initialTeardownRows([makeExpectedPart({ brand: null, partNumber: null })]);

    expect(row.brand).toBeNull();
    expect(row.partNumber).toBeNull();
  });
});

describe('TeardownChecklist identity display', () => {
  it('headlines the row with category and identity, not the description', async () => {
    const el = await mountChecklist([makeExpectedPart()]);

    // Positional, not a substring search of the whole screen: asserting on
    // el.textContent would also pass if the identity were appended somewhere
    // unrelated, and would not catch the description still occupying the
    // headline. The category sits immediately before this span.
    expect(identityLine(el)).toBe(' — NVIDIA RTX 3070');
    const headline = el.querySelector('.font-medium');
    expect(headline?.textContent).toBe('GPU');
  });

  it('shows just the half that was identified', async () => {
    const brandOnly = await mountChecklist([makeExpectedPart({ partNumber: null })]);
    // Not 'NVIDIA null' and not 'NVIDIA ' with a trailing separator: a
    // template-literal join would produce exactly those.
    expect(identityLine(brandOnly)).toBe(' — NVIDIA');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const numberOnly = await mountChecklist([makeExpectedPart({ brand: null })]);
    expect(identityLine(numberOnly)).toBe(' — RTX 3070');
  });

  it('falls back to the description when neither brand nor part number was identified', async () => {
    const el = await mountChecklist([makeExpectedPart({ brand: null, partNumber: null })]);

    // Both fields are nullable by design (never guessed), and the row must
    // still be identifiable by hand — the description is the only thing left
    // that can tell two same-category rows apart, so an empty headline (or a
    // literal '—' placeholder) would be worse than useless here.
    expect(identityLine(el)).toBe(' — triple-fan cooler visible');
    // And no duplicate secondary description line: that is only shown when
    // the identity has taken over the headline.
    expect(el.textContent).not.toContain('· triple-fan cooler visible');
  });

  it('keeps the description visible as a secondary line once identity takes the headline', async () => {
    const el = await mountChecklist([makeExpectedPart()]);

    // Condition notes are not lost from the reconciliation screen just
    // because the part is identified.
    expect(el.textContent).toContain('· triple-fan cooler visible');
  });

  it('names each row control by its own identity, so rows are distinguishable', async () => {
    const el = await mountChecklist([
      makeExpectedPart(),
      makeExpectedPart({ id: 'ep-2', componentCategory: 'PSU', brand: 'Corsair', partNumber: 'RM750', description: 'no cables included' }),
    ]);

    const identities = Array.from(el.querySelectorAll('[data-testid="teardown-row-identity"]')).map((node) => node.textContent);
    expect(identities).toEqual([' — NVIDIA RTX 3070', ' — Corsair RM750']);

    // The accessible name of each result selector follows the same identity,
    // so a screen-reader user can tell two GPU rows apart too.
    const labels = Array.from(el.querySelectorAll('select')).map((node) => node.getAttribute('aria-label'));
    expect(labels).toEqual(['NVIDIA RTX 3070 result', 'Corsair RM750 result']);
  });
});

// Type-level guard, exercised by tsc rather than at runtime: TeardownRow must
// expose nullable brand/partNumber. Dropping either field from the interface
// (or widening it to a non-null string) fails the build.
const _rowShape: Pick<TeardownRow, 'brand' | 'partNumber'> = { brand: null, partNumber: null };
void _rowShape;
