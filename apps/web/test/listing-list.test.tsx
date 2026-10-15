// @vitest-environment jsdom
//
// Listings UI usability fixes: (1) a Listing's title is the click trigger
// for editing it (no separate Edit button/column), (2) a small photo icon
// renders after the title only when the Listing has photos, and (3)
// clicking a title opens that Listing's edit form inline — as an extra row
// directly below the clicked row, inside the same table — rather than in a
// panel above it, with only one such row open at a time. Mounts the real
// ListingList (not a reimplementation), with a small stateful harness
// standing in for ListingsPage's open/close + fetch wiring, following
// error-boundary.test.tsx's react-dom/client + act() mounting pattern (no
// RTL dependency in this workspace).
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useState } from 'react';
import type { CreateListingInput, ListingDetail, ListingSortDirection, ListingSortField, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingList } from '../src/features/listings/listing-list';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Builds one open ListingSummary, overridable per test — matches the
// fields the table/comparison columns and the photo icon render.
// `pricingStatus` defaults to 'fully_priced' (the common case: a
// fully-priced listing) so the pre-existing tests below, which never set
// it, render the Pricing Status column's badge exactly like every other
// untouched column default.
function makeListing(overrides: Partial<ListingSummary> = {}): ListingSummary {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Test Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    comparison: { totalExpectedResaleValue: 150, totalCost: 100, difference: 50 },
    identifyPartsStatus: null,
    pricingStatus: 'fully_priced',
    ...overrides,
  };
}

const sources: Source[] = [{ id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' }];

// Stands in for ListingsPage's open/close state + fetched ListingDetail,
// so these tests exercise ListingList's real click-to-open-inline wiring
// instead of reimplementing it. Treats the clicked ListingSummary as if it
// were the already-fetched ListingDetail (no Expected Parts) since the
// fetch itself is ListingsPage's concern, not ListingList's.
function Harness({
  listings,
  sortBy,
  sortDirection,
  onSortChange = () => {},
  isLoading,
}: {
  listings: ListingSummary[];
  sortBy?: ListingSortField;
  sortDirection?: ListingSortDirection;
  onSortChange?: (field: ListingSortField) => void;
  isLoading?: boolean;
}) {
  const [editingListingId, setEditingListingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const editingListing: ListingDetail | null = editingListingId === null ? null : { ...listings.find((l) => l.id === editingListingId)!, expectedParts: [] };
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const allFilteredIds = listings.map((listing) => listing.id);

  return (
    <ListingList
      listings={listings}
      sources={sources}
      sourcesById={sourcesById}
      editingListingId={editingListingId}
      editingListing={editingListing}
      editingLoading={false}
      onToggleEdit={(listing) => setEditingListingId((prev) => (prev === listing.id ? null : listing.id))}
      onSubmitEdit={(input: CreateListingInput) => Promise.resolve({ ...editingListing!, ...input })}
      onCancelEdit={() => setEditingListingId(null)}
      onSavedEdit={() => {}}
      onAccept={() => {}}
      onReject={() => {}}
      pendingListingId={null}
      allFilteredIds={allFilteredIds}
      selectedIds={selectedIds}
      onToggleOne={(id) =>
        setSelectedIds((current) => {
          const next = new Set(current);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        })
      }
      onToggleAllFiltered={() => {}}
      sortBy={sortBy}
      sortDirection={sortDirection}
      onSortChange={onSortChange}
      isLoading={isLoading}
      columnFilters={{}}
      onColumnFilterChange={() => {}}
    />
  );
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
});

// Mounts the harness. `sort` carries the optional active-sort props (and a
// click spy) the sortable-header tests need, plus the Req 6-8 `isLoading`
// flag the loading-state tests need; the older tests pass none and get the
// unsorted, not-loading default.
async function mount(
  listings: ListingSummary[],
  sort: { sortBy?: ListingSortField; sortDirection?: ListingSortDirection; onSortChange?: (field: ListingSortField) => void; isLoading?: boolean } = {},
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(<Harness listings={listings} sortBy={sort.sortBy} sortDirection={sort.sortDirection} onSortChange={sort.onSortChange} isLoading={sort.isLoading} />);
  });
  return container;
}

function findTitleButton(el: HTMLElement, title: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === title);
  if (!button) {
    throw new Error(`No title button found for "${title}"`);
  }
  return button as HTMLButtonElement;
}

