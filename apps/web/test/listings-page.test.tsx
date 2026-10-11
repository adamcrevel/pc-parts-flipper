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
import { MemoryRouter } from 'react-router-dom';
import type { ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingsPage } from '../src/routes/listings-page';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchListingsMock = vi.fn();
const fetchListingMock = vi.fn();
const createListingMock = vi.fn();
const updateListingMock = vi.fn();
const fetchListingIdsMock = vi.fn();
const acceptListingMock = vi.fn();
const rejectListingMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  fetchListings: (...args: unknown[]) => fetchListingsMock(...args),
  fetchListing: (...args: unknown[]) => fetchListingMock(...args),
  createListing: (...args: unknown[]) => createListingMock(...args),
  updateListing: (...args: unknown[]) => updateListingMock(...args),
  // Req 2/6: ListingsPage (expanded per T3) always fetches the full
  // filtered id set on mount/filter-change and calls accept/reject from
  // row actions, so every mock here must cover the full api surface it
  // imports, not just the fields the inline-edit-race tests exercise.
  fetchListingIds: (...args: unknown[]) => fetchListingIdsMock(...args),
  acceptListing: (...args: unknown[]) => acceptListingMock(...args),
  rejectListing: (...args: unknown[]) => rejectListingMock(...args),
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
    identifyPartsStatus: null,
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
  fetchListingIdsMock.mockReset();
  acceptListingMock.mockReset();
  rejectListingMock.mockReset();
});

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <MemoryRouter>
        <ListingsPage />
      </MemoryRouter>,
    );
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

function findButton(el: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!button) {
    throw new Error(`No button found with text "${text}"`);
  }
  return button as HTMLButtonElement;
}

describe('ListingsPage inline edit stale-fetch race (MUST FIX)', () => {
  it('cross-listing: ends up holding the last-clicked listing\'s own data, not an earlier click\'s slower-resolving detail', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

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
    fetchListingIdsMock.mockResolvedValue([]);

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

// T7: ported from listings-queue-page.test.tsx (now deleted — ListingsQueuePage
// no longer exists, merged into ListingsPage per the consolidate-listings-views
// feature). Proves Req 6's pagination-clamp-on-empty-page behavior against the
// merged screen: reproduces the bug where accepting the last Listing on a
// filtered page left `page` unclamped, stranding the user on an empty page with
// no way back since PaginationControls renders nothing once pageCount<=1.
describe('ListingsPage pagination clamp (T7 MUST FIX)', () => {
  const PAGE_SIZE = 20;

  it('clamps back to the last valid page after an accept empties the current (non-first) page, instead of stranding the user', async () => {
    // 21 open Listings: page 1 holds 20, page 2 holds exactly 1 — accepting
    // that one row on page 2 drops the total to 20, which no longer has a
    // page 2 at all.
    let listings = Array.from({ length: 21 }, (_, i) => makeListing(`listing-${i}`, `Listing ${i}`, 100));

    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    fetchListingIdsMock.mockResolvedValue([]);
    acceptListingMock.mockImplementation((id: string) => {
      listings = listings.filter((l) => l.id !== id);
      return Promise.resolve({ listing: { ...makeListing('listing-0', 'Listing 0', 100), id, status: 'accepted' }, purchaseId: 'purchase-1' });
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// T3-tester: Req 5 — accepting/rejecting a Listing from its row. Proves the
// confirmation banner (with its link to the created Purchase), the per-row
// pending-disable (Req 4), and that both actions refresh the table
// afterward, against the real ListingsPage (not a reimplementation).
describe('ListingsPage accept/reject (Req 5)', () => {
  it("accepting shows a dismissable confirmation naming the created Purchase with a link to it, disables only that row's own Accept/Reject while its request is in flight, and refreshes the table afterward", async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

    const deferredAccept = Promise.withResolvers<{ listing: ListingSummary; purchaseId: string }>();
    acceptListingMock.mockImplementation(() => deferredAccept.promise);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);
    expect(fetchListingsMock).toHaveBeenCalledTimes(1);

    function rowFor(title: string): HTMLTableRowElement {
      const row = Array.from(el.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes(title));
      if (!row) throw new Error(`No row found for "${title}"`);
      return row as HTMLTableRowElement;
    }
    function rowButton(row: HTMLTableRowElement, text: string): HTMLButtonElement {
      const button = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === text);
      if (!button) throw new Error(`No "${text}" button found in row`);
      return button as HTMLButtonElement;
    }

    expect(rowButton(rowFor(listingA.title), 'Accept').disabled).toBe(false);

    await act(async () => {
      rowButton(rowFor(listingA.title), 'Accept').click();
    });
    expect(acceptListingMock).toHaveBeenCalledWith(listingA.id);
    // Req 4: only the clicked row's own buttons disable; an unrelated row's
    // Accept stays clickable while A's request is still in flight. Queried
    // fresh (not a pre-click cached reference) so the assertion reads the
    // DOM as it is after this render, not whatever it was before the click.
    expect(rowButton(rowFor(listingA.title), 'Accept').disabled).toBe(true);
    expect(rowButton(rowFor(listingA.title), 'Reject').disabled).toBe(true);
    expect(rowButton(rowFor(listingB.title), 'Accept').disabled).toBe(false);

    await act(async () => {
      deferredAccept.resolve({ listing: { ...listingA, status: 'accepted' }, purchaseId: 'purchase-99' });
      await deferredAccept.promise;
    });
    await waitFor(() => fetchListingsMock.mock.calls.length === 2);

    expect(el.textContent).toContain(`Accepted "${listingA.title}" — created Purchase purchase-99.`);
    const purchaseLink = Array.from(el.querySelectorAll('a')).find((a) => a.textContent === 'View Purchase') as HTMLAnchorElement | undefined;
    expect(purchaseLink).toBeDefined();
    expect(purchaseLink?.getAttribute('href')).toBe('/purchases/purchase-99');
  }, 10_000);

  it('rejecting a listing calls rejectListing for that row and refreshes the table, without showing an accept-style confirmation', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA], total: 1 });
    fetchListingIdsMock.mockResolvedValue([]);
    rejectListingMock.mockResolvedValue({ ...listingA, status: 'rejected' });

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 1);
    expect(fetchListingsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(el, 'Reject').click();
    });
    await waitFor(() => fetchListingsMock.mock.calls.length === 2);

    expect(rejectListingMock).toHaveBeenCalledWith(listingA.id);
    expect(el.textContent).not.toContain('created Purchase');
  }, 10_000);
});

