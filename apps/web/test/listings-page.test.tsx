// @vitest-environment jsdom
//
// Stale-fetch race (MUST FIX) in handleToggleEdit (listings-page.tsx):
// fetchListing responses were applied unconditionally, with nothing to stop
// an in-flight request from a previous click overwriting state after a
// later click has already moved on. Two tests:
//
// 1. Cross-listing (A, then B before A resolves): proves the state ends up
//    holding the last-clicked listing's (B's) own data once A's slower
//    fetch lands, not A's — the originally reported shape of the bug.
// 2. Same-listing reopen (A clicked, closed, and reopened while the first
//    click's fetch is still pending): this is the case that actually
//    surfaces as visible stale data in the DOM, because ListingForm
//    lazily seeds its fields from `initialValue` once on mount and never
//    re-syncs — so if the row's stale first fetch resolves (and flips
//    `editingLoading` false) before the second fetch does, ListingForm
//    mounts pre-filled with the stale detail and silently ignores the
//    correct one that arrives after. An id-only guard (comparing against
//    `editingListingId`) cannot tell these two requests for the same id
//    apart, so the fix uses a per-request token instead.
//
// Mounts the real ListingsPage (not a reimplementation) with
// listings-api/sources-api mocked, following
// listings-queue-page.test.tsx's react-dom/client + act() mounting pattern
// (no RTL dependency in this workspace), and drives fetchListing through
// controlled, independently-resolvable promises so resolution order is
// deterministic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingsPage } from '../src/routes/listings-page';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchListingsMock = vi.fn();
const fetchListingMock = vi.fn();
const createListingMock = vi.fn();
const updateListingMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  fetchListings: (...args: unknown[]) => fetchListingsMock(...args),
  fetchListing: (...args: unknown[]) => fetchListingMock(...args),
  createListing: (...args: unknown[]) => createListingMock(...args),
  updateListing: (...args: unknown[]) => updateListingMock(...args),
}));

vi.mock('@/features/sources/sources-api', () => ({
  fetchSources: () => Promise.resolve<Source[]>([
    { id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
  ]),
}));

// Builds one open ListingSummary with a unique id/title/price, matching the
// fields the table columns and ListingForm's fields render.
function makeListing(id: string, title: string, askingPrice: number): ListingSummary {
  return {
    id,
    sourceId: 'source-1',
    title,
    description: null,
    listingUrl: null,
    askingPrice,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comparison: { totalExpectedResaleValue: askingPrice + 50, totalCost: askingPrice, difference: 50 },
  };
}

// The ListingDetail a fetchListing(id) call would resolve with: the summary
// plus one Expected Part carrying an id-specific description, so the open
// form's part row can also be checked for staleness, not just title/price.
function makeDetail(summary: ListingSummary, partDescription: string): ListingDetail {
  return {
    ...summary,
    expectedParts: [
      {
        id: `${summary.id}-part-1`,
        listingId: summary.id,
        componentCategory: 'GPU',
        brand: null,
        partNumber: null,
        description: partDescription,
        estimatedResaleValue: summary.comparison.totalExpectedResaleValue,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ],
  };
}

const listingA = makeListing('listing-A', 'Listing A Stale Title', 100);
const listingB = makeListing('listing-B', 'Listing B Fresh Title', 200);
const detailA = makeDetail(listingA, 'Stale GPU from A');
const detailB = makeDetail(listingB, 'Fresh GPU from B');

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
  fetchListingMock.mockReset();
  createListingMock.mockReset();
  updateListingMock.mockReset();
});

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(<ListingsPage />);
  });
  return container;
}

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

function findTitleButton(el: HTMLElement, title: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === title);
  if (!button) {
    throw new Error(`No title button found for "${title}"`);
  }
  return button as HTMLButtonElement;
}