// The row directly holding a Listing's title, status, price, etc. columns
// (as opposed to the inline edit row that may follow it).
function findListingRow(el: HTMLElement, title: string): HTMLTableRowElement {
  const row = Array.from(el.querySelectorAll('tr')).find((tr) => tr.textContent?.includes(title) && tr.querySelector('form') === null);
  if (!row) {
    throw new Error(`No listing row found for "${title}"`);
  }
  return row as HTMLTableRowElement;
}

function headerCells(el: HTMLElement): HTMLTableCellElement[] {
  return Array.from(el.querySelectorAll('thead th'));
}

function headerButton(el: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('thead button')).find((b) => b.textContent?.trim() === label);
  if (!button) {
    throw new Error(`No sortable header button found for "${label}"`);
  }
  return button as HTMLButtonElement;
}

describe('ListingList title click -> inline edit row', () => {
  it('has no trailing Edit button column — the title itself is the click trigger', async () => {
    const el = await mount([makeListing()]);
    expect(Array.from(el.querySelectorAll('button')).some((b) => b.textContent === 'Edit')).toBe(false);
    const titleButton = findTitleButton(el, 'Test Listing');
    expect(titleButton.tagName).toBe('BUTTON');
  });

  it('renders the photo icon after the title only when photoPaths is non-empty', async () => {
    const withPhotos = makeListing({ id: 'listing-1', title: 'Has Photos', photoPaths: ['/data/a.jpg'] });
    const withoutPhotos = makeListing({ id: 'listing-2', title: 'No Photos', photoPaths: [] });
    const el = await mount([withPhotos, withoutPhotos]);

    const photoRow = findListingRow(el, 'Has Photos');
    const noPhotoRow = findListingRow(el, 'No Photos');
    expect(photoRow.querySelector('[aria-label="Has photos"]')).not.toBeNull();
    expect(noPhotoRow.querySelector('[aria-label="Has photos"]')).toBeNull();
  });

  it('opens the clicked Listing\'s edit form inline, in the row directly below it (not a top-of-page panel)', async () => {
    const listingA = makeListing({ id: 'listing-1', title: 'Listing A' });
    const listingB = makeListing({ id: 'listing-2', title: 'Listing B' });
    const el = await mount([listingA, listingB]);

    expect(el.querySelector('form')).toBeNull();

    await act(async () => {
      findTitleButton(el, 'Listing A').click();
    });

    const rows = Array.from(el.querySelectorAll('tr'));
    const listingARowIndex = rows.findIndex((tr) => tr.textContent?.includes('Listing A') && tr.querySelector('form') === null);
    const formRowIndex = rows.findIndex((tr) => tr.querySelector('form') !== null);
    expect(formRowIndex).toBeGreaterThan(-1);
    // The form row is the very next row after Listing A's own row — proof
    // it's inline (an accordion row under the clicked Listing) rather than
    // rendered anywhere else, e.g. above the table.
    expect(formRowIndex).toBe(listingARowIndex + 1);
    expect(rows[formRowIndex].querySelector('td')?.getAttribute('colspan')).toBe('10');
  });

  it('opening a second Listing closes the first — only one inline edit row at a time', async () => {
    const listingA = makeListing({ id: 'listing-1', title: 'Listing A' });
    const listingB = makeListing({ id: 'listing-2', title: 'Listing B' });
    const el = await mount([listingA, listingB]);

    await act(async () => {
      findTitleButton(el, 'Listing A').click();
    });
    expect(el.querySelectorAll('form')).toHaveLength(1);

    await act(async () => {
      findTitleButton(el, 'Listing B').click();
    });

    const forms = el.querySelectorAll('form');
    expect(forms).toHaveLength(1);
    // The surviving form belongs to Listing B, not Listing A: its row sits
    // directly below Listing B's row.
    const rows = Array.from(el.querySelectorAll('tr'));
    const listingBRowIndex = rows.findIndex((tr) => tr.textContent?.includes('Listing B') && tr.querySelector('form') === null);
    const formRowIndex = rows.findIndex((tr) => tr.querySelector('form') !== null);
    expect(formRowIndex).toBe(listingBRowIndex + 1);
  });

  it('clicking the open row\'s title again collapses it back to a plain row', async () => {
    const el = await mount([makeListing()]);

    await act(async () => {
      findTitleButton(el, 'Test Listing').click();
    });
    expect(el.querySelector('form')).not.toBeNull();

    await act(async () => {
      findTitleButton(el, 'Test Listing').click();
    });
    expect(el.querySelector('form')).toBeNull();
  });

  it('the inline form\'s Cancel button collapses the row back to plain', async () => {
    const el = await mount([makeListing()]);

    await act(async () => {
      findTitleButton(el, 'Test Listing').click();
    });
    const cancelButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    expect(cancelButton).toBeDefined();

    await act(async () => {
      cancelButton.click();
    });

    expect(el.querySelector('form')).toBeNull();
  });
});

