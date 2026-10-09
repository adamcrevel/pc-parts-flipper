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
import type { CreateListingInput, ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingList } from '../src/features/listings/listing-list';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Builds one open ListingSummary, overridable per test — matches the
// fields the table/comparison columns and the photo icon render.
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
    ...overrides,
  };
}

const sources: Source[] = [{ id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' }];

// Stands in for ListingsPage's open/close state + fetched ListingDetail,
// so these tests exercise ListingList's real click-to-open-inline wiring
// instead of reimplementing it. Treats the clicked ListingSummary as if it
// were the already-fetched ListingDetail (no Expected Parts) since the
// fetch itself is ListingsPage's concern, not ListingList's.
function Harness({ listings }: { listings: ListingSummary[] }) {
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

async function mount(listings: ListingSummary[]): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(<Harness listings={listings} />);
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
    expect(rows[formRowIndex].querySelector('td')?.getAttribute('colspan')).toBe('9');
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