// T3-tester: Req 12 — the Add Listing button still opens the top-of-page
// create form (unaffected by the Req 2-10 expansion), and a successful
// create refreshes the table so the new row shows up in it.
describe('ListingsPage Add Listing create flow (Req 12)', () => {
  it('opens the top-of-page create form from the Add Listing button, and a successful create refreshes the table so the new row appears', async () => {
    fetchListingsMock.mockResolvedValueOnce({ listings: [listingA], total: 1 });
    fetchListingIdsMock.mockResolvedValue([]);

    const newListing = makeListing('listing-new', 'Brand New Listing', 250);
    const newDetail = makeDetail(newListing, 'New part');
    createListingMock.mockResolvedValue(newDetail);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 1);
    expect(fetchListingsMock).toHaveBeenCalledTimes(1);
    expect(el.querySelector('#listing-title')).toBeNull();

    await act(async () => {
      findButton(el, 'Add Listing').click();
    });

    const titleInput = el.querySelector('#listing-title') as HTMLInputElement | null;
    const urlInput = el.querySelector('#listing-url') as HTMLInputElement | null;
    const sourceSelect = el.querySelector('#listing-source') as HTMLSelectElement | null;
    const priceInput = el.querySelector('#listing-asking-price') as HTMLInputElement | null;
    const dateInput = el.querySelector('#listing-date') as HTMLInputElement | null;
    if (!titleInput || !urlInput || !sourceSelect || !priceInput || !dateInput) {
      throw new Error('Expected the create form fields to be mounted after clicking Add Listing');
    }

    await act(async () => {
      setInputValue(titleInput, newListing.title);
      setInputValue(urlInput, 'https://example.com/listing');
      sourceSelect.value = 'source-1';
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
      setInputValue(priceInput, String(newListing.askingPrice));
      setInputValue(dateInput, '2024-02-01');
    });

    fetchListingsMock.mockResolvedValueOnce({ listings: [listingA, newListing], total: 2 });

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => fetchListingsMock.mock.calls.length === 2);

    expect(createListingMock).toHaveBeenCalledTimes(1);
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);
    expect(el.textContent).toContain('Brand New Listing');
  }, 10_000);
});


