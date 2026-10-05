// @vitest-environment jsdom
//
// Proof that the Record Sale screen names the part the same way its Sale
// Listing does (record-sale-page.tsx).
//
// This feature replaced the old `${category}: ${description}` title with an
// identity-first one (defaultSaleListingTitle, apps/server), but this screen
// kept rendering the old format literally — so a Part listed for sale as
// "NVIDIA RTX 3070" read as "GPU: light coil whine under load" on the very
// screen where its sale gets recorded.
//
// Mounts the real RecordSalePage with parts-api mocked, following
// listings-page.test.tsx's react-dom/client + act() mounting pattern (no RTL
// dependency in this workspace). The page uses router hooks (useParams,
// useNavigate), so it mounts inside a MemoryRouter at a matching path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PartSummary } from '@pc-parts-flipper/shared';
import { RecordSalePage } from '../src/routes/record-sale-page';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchPartMock = vi.fn();

vi.mock('@/features/parts/parts-api', () => ({
  fetchPart: (...args: unknown[]) => fetchPartMock(...args),
}));

// The form itself is out of scope here (it owns the sales-api call); stubbing
// it keeps this test to the heading and off the network entirely.
vi.mock('@/features/sales/record-sale-form', () => ({
  RecordSaleForm: () => <div data-testid="record-sale-form" />,
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
  fetchPartMock.mockReset();
});

function makePart(overrides: Partial<PartSummary> = {}): PartSummary {
  return {
    id: 'part-1',
    purchaseId: 'purchase-1',
    category: 'GPU',
    brand: 'NVIDIA',
    partNumber: 'RTX 3070',
    description: 'light coil whine under load',
    status: 'listed',
    unsellableReason: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    purchase: { id: 'purchase-1', listingTitle: 'Gaming PC bundle' },
    ...overrides,
  };
}

async function mountPage(part: PartSummary): Promise<HTMLDivElement> {
  fetchPartMock.mockResolvedValue(part);
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter initialEntries={['/record-sale/part-1']}>
        <Routes>
          <Route path="/record-sale/:partId" element={<RecordSalePage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

/** The part heading, addressed by its own node rather than by page text. */
function heading(el: HTMLElement): string {
  return el.querySelector('[data-testid="record-sale-part-heading"]')?.textContent ?? '';
}

describe('RecordSalePage part heading', () => {
  it('names the part by its identity, not by its condition notes', async () => {
    const el = await mountPage(makePart());

    // Positional, not a substring search of the whole page: asserting on
    // el.textContent would pass even with the old
    // `${category}: ${description}` heading still in place, since the
    // description is also rendered (as a secondary line) when identity is
    // known.
    expect(heading(el)).toBe('GPU: NVIDIA RTX 3070');
    // The condition notes are not lost — they move to their own line.
    expect(el.querySelector('[data-testid="record-sale-part-description"]')?.textContent).toBe('light coil whine under load');
  });

  it('shows just the half that was identified', async () => {
    // Not 'NVIDIA null' and not a trailing separator: a template-literal
    // join would produce exactly those.
    const brandOnly = await mountPage(makePart({ partNumber: null }));
    expect(heading(brandOnly)).toBe('GPU: NVIDIA');

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const numberOnly = await mountPage(makePart({ brand: null }));
    expect(heading(numberOnly)).toBe('GPU: RTX 3070');
  });

  it('falls back to the description when neither brand nor part number was identified', async () => {
    const el = await mountPage(makePart({ brand: null, partNumber: null }));

    // Both fields are nullable by design (never guessed), so this is the
    // original format — the only remaining way to tell the part apart — and
    // the description must not then be duplicated onto a second line.
    expect(heading(el)).toBe('GPU: light coil whine under load');
    expect(el.querySelector('[data-testid="record-sale-part-description"]')).toBeNull();
  });
});
