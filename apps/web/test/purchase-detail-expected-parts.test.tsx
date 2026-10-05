// @vitest-environment jsdom
//
// Proof that the Purchase detail screen's Expected Parts table surfaces each
// part's brand/model (purchase-detail-page.tsx).
//
// This feature moved identity out of the free-text `description`, so a table
// rendering only category/description/value no longer shows *which* part a
// row is about — on the screen a user reads before deciding whether a
// purchase is worth tearing down.
//
// Mounts the real PurchaseDetailPage with purchases-api mocked, following
// listings-page.test.tsx's react-dom/client + act() mounting pattern (no RTL
// dependency in this workspace). The page uses router hooks (useParams,
// useLocation, Link), so it mounts inside a MemoryRouter at a matching path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ExpectedPart, PurchaseDetail } from '@pc-parts-flipper/shared';
import { PurchaseDetailPage } from '../src/routes/purchase-detail-page';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchPurchaseMock = vi.fn();

vi.mock('@/features/purchases/purchases-api', () => ({
  fetchPurchase: (...args: unknown[]) => fetchPurchaseMock(...args),
  updatePurchase: vi.fn(),
  updatePurchaseStatus: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  fetchPurchaseMock.mockReset();
});

function makeExpectedPart(overrides: Partial<ExpectedPart> = {}): ExpectedPart {
  return {
    id: 'ep-1',
    listingId: 'listing-1',
    componentCategory: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'triple-fan cooler visible',
    estimatedResaleValue: 220,
    identityCandidates: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  };
}

function makePurchase(expectedParts: ExpectedPart[]): PurchaseDetail {
  return {
    id: 'purchase-1',
    listingId: 'listing-1',
    status: 'received',
    pricePaid: 400,
    purchaseDate: '2024-01-02',
    createdAt: '2024-01-02',
    updatedAt: '2024-01-02',
    listing: {
      id: 'listing-1',
      sourceId: 'source-1',
      title: 'Gaming PC bundle',
      description: null,
      listingUrl: null,
      askingPrice: 400,
      listingDate: '2024-01-01',
      status: 'accepted',
      acquisitionFees: 0,
      photoPaths: [],
      externalSource: null,
      externalItemId: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      expectedParts,
    },
  };
}

async function mountPage(expectedParts: ExpectedPart[]): Promise<HTMLDivElement> {
  fetchPurchaseMock.mockResolvedValue(makePurchase(expectedParts));
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter initialEntries={['/purchases/purchase-1']}>
        <Routes>
          <Route path="/purchases/:id" element={<PurchaseDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

/** The cells of the Expected Parts table's first body row, in column order. */
function firstRowCells(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('tbody tr')[0].querySelectorAll('td')).map((cell) => cell.textContent ?? '');
}

describe('PurchaseDetailPage Expected Parts brand/model display', () => {
  it('shows brand and part number together in their own labelled column', async () => {
    const el = await mountPage([makeExpectedPart()]);

    const headers = Array.from(el.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Category', 'Brand / Model', 'Description', 'Est. Resale Value']);

    // Positional, not a substring search of the whole page: asserting on
    // el.textContent would also pass if the identity were concatenated into
    // the description cell, or rendered in some unrelated section.
    const cells = firstRowCells(el);
    expect(cells[0]).toBe('GPU');
    expect(cells[1]).toBe('NVIDIA RTX 3070');
    expect(cells[2]).toBe('triple-fan cooler visible');
    expect(cells[3]).toBe('$220.00');
  });

  it('shows just the half that was identified', async () => {
    // Not 'NVIDIA null' and not a trailing separator: a template-literal
    // join would produce exactly those.
    const brandOnly = await mountPage([makeExpectedPart({ partNumber: null })]);
    expect(firstRowCells(brandOnly)[1]).toBe('NVIDIA');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const numberOnly = await mountPage([makeExpectedPart({ brand: null })]);
    expect(firstRowCells(numberOnly)[1]).toBe('RTX 3070');
  });

  it('falls back to a dash when neither brand nor part number was identified', async () => {
    const el = await mountPage([makeExpectedPart({ brand: null, partNumber: null })]);

    // Both fields are nullable by design (never guessed), so the
    // unidentified case renders a visible placeholder rather than an empty
    // cell that silently misaligns the column.
    const cells = firstRowCells(el);
    expect(cells[1]).toBe('—');
    // The row is otherwise intact — a blank cell, not a dropped row.
    expect(cells[2]).toBe('triple-fan cooler visible');
  });

  it('renders each row its own identity, not the first row repeated', async () => {
    const el = await mountPage([
      makeExpectedPart(),
      makeExpectedPart({ id: 'ep-2', componentCategory: 'PSU', brand: 'Corsair', partNumber: 'RM750' }),
    ]);

    const identityCells = Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.querySelectorAll('td')[1].textContent);
    expect(identityCells).toEqual(['NVIDIA RTX 3070', 'Corsair RM750']);
  });

  it('shows alternate candidate pairings alongside the primary identity when the AI left some unresolved', async () => {
    const el = await mountPage([
      makeExpectedPart({
        identityCandidates: [
          { brand: 'NVIDIA', partNumber: 'RTX 3070' }, // duplicate of the primary — dropped by formatIdentityCandidates
          { brand: 'NVIDIA', partNumber: 'RTX 3080' },
        ],
      }),
    ]);

    // Both the primary identity and the alternates note live in the same
    // cell; asserting the cell's exact text (not a whole-page substring
    // search) confirms the alternates annotation actually renders next to
    // the primary rather than merely that the page didn't crash.
    expect(firstRowCells(el)[1]).toBe('NVIDIA RTX 3070 (or NVIDIA RTX 3080)');
  });
});