// T3: sortable column headers (Req 2-4, 7, 8). ListingsPage owns the sort
// state; the assertions below read the options object handed to
// fetchListings, which is what actually determines the server-side order of
// the whole filtered dataset — the rendered row order on a mocked page
// would prove nothing about it.
describe('ListingsPage sortable columns (T3)', () => {
  const PAGE_SIZE = 20;

  function lastFetchOptions(): { sortBy?: string; sortDirection?: string; offset?: number; status?: string; sourceId?: string } {
    const calls = fetchListingsMock.mock.calls;
    return calls[calls.length - 1][0] as { sortBy?: string; sortDirection?: string; offset?: number; status?: string; sourceId?: string };
  }

  // Clicks a column header and waits for the reload the sort change
  // triggers, so the assertions read the request carrying the new sort
  // rather than the previous one.
  async function clickHeader(el: HTMLElement, label: string) {
    const callsBefore = fetchListingsMock.mock.calls.length;
    await act(async () => {
      findButton(el, label).click();
    });
    await waitFor(() => fetchListingsMock.mock.calls.length > callsBefore);
  }

  it('fetches with no sort params at all until a header is clicked (Req 9: the existing default order is untouched)', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);

    expect(fetchListingsMock).toHaveBeenCalledTimes(1);
    expect(lastFetchOptions().sortBy).toBeUndefined();
    expect(lastFetchOptions().sortDirection).toBeUndefined();
  }, 10_000);

  it('clicking an inactive header sorts by that field ascending; clicking it again reverses direction without changing the field (Req 2-3)', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);

    await clickHeader(el, 'Asking Price');
    expect(lastFetchOptions().sortBy).toBe('askingPrice');
    expect(lastFetchOptions().sortDirection).toBe('asc');

    await clickHeader(el, 'Asking Price');
    expect(lastFetchOptions().sortBy).toBe('askingPrice');
    expect(lastFetchOptions().sortDirection).toBe('desc');

    // A third click comes back to ascending rather than sticking on desc.
    await clickHeader(el, 'Asking Price');
    expect(lastFetchOptions().sortBy).toBe('askingPrice');
    expect(lastFetchOptions().sortDirection).toBe('asc');
  }, 10_000);

  it('clicking a different header replaces the active field outright, restarting at ascending rather than combining or keeping the old direction (Req 2, 4)', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);

    // Leave the first column active *descending*, so a replacement that
    // carried the old direction over would be visible.
    await clickHeader(el, 'Title');
    await clickHeader(el, 'Title');
    expect(lastFetchOptions().sortDirection).toBe('desc');

    await clickHeader(el, 'Expected Profit');
    const options = lastFetchOptions();
    expect(options.sortBy).toBe('difference');
    expect(options.sortDirection).toBe('asc');
    // Only one field is ever sorted by: the request carries a single
    // sortBy, and the previously active column's arrow is gone.
    expect(Object.keys(options).filter((key) => key.startsWith('sort'))).toEqual(['sortBy', 'sortDirection']);
    const titleHeader = findButton(el, 'Title').closest('th') as HTMLTableCellElement;
    const differenceHeader = findButton(el, 'Expected Profit').closest('th') as HTMLTableCellElement;
    expect(titleHeader.getAttribute('aria-sort')).toBe('none');
    expect(titleHeader.querySelector('[aria-label^="Sorted"]')).toBeNull();
    expect(differenceHeader.getAttribute('aria-sort')).toBe('ascending');
  }, 10_000);

  it('resets to page 1 when the sort changes, instead of keeping the old offset into a now-differently-ordered dataset (Req 7)', async () => {
    const listings = Array.from({ length: 21 }, (_, i) => makeListing(`listing-${i}`, `Listing ${i}`, 100 + i));
    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    fetchListingIdsMock.mockResolvedValue([]);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);

    await act(async () => {
      findButton(el, 'Next').click();
    });
    await waitFor(() => lastFetchOptions().offset === PAGE_SIZE);
    expect(el.textContent).toContain('Page 2 of 2 (21 total)');

    await clickHeader(el, 'Status');
    expect(lastFetchOptions().sortBy).toBe('status');
    expect(lastFetchOptions().offset).toBe(0);
    expect(el.textContent).toContain('Page 1 of 2 (21 total)');
  }, 10_000);

  it('keeps the active sort when a filter changes — the two compose instead of clearing each other (Req 8)', async () => {
    fetchListingsMock.mockResolvedValue({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);

    await clickHeader(el, 'Expected Resale');
    await clickHeader(el, 'Expected Resale');
    expect(lastFetchOptions().sortDirection).toBe('desc');

    // The status select is the first of the two filter selects.
    const statusSelect = el.querySelectorAll('select')[0] as HTMLSelectElement;
    await act(async () => {
      statusSelect.value = 'accepted';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => lastFetchOptions().status === 'accepted');

    const options = lastFetchOptions();
    expect(options.sortBy).toBe('expectedResale');
    expect(options.sortDirection).toBe('desc');
    // ...and the header still shows it, not just the request.
    const header = findButton(el, 'Expected Resale').closest('th') as HTMLTableCellElement;
    expect(header.getAttribute('aria-sort')).toBe('descending');
  }, 10_000);
});