describe('ListingList Accept/Reject gating and per-row in-flight disable (Req 4)', () => {
  it('hides Accept/Reject entirely for a non-open row, and disables only the pending row\'s own buttons while a sibling open row stays enabled', async () => {
    const openA = makeListing({ id: 'listing-open-a', title: 'Open A', status: 'open' });
    const openB = makeListing({ id: 'listing-open-b', title: 'Open B', status: 'open' });
    const closedListing = makeListing({ id: 'listing-closed', title: 'Closed Listing', status: 'rejected' });

    container = document.createElement('div');
    await act(async () => {
      root = createRoot(container!);
      root!.render(
        <ListingList
          listings={[openA, openB, closedListing]}
          sources={sources}
          sourcesById={new Map(sources.map((source) => [source.id, source]))}
          editingListingId={null}
          editingListing={null}
          editingLoading={false}
          onToggleEdit={() => {}}
          onSubmitEdit={async () => {
            throw new Error('onSubmitEdit not exercised');
          }}
          onCancelEdit={() => {}}
          onSavedEdit={() => {}}
          onAccept={() => {}}
          onReject={() => {}}
          pendingListingId="listing-open-a"
          allFilteredIds={[]}
          selectedIds={new Set()}
          onToggleOne={() => {}}
          onToggleAllFiltered={() => {}}
          onSortChange={() => {}}
          columnFilters={{}}
          onColumnFilterChange={() => {}}
        />,
      );
    });

    // A non-open row (status 'rejected') renders no Accept/Reject buttons
    // at all — not merely disabled ones.
    const closedRow = findListingRow(container!, 'Closed Listing');
    const closedButtons = Array.from(closedRow.querySelectorAll('button')).map((b) => b.textContent);
    expect(closedButtons).not.toContain('Accept');
    expect(closedButtons).not.toContain('Reject');

    // Row A is the one named by pendingListingId: its own buttons are
    // disabled. Row B is a separate open row with no request in flight:
    // its buttons stay enabled — proof the disable is scoped to the
    // specific pending row, not every open row.
    const rowA = findListingRow(container!, 'Open A');
    const rowB = findListingRow(container!, 'Open B');
    const acceptA = Array.from(rowA.querySelectorAll('button')).find((b) => b.textContent === 'Accept') as HTMLButtonElement;
    const rejectA = Array.from(rowA.querySelectorAll('button')).find((b) => b.textContent === 'Reject') as HTMLButtonElement;
    const acceptB = Array.from(rowB.querySelectorAll('button')).find((b) => b.textContent === 'Accept') as HTMLButtonElement;
    const rejectB = Array.from(rowB.querySelectorAll('button')).find((b) => b.textContent === 'Reject') as HTMLButtonElement;

    expect(acceptA.disabled).toBe(true);
    expect(rejectA.disabled).toBe(true);
    expect(acceptB.disabled).toBe(false);
    expect(rejectB.disabled).toBe(false);
  });
});