describe('ListingsPage inline edit stale-fetch race (MUST FIX)', () => {
  it('cross-listing: ends up holding the last-clicked listing\'s own data, not an earlier click\'s slower-resolving detail', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });

    // A's fetch is held open on a controlled promise (simulating the slow
    // network leg); B's resolves immediately, as it would when its request
    // completes first despite being issued second.
    const deferredA = Promise.withResolvers<ListingDetail>();
    fetchListingMock.mockImplementation((id: string) => {
      if (id === listingA.id) return deferredA.promise;
      if (id === listingB.id) return Promise.resolve(detailB);
      throw new Error(`unexpected fetchListing id: ${id}`);
    });

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);

    // Click A: starts its fetch, which stays pending.
    await act(async () => {
      findTitleButton(el, listingA.title).click();
    });
    expect(fetchListingMock).toHaveBeenCalledWith(listingA.id);

    // Before A resolves, click B: closes A's row, opens B's, and B's fetch
    // resolves immediately since it isn't gated.
    await act(async () => {
      findTitleButton(el, listingB.title).click();
    });
    expect(fetchListingMock).toHaveBeenCalledWith(listingB.id);

    // T2's CollapsibleSection for Listing Details: starts collapsed when
    // editing, so title/price inputs aren't mounted until expanded.
    await act(async () => {
      const listingDetailsButton = Array.from(el.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Listing Details'),
      ) as HTMLButtonElement | null;
      if (listingDetailsButton?.getAttribute('aria-expanded') === 'false') {
        listingDetailsButton.click();
      }
    });

    await waitFor(() => (el.querySelector('#listing-title') as HTMLInputElement | null)?.value === listingB.title);

    // Now let A's slower fetch resolve, after B has already opened and
    // rendered. Without the stale-response guard this overwrites
    // editingListing with A's detail even though editingListingId is B
    // (it doesn't visibly corrupt the DOM here, since ListingForm already
    // mounted with B's data and never re-syncs to a changed initialValue —
    // the second test below covers the case where that masking doesn't
    // apply — but the underlying state must still end up correct).
    await act(async () => {
      deferredA.resolve(detailA);
      await deferredA.promise;
    });
    // Flush the resolved microtask's state updates.
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    });

    const titleInput = el.querySelector('#listing-title') as HTMLInputElement | null;
    const priceInput = el.querySelector('#listing-asking-price') as HTMLInputElement | null;
    // T3's per-row CollapsibleSection: a row seeded from already-saved data
    // starts collapsed, so its description input isn't mounted until the
    // row is expanded — expand it to read the staleness-proving value.
    await act(async () => {
      (el.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null)?.click();
    });
    const partDescriptionInput = el.querySelector('[aria-label="Expected part 1 description"]') as HTMLInputElement | null;
    if (!titleInput || !priceInput || !partDescriptionInput) {
      throw new Error('Expected the inline edit form to still be open after A resolves');
    }
    expect(titleInput.value).toBe(listingB.title);
    expect(priceInput.value).toBe(String(listingB.askingPrice));
    expect(partDescriptionInput.value).toBe('Fresh GPU from B');
    expect(partDescriptionInput.value).not.toBe('Stale GPU from A');
  }, 10_000);

  it('same-listing reopen: a stale first-click fetch resolving after the row is closed and reopened must not flip the still-loading second attempt over to its own stale detail', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });

    // Two distinct fetches for the SAME listing id: the first click's
    // (stale — represents, e.g., a price that's since been edited
    // elsewhere) and the second, reopened click's (fresh/correct). Both
    // are held open on controlled promises so the test can resolve them in
    // a specific order.
    const staleDetailA = makeDetail(listingA, 'Stale GPU from first open');
    const freshDetailA = makeDetail({ ...listingA, askingPrice: 150 }, 'Fresh GPU from reopen');
    const deferredFirst = Promise.withResolvers<ListingDetail>();
    const deferredSecond = Promise.withResolvers<ListingDetail>();
    let fetchCallCount = 0;
    fetchListingMock.mockImplementation((id: string) => {
      if (id !== listingA.id) throw new Error(`unexpected fetchListing id: ${id}`);
      fetchCallCount += 1;
      return fetchCallCount === 1 ? deferredFirst.promise : deferredSecond.promise;
    });

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);

    // First click: opens A, starts the first (soon-to-be-stale) fetch.
    await act(async () => {
      findTitleButton(el, listingA.title).click();
    });
    // Close it again before that fetch resolves.
    await act(async () => {
      findTitleButton(el, listingA.title).click();
    });
    // Reopen: starts the second fetch. Still pending — the row shows its
    // loading state, not a form yet.
    await act(async () => {
      findTitleButton(el, listingA.title).click();
    });
    expect(fetchCallCount).toBe(2);
    expect(el.querySelector('#listing-title')).toBeNull();

    // The FIRST click's fetch resolves late, after the reopen, while the
    // second fetch is still pending. Without a per-request guard this
    // flips editingLoading to false and seeds ListingForm with the stale
    // detail — which then ignores the correct detail that arrives after,
    // since ListingForm only reads initialValue on mount.
    await act(async () => {
      deferredFirst.resolve(staleDetailA);
      await deferredFirst.promise;
    });
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    });

    // Now let the second (correct) fetch resolve.
    await act(async () => {
      deferredSecond.resolve(freshDetailA);
      await deferredSecond.promise;
    });
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 10);
      await promise;
    });
    // T2's CollapsibleSection for Listing Details: starts collapsed when
    // editing, so title/price inputs aren't mounted until expanded.
    await act(async () => {
      const listingDetailsButton = Array.from(el.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Listing Details'),
      ) as HTMLButtonElement | null;
      if (listingDetailsButton?.getAttribute('aria-expanded') === 'false') {
        listingDetailsButton.click();
      }
    });

    // T2's CollapsibleSection for Listing Details: starts collapsed when
    // editing, so title/price inputs aren't mounted until expanded.
    await act(async () => {
      const listingDetailsButton = Array.from(el.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Listing Details'),
      ) as HTMLButtonElement | null;
      if (listingDetailsButton?.getAttribute('aria-expanded') === 'false') {
        listingDetailsButton.click();
      }
    });


    const titleInput = el.querySelector('#listing-title') as HTMLInputElement | null;
    const priceInput = el.querySelector('#listing-asking-price') as HTMLInputElement | null;
    await act(async () => {
      (el.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null)?.click();
    });
    const partDescriptionInput = el.querySelector('[aria-label="Expected part 1 description"]') as HTMLInputElement | null;
    if (!titleInput || !priceInput || !partDescriptionInput) {
      throw new Error('Expected the inline edit form to be open after the second (reopen) fetch resolves');
    }
    expect(priceInput.value).toBe(String(freshDetailA.askingPrice));
    expect(partDescriptionInput.value).toBe('Fresh GPU from reopen');
    expect(partDescriptionInput.value).not.toBe('Stale GPU from first open');
  }, 10_000);
});
