// @vitest-environment jsdom
//
// T7 proof (MUST FIX cycle 0 retry 1, item 2): reproduces the pagination
// bug where accepting the last Listing on a filtered page left `page`
// unclamped, stranding the user on an empty page with no way back since
// PaginationControls renders nothing once pageCount<=1. Mounts the real
// ListingsQueuePage (not a reimplementation) with listings-api/sources-api
// mocked, following error-boundary.test.tsx's react-dom/client + act()
// mounting pattern (no RTL dependency in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingsQueuePage } from '../src/routes/listings-queue-page';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchListingsMock = vi.fn();
const acceptListingMock = vi.fn();
const rejectListingMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  fetchListings: (...args: unknown[]) => fetchListingsMock(...args),
  acceptListing: (...args: unknown[]) => acceptListingMock(...args),
  rejectListing: (...args: unknown[]) => rejectListingMock(...args),
  // Req 2: the page resolves "select all" against the full filtered id set.
  // These cases are about pagination/accept-reject, so an empty set keeps
  // selection out of the picture entirely.
  fetchListingIds: () => Promise.resolve<string[]>([]),
  enqueueBulkIdentifyParts: () => Promise.resolve([]),
}));

vi.mock('@/features/sources/sources-api', () => ({
  fetchSources: () => Promise.resolve<Source[]>([
    { id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
  ]),
}));

const PAGE_SIZE = 20;

// Builds one open ListingSummary with a unique id, matching the fields the
// table/comparison columns render.
function makeListing(index: number): ListingSummary {
  return {
    id: `listing-${index}`,
    sourceId: 'source-1',
    title: `Listing ${index}`,
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comparison: { totalExpectedResaleValue: 150, totalCost: 100, difference: 50 },
    identifyPartsStatus: null,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  fetchListingsMock.mockReset();
  acceptListingMock.mockReset();
  rejectListingMock.mockReset();
});

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <ListingsQueuePage />
      </MemoryRouter>,
    );
  });
  return container;
}

// Polls the DOM until `predicate` is true, flushing React's act() queue (and
// real macrotask-scheduled promise continuations, since the mocked API calls
// resolve across several chained awaits: accept -> loadListings -> fetch ->
// conditional setPage -> the page-change effect's own refetch) between
// checks. Throws if the condition never becomes true.
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    });
  }
}

function findButton(el: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!button) {
    throw new Error(`No button found with text "${text}"`);
  }
  return button as HTMLButtonElement;
}

describe('ListingsQueuePage pagination clamp (T7 MUST FIX)', () => {
  it('clamps back to the last valid page after an accept empties the current (non-first) page, instead of stranding the user', async () => {
    // 21 open Listings: page 1 holds 20, page 2 holds exactly 1 — accepting
    // that one row on page 2 drops the total to 20, which no longer has a
    // page 2 at all.
    let listings = Array.from({ length: 21 }, (_, i) => makeListing(i));

    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    acceptListingMock.mockImplementation((id: string) => {
      listings = listings.filter((l) => l.id !== id);
      return Promise.resolve({ listing: { ...makeListing(0), id, status: 'accepted' }, purchaseId: 'purchase-1' });
    });

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);
    expect(el.textContent).toContain('Page 1 of 2 (21 total)');

    // Navigate to page 2, which holds exactly the one remaining Listing.
    await act(async () => {
      findButton(el, 'Next').click();
    });
    await waitFor(() => el.querySelectorAll('tbody tr').length === 1);
    expect(el.textContent).toContain('Page 2 of 2 (21 total)');
    expect(el.textContent).toContain('Listing 20');

    // Accept the sole row on page 2: this shrinks the total to 20, so page
    // 2 (offset 20) no longer exists. Without the clamp fix the table would
    // render "No listings match the current filters." with no Previous
    // control, since PaginationControls renders nothing once pageCount<=1.
    await act(async () => {
      findButton(el, 'Accept').click();
    });

    // Must land back on the new last page (page 1 of 1) with its 20 rows
    // visible, not stuck on an empty page 2.
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);
    expect(el.textContent).not.toContain('No listings match the current filters.');
    // Pagination controls render nothing once pageCount<=1 (20 rows / 20 page size).
    expect(el.textContent).not.toContain('Page 2 of');
  }, 10_000);
});
