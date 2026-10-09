// @vitest-environment jsdom
//
// T6 client wiring for the bulk Identify-Parts run: the fixed bottom action
// bar (Req 8/9) and the Listings Queue page's selection/refetch/polling
// behaviour (Req 2/4/12). Mounts the real components (not reimplementations)
// with listings-api/sources-api mocked, following listings-queue-page.test.tsx's
// react-dom/client + act() mounting pattern (no RTL dependency in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import type { IdentifyPartsBulkResult, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingsPage } from '../src/routes/listings-page';
import { BulkIdentifyPartsBar } from '../src/features/listings/bulk-identify-parts-bar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchListingsMock = vi.fn();
const fetchListingIdsMock = vi.fn();
const enqueueBulkIdentifyPartsMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  fetchListings: (...args: unknown[]) => fetchListingsMock(...args),
  fetchListingIds: (...args: unknown[]) => fetchListingIdsMock(...args),
  enqueueBulkIdentifyParts: (...args: unknown[]) => enqueueBulkIdentifyPartsMock(...args),
  acceptListing: () => Promise.resolve({ purchaseId: 'purchase-1' }),
  rejectListing: () => Promise.resolve(),
}));

vi.mock('@/features/sources/sources-api', () => ({
  fetchSources: () => Promise.resolve<Source[]>([
    { id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
  ]),
}));

const PAGE_SIZE = 20;

function makeListing(index: number, overrides: Partial<ListingSummary> = {}): ListingSummary {
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
    ...overrides,
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
  fetchListingIdsMock.mockReset();
  enqueueBulkIdentifyPartsMock.mockReset();
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

// Polls the DOM until `predicate` is true, flushing React's act() queue (and
// real macrotask-scheduled promise continuations) between checks.
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
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

// Non-throwing counterpart to findButton: returns null instead of throwing,
// so a test can assert a button is absent (e.g. the bulk action bar not
// rendering while nothing is selected) without wrapping the lookup in its
// own try/catch.
function queryButton(el: HTMLElement, text: string): HTMLButtonElement | null {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text);
  return (button as HTMLButtonElement | undefined) ?? null;
}

function checkbox(el: HTMLElement, label: string): HTMLInputElement {
  const input = el.querySelector(`input[aria-label="${label}"]`);
  if (!input) {
    throw new Error(`No checkbox found with label "${label}"`);
  }
  return input as HTMLInputElement;
}

describe('BulkIdentifyPartsBar (Req 8/9)', () => {
  it('reports queued, already-running and not-found counts distinctly, and clears the selection once the request completes', async () => {
    const results: IdentifyPartsBulkResult[] = [
      { listingId: 'listing-1', outcome: 'queued' },
      { listingId: 'listing-2', outcome: 'queued' },
      { listingId: 'listing-3', outcome: 'already_active' },
      { listingId: 'listing-4', outcome: 'not_found' },
    ];
    enqueueBulkIdentifyPartsMock.mockResolvedValue(results);
    let cleared = 0;

    const selectedIds = new Set(['listing-1', 'listing-2', 'listing-3', 'listing-4']);
    const el = await mount(<BulkIdentifyPartsBar selectedIds={selectedIds} onCleared={() => (cleared += 1)} />);

    expect(el.textContent).toContain('4 selected');

    await act(async () => {
      findButton(el, 'Identify Parts').click();
    });
    await waitFor(() => el.querySelector('[role="status"]') !== null);

    const banner = el.querySelector('[role="status"]') as HTMLElement;
    expect(enqueueBulkIdentifyPartsMock).toHaveBeenCalledWith(['listing-1', 'listing-2', 'listing-3', 'listing-4']);
    expect(banner.textContent).toContain('Queued 2 listing(s)');
    expect(banner.textContent).toContain('1 already running');
    expect(banner.textContent).toContain('1 not found');
    expect(cleared).toBe(1);
  });

  it('omits the already-running and not-found counts when every id was queued, rather than reporting zeroes', async () => {
    enqueueBulkIdentifyPartsMock.mockResolvedValue([{ listingId: 'listing-1', outcome: 'queued' }] satisfies IdentifyPartsBulkResult[]);
    const el = await mount(<BulkIdentifyPartsBar selectedIds={new Set(['listing-1'])} onCleared={() => {}} />);

    await act(async () => {
      findButton(el, 'Identify Parts').click();
    });
    await waitFor(() => el.querySelector('[role="status"]') !== null);

    const banner = el.querySelector('[role="status"]') as HTMLElement;
    expect(banner.textContent).toContain('Queued 1 listing(s)');
    expect(banner.textContent).not.toContain('not found');
    expect(banner.textContent).not.toContain('already running');
  });

  it('keeps the selection intact when the request itself fails, so the user can retry', async () => {
    enqueueBulkIdentifyPartsMock.mockRejectedValue(new Error('network down'));
    let cleared = 0;
    const el = await mount(<BulkIdentifyPartsBar selectedIds={new Set(['listing-1'])} onCleared={() => (cleared += 1)} />);

    await act(async () => {
      findButton(el, 'Identify Parts').click();
    });
    await waitFor(() => el.querySelector('[role="alert"]') !== null);

    expect(cleared).toBe(0);
    expect((el.querySelector('[role="alert"]') as HTMLElement).textContent).toContain('Failed to start bulk identify parts.');
    // The button is usable again rather than stuck in its loading state.
    expect(findButton(el, 'Identify Parts').disabled).toBe(false);
    expect(el.textContent).toContain('1 selected');
  });

  it('renders nothing while nothing is selected and no result is outstanding', async () => {
    const el = await mount(<BulkIdentifyPartsBar selectedIds={new Set()} onCleared={() => {}} />);
    expect(el.textContent).toBe('');
  });
});

describe('ListingsPage selection wiring (Req 2/4/12)', () => {
  it('keeps a selection made on page 1 while the user pages away and back', async () => {
    const listings = Array.from({ length: 21 }, (_, i) => makeListing(i));
    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    fetchListingIdsMock.mockResolvedValue(listings.map((l) => l.id));

    const el = await mount(
      <MemoryRouter>
        <ListingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);

    await act(async () => {
      checkbox(el, 'Select Listing 0').click();
    });
    expect(el.textContent).toContain('1 selected');

    await act(async () => {
      findButton(el, 'Next').click();
    });
    await waitFor(() => el.querySelectorAll('tbody tr').length === 1);
    // Still selected while the selected row isn't even on screen.
    expect(el.textContent).toContain('1 selected');

    await act(async () => {
      findButton(el, 'Previous').click();
    });
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);
    expect(checkbox(el, 'Select Listing 0').checked).toBe(true);
    expect(el.textContent).toContain('1 selected');

    // Req 1: the same row checkbox deselects, it doesn't re-add.
    await act(async () => {
      checkbox(el, 'Select Listing 0').click();
    });
    expect(checkbox(el, 'Select Listing 0').checked).toBe(false);
    expect(el.textContent).not.toContain('selected');
  });

  it('keeps a selection intact across a filter change, and shows the fixed action bar exactly while something is selected (Req 2/4/5)', async () => {
    const listings = Array.from({ length: 21 }, (_, i) => makeListing(i));
    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    fetchListingIdsMock.mockResolvedValue(listings.map((l) => l.id));

    const el = await mount(
      <MemoryRouter>
        <ListingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);

    // Req 5: no selection yet, so the fixed bar (and its button) isn't rendered.
    expect(queryButton(el, 'Identify Parts')).toBeNull();
    expect(el.textContent).not.toContain('selected');

    await act(async () => {
      checkbox(el, 'Select Listing 0').click();
      checkbox(el, 'Select Listing 1').click();
    });
    // Req 5: becomes non-empty -> the bar appears with the exact count.
    expect(el.textContent).toContain('2 selected');
    expect(queryButton(el, 'Identify Parts')).not.toBeNull();

    const statusSelect = el.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      statusSelect.value = 'open';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => fetchListingIdsMock.mock.calls.length === 2);

    // Req 4: the filter change refetched the id set and reset to page 1,
    // but the selection made under the prior filter is untouched.
    expect(el.textContent).toContain('2 selected');
    expect(checkbox(el, 'Select Listing 0').checked).toBe(true);
    expect(checkbox(el, 'Select Listing 1').checked).toBe(true);
    expect(queryButton(el, 'Identify Parts')).not.toBeNull();
  });

  it('refetches the filtered id set when the filter changes, but not when the page changes (Req 2)', async () => {
    const listings = Array.from({ length: 21 }, (_, i) => makeListing(i));
    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    fetchListingIdsMock.mockResolvedValue(listings.map((l) => l.id));

    const el = await mount(
      <MemoryRouter>
        <ListingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);
    expect(fetchListingIdsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(el, 'Next').click();
    });
    await waitFor(() => el.querySelectorAll('tbody tr').length === 1);
    expect(fetchListingIdsMock).toHaveBeenCalledTimes(1);

    const statusSelect = el.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      statusSelect.value = 'open';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => fetchListingIdsMock.mock.calls.length === 2);
    expect(fetchListingIdsMock).toHaveBeenLastCalledWith({ status: 'open', sourceId: undefined });
  });

  it('selects every filtered id across all pages from the header checkbox (Req 2/3)', async () => {
    const listings = Array.from({ length: 21 }, (_, i) => makeListing(i));
    fetchListingsMock.mockImplementation(({ limit, offset }: { limit: number; offset: number }) =>
      Promise.resolve({ listings: listings.slice(offset, offset + limit), total: listings.length }),
    );
    fetchListingIdsMock.mockResolvedValue(listings.map((l) => l.id));

    const el = await mount(
      <MemoryRouter>
        <ListingsPage />
      </MemoryRouter>,
    );
    await waitFor(() => el.querySelectorAll('tbody tr').length === PAGE_SIZE);

    await act(async () => {
      checkbox(el, 'Select all filtered listings').click();
    });
    // 21, not the 20 rows the current page shows.
    expect(el.textContent).toContain('21 selected');

    await act(async () => {
      checkbox(el, 'Select all filtered listings').click();
    });
    expect(el.textContent).not.toContain('selected');
  });

  it('polls every 2s while a visible row is still running, and stops once none is (Req 12)', async () => {
    // Fake timers only for this test (not a file-wide beforeEach, since the
    // rest of this file's waitFor/sleep helpers rely on real setTimeout) —
    // the same vi.useFakeTimers()/vi.advanceTimersByTimeAsync pattern
    // identify-parts.test.tsx uses to prove its own 2000ms job poll.
    vi.useFakeTimers();
    try {
      let status: ListingSummary['identifyPartsStatus'] = { stage: 'identifying', errorMessage: null };
      fetchListingsMock.mockImplementation(() => Promise.resolve({ listings: [makeListing(0, { identifyPartsStatus: status })], total: 1 }));
      fetchListingIdsMock.mockResolvedValue(['listing-0']);

      const el = await mount(
        <MemoryRouter>
          <ListingsPage />
        </MemoryRouter>,
      );
      expect(el.querySelectorAll('tbody tr').length).toBe(1);
      expect(fetchListingsMock).toHaveBeenCalledTimes(1);

      // Req 12 "starts": just short of 2000ms, the interval has not fired yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(fetchListingsMock).toHaveBeenCalledTimes(1);

      // The job settles to a terminal stage before the poll that will see it.
      status = { stage: 'completed', errorMessage: null };
      // Crossing 2000ms fires the interval exactly once, delivering the now-terminal row.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchListingsMock).toHaveBeenCalledTimes(2);

      // Req 12 "stops": the only visible row is now terminal, so the
      // effect's cleanup must have torn the interval down — advancing
      // through several more 2000ms periods must not produce a third load.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(fetchListingsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-fetches listings when a bulk identify-parts click completes, so just-queued rows refresh their stale status (Req 12 + T8)', async () => {
    // Req 12 + T8: after a bulk run enqueues jobs, the page must re-fetch
    // the current page of listings so the newly-queued rows render their
    // real (non-terminal) identifyPartsStatus instead of keeping stale null,
    // which would otherwise prevent the polling effect from arming.
    fetchListingsMock.mockResolvedValue({
      listings: [
        makeListing(0, { identifyPartsStatus: null }),
        makeListing(1, { identifyPartsStatus: null }),
      ],
      total: 2,
    });
    fetchListingIdsMock.mockResolvedValue(['listing-0', 'listing-1']);
    enqueueBulkIdentifyPartsMock.mockResolvedValue([
      { listingId: 'listing-0', outcome: 'queued' },
      { listingId: 'listing-1', outcome: 'queued' },
    ] as IdentifyPartsBulkResult[]);

    const el = await mount(
      <MemoryRouter>
        <ListingsPage />
      </MemoryRouter>,
    );

    // Two rows render with no-job status (identifyPartsStatus: null).
    expect(el.querySelectorAll('tbody tr').length).toBe(2);
    expect(fetchListingsMock).toHaveBeenCalledTimes(1);

    // Select both rows via the header checkbox.
    const headerCheckbox = el.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
    expect(headerCheckbox).toBeTruthy();

    await act(async () => {
      headerCheckbox.click();
    });

    // The bulk "Identify Parts" button appears.
    const bulkButton = findButton(el, 'Identify Parts');
    expect(bulkButton).toBeTruthy();

    // Click it, triggering the bulk enqueue request.
    await act(async () => {
      bulkButton.click();
    });

    // Wait for the bulk request to complete and the result banner to appear.
    await waitFor(() => el.querySelector('[role="status"]') !== null);

    // The bulk request was made exactly once.
    expect(enqueueBulkIdentifyPartsMock).toHaveBeenCalledTimes(1);

    // T8: fetchListings must have been called again after the bulk
    // request resolved, so the page re-fetches and the rows' stale
    // identifyPartsStatus: null is replaced with their real status from
    // the server (which would be non-terminal if the enqueue succeeded).
    expect(fetchListingsMock).toHaveBeenCalledTimes(2);
  });
});