// Sortable column headers (Req 1, 5, 10). ListingList holds no sort state
// of its own — it renders whichever field/direction it is handed and
// reports clicks upward — so these tests pin exactly that: which headers
// are clickable, which field each one reports, and that the direction
// arrow appears on the active column only.
describe('ListingList sortable column headers', () => {
  const SORTABLE_LABELS = ['Title', 'Source', 'Status', 'Asking Price', 'Expected Resale', 'Expected Profit', 'Sourcing Status', 'Pricing Status'];

  it('makes exactly the 8 data-bearing headers clickable, each reporting its own sort field, and leaves the checkbox and actions columns plain', async () => {
    const clicked: string[] = [];
    const el = await mount([makeListing()], { onSortChange: (field) => clicked.push(field) });

    const cells = headerCells(el);
    expect(cells).toHaveLength(10);
    // Req 10: neither the leading selection column nor the trailing
    // actions column carries a comparable value, so neither is clickable.
    expect(cells[0].querySelector('button')).toBeNull();
    expect(cells[9].querySelector('button')).toBeNull();
    expect(cells[0].getAttribute('aria-sort')).toBeNull();
    expect(cells[9].getAttribute('aria-sort')).toBeNull();
    // Every data column's header carries two buttons now — the sort
    // label and its filter trigger (T4/T5) — so 8 of each.
    expect(el.querySelectorAll('thead button:not([aria-label^="Filter by"])')).toHaveLength(8);
    expect(el.querySelectorAll('thead button[aria-label^="Filter by"]')).toHaveLength(8);
    expect(cells.slice(1, 9).map((cell) => cell.textContent?.trim())).toEqual(SORTABLE_LABELS);

    for (const label of SORTABLE_LABELS) {
      await act(async () => {
        headerButton(el, label).click();
      });
    }
    // Each header must report its own field, in the shared
    // ListingSortField vocabulary — not a label string or a neighbour's
    // field.
    expect(clicked).toEqual(['title', 'source', 'status', 'askingPrice', 'expectedResale', 'difference', 'identifyParts', 'unpriced']);
  });

  it('renders no direction arrow on any header while nothing is sorted', async () => {
    const el = await mount([makeListing()]);
    expect(el.querySelectorAll('thead [aria-label^="Sorted"]')).toHaveLength(0);
    expect(headerCells(el).map((cell) => cell.getAttribute('aria-sort'))).toEqual([
      null, 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', null,
    ]);
  });

  it('renders an ascending arrow on the active column only, and on no other header', async () => {
    const el = await mount([makeListing()], { sortBy: 'askingPrice', sortDirection: 'asc' });

    const arrows = Array.from(el.querySelectorAll('thead [aria-label^="Sorted"]'));
    expect(arrows).toHaveLength(1);
    expect(arrows[0].getAttribute('aria-label')).toBe('Sorted ascending');
    // The one arrow is inside the Asking Price header, not merely somewhere
    // in the row.
    expect(headerButton(el, 'Asking Price').contains(arrows[0])).toBe(true);
    expect(headerCells(el).map((cell) => cell.getAttribute('aria-sort'))).toEqual([
      null, 'none', 'none', 'none', 'ascending', 'none', 'none', 'none', 'none', null,
    ]);
  });

  it('renders a descending arrow — a different icon from the ascending one — when the active direction is desc', async () => {
    const ascending = await mount([makeListing()], { sortBy: 'difference', sortDirection: 'asc' });
    // The drawn glyph only — the svg's child paths, excluding the
    // aria-label on the svg itself, so the comparison below cannot pass on
    // a differing label alone while both directions draw the same arrow.
    const ascendingGlyph = ascending.querySelector('thead [aria-label^="Sorted"]')!.innerHTML;

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const el = await mount([makeListing()], { sortBy: 'difference', sortDirection: 'desc' });
    const arrows = Array.from(el.querySelectorAll('thead [aria-label^="Sorted"]'));
    expect(arrows).toHaveLength(1);
    expect(arrows[0].getAttribute('aria-label')).toBe('Sorted descending');
    expect(headerButton(el, 'Expected Profit').contains(arrows[0])).toBe(true);
    // The rendered icon itself differs, not just its label — a direction
    // indicator that drew the same glyph both ways would indicate nothing.
    expect(ascendingGlyph).not.toBe('');
    expect(arrows[0].innerHTML).not.toBe(ascendingGlyph);
    expect(headerCells(el).map((cell) => cell.getAttribute('aria-sort'))).toEqual([
      null, 'none', 'none', 'none', 'none', 'none', 'descending', 'none', 'none', null,
    ]);
  });

  // Req 3, 9: clicking the renamed Pricing Status header still reports the
  // unchanged 'unpriced' sort field to the page — no direction is attached
  // to the click itself (that's the page's own first-click-is-ascending
  // logic, already covered above for the other 7 columns and not
  // re-tested here), this pins only that the renamed column's own click
  // wiring is correct.
  it('clicking the Pricing Status header while inactive reports sortBy "unpriced" and nothing else', async () => {
    const clicked: string[] = [];
    const el = await mount([makeListing()], { onSortChange: (field) => clicked.push(field) });

    await act(async () => {
      headerButton(el, 'Pricing Status').click();
    });

    expect(clicked).toEqual(['unpriced']);
  });
});