// Req 6-8: the host page's own loading-state wiring — shows the indicator
// and disables the sort headers for a user-triggered refetch, but never
// for the silent Req 12 background poll.
describe('ListingsPage loading state (Req 6-8)', () => {
  it('shows the loading indicator and disables the sort headers while a sort-triggered fetch is pending, then clears both once it resolves', async () => {
    fetchListingsMock.mockResolvedValueOnce({ listings: [listingA, listingB], total: 2 });
    fetchListingIdsMock.mockResolvedValue([]);

    const el = await mount();
    await waitFor(() => el.querySelectorAll('tbody tr').length === 2);
    expect(el.querySelector('[role="status"]')).toBeNull();

    const { promise, resolve } = Promise.withResolvers<{ listings: ListingSummary[]; total: number }>();
    fetchListingsMock.mockReturnValueOnce(promise);

    const callsBefore = fetchListingsMock.mock.calls.length;
    await act(async () => {
      findButton(el, 'Title').click();
    });
    await waitFor(() => fetchListingsMock.mock.calls.length > callsBefore);

    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(findButton(el, 'Title').disabled).toBe(true);

    await act(async () => {
      resolve({ listings: [listingA, listingB], total: 2 });
      await promise;
    });
    await waitFor(() => el.querySelector('[role="status"]') === null);

    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(findButton(el, 'Title').disabled).toBe(false);
  }, 10_000);

  it('does not show the loading indicator or disable the headers for the silent Req 12 polling reload', async () => {
    vi.useFakeTimers();
    try {
      fetchListingsMock.mockResolvedValueOnce({
        listings: [{ ...listingA, identifyPartsStatus: { stage: 'identifying', errorMessage: null } }],
        total: 1,
      });
      fetchListingIdsMock.mockResolvedValue([listingA.id]);

      const el = await mount();
      expect(fetchListingsMock).toHaveBeenCalledTimes(1);
      expect(el.querySelector('[role="status"]')).toBeNull();

      // Hold the poll's own fetch open, so the assertions below land
      // while it's actually pending — a mutation that made the poll
      // non-silent would show the indicator/disable the header during
      // exactly this window; checking only after it resolves (near
      // instantly, under fake timers) would never observe that.
      const { promise, resolve } = Promise.withResolvers<{ listings: ListingSummary[]; total: number }>();
      fetchListingsMock.mockReturnValueOnce(promise);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(fetchListingsMock).toHaveBeenCalledTimes(2);
      expect(el.querySelector('[role="status"]')).toBeNull();
      expect(findButton(el, 'Title').disabled).toBe(false);

      await act(async () => {
        resolve({ listings: [{ ...listingA, identifyPartsStatus: { stage: 'completed', errorMessage: null } }], total: 1 });
        await promise;
      });
      expect(el.querySelector('[role="status"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});