// The Pricing Status column's badge cell (Req 6). The column sits
// immediately after Sourcing Status and before the trailing Accept/Reject
// actions column, so in each row's <td> list (checkbox, title, source,
// status, askingPrice, expectedResale, difference, identifyParts, unpriced,
// actions) it is always index 8 — pinned here as a literal, not derived
// from SORTABLE_COLUMNS, so a header/body position drift between the two
// would actually fail this test rather than silently agree with itself.
describe('ListingList Pricing Status column badge (Req 6)', () => {
  const PRICING_STATUS_CELL_INDEX = 8;

  it('renders "Not Priced", "Partially Priced", or "Fully Priced" depending on pricingStatus — never blank, each visually distinct', async () => {
    const notPriced = makeListing({ id: 'listing-not-priced', title: 'Not Priced Listing', pricingStatus: 'not_priced' });
    const partial = makeListing({ id: 'listing-partial', title: 'Partial Listing', pricingStatus: 'partially_priced' });
    const full = makeListing({ id: 'listing-full', title: 'Full Listing', pricingStatus: 'fully_priced' });
    const el = await mount([notPriced, partial, full]);

    const notPricedRow = findListingRow(el, 'Not Priced Listing');
    const partialRow = findListingRow(el, 'Partial Listing');
    const fullRow = findListingRow(el, 'Full Listing');

    const notPricedSpan = notPricedRow.cells[PRICING_STATUS_CELL_INDEX].querySelector('span');
    const partialSpan = partialRow.cells[PRICING_STATUS_CELL_INDEX].querySelector('span');
    const fullSpan = fullRow.cells[PRICING_STATUS_CELL_INDEX].querySelector('span');

    expect(notPricedRow.cells[PRICING_STATUS_CELL_INDEX].textContent?.trim()).toBe('Not Priced');
    expect(partialRow.cells[PRICING_STATUS_CELL_INDEX].textContent?.trim()).toBe('Partially Priced');
    expect(fullRow.cells[PRICING_STATUS_CELL_INDEX].textContent?.trim()).toBe('Fully Priced');

    expect(notPricedSpan).not.toBeNull();
    expect(partialSpan).not.toBeNull();
    expect(fullSpan).not.toBeNull();

    // Each pill's rendered className is genuinely distinct from the other
    // two — not just a shared class string under a different label — so a
    // regression that collapses two states onto the same styling fails
    // here even though the text assertions above would still pass.
    const classNames = [notPricedSpan?.className, partialSpan?.className, fullSpan?.className];
    expect(new Set(classNames).size).toBe(3);
  });
});

// Req 6-8: the table's own loading state, set by the host page while a
// user-triggered refetch is in flight — pins that ListingList disables
// every sortable header's actual `disabled` attribute (not just its
// styling), shows the status indicator, and keeps the existing rows
// mounted underneath (never unmounted/replaced) whenever `isLoading` is
// true, and does none of that when it is false/undefined.
describe('ListingList loading state (Req 6-8)', () => {
  it('disables every sortable header and suppresses its click while isLoading is true', async () => {
    const clicked: string[] = [];
    const el = await mount([makeListing()], { isLoading: true, onSortChange: (field) => clicked.push(field) });

    const button = headerButton(el, 'Title');
    expect(button.disabled).toBe(true);

    await act(async () => {
      button.click();
    });

    expect(clicked).toEqual([]);
  });

  it('renders the role="status" loading indicator only while isLoading is true, not when it is false', async () => {
    const loading = await mount([makeListing()], { isLoading: true });
    expect(loading.querySelector('[role="status"]')).not.toBeNull();

    act(() => {
      root?.unmount();
    });
    container?.remove();

    const notLoading = await mount([makeListing()], { isLoading: false });
    expect(notLoading.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps the existing row mounted in the table (not unmounted/replaced) while isLoading is true', async () => {
    const el = await mount([makeListing({ title: 'Stale Listing' })], { isLoading: true });
    expect(findListingRow(el, 'Stale Listing')).toBeDefined();
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
  });
});
