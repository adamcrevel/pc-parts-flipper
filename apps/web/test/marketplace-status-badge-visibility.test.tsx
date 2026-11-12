// @vitest-environment jsdom
//
// T7's new MarketplaceStatusBadge (Req 1): the badge rendered in the
// Listings queue table (listing-list.tsx) and the Listing detail/edit view
// (listing-form.tsx) is gated on `listing.marketplaceStatus` /
// `initialValue?.marketplaceStatus` respectively — showing "Sold" for
// `'sold'`, "No longer listed" for `'removed'`, and absent entirely when
// `null` — in both places independently. Also covers the Status column
// filter's new `'removed'` option (STATUS_OPTIONS). Mounts the real
// components through react-dom/client + act(), following
// non-working-badge-visibility.test.tsx's own pattern (no RTL in this
// workspace).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingList } from '../src/features/listings/listing-list';
import { ListingForm } from '../src/features/listings/listing-form';
import { MarketplaceStatusBadge } from '../src/features/listings/marketplace-status-badge';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Radix's popover (the Status column's filter trigger) positions its
  // content with floating-ui, which observes the trigger's box; jsdom
  // ships no ResizeObserver, so opening it would throw without this stub.
  if (!('ResizeObserver' in globalThis)) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

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

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

/** The badge's own exact text for the given status (marketplace-status-badge.tsx). */
function marketplaceStatusBadgeText(el: HTMLElement): string | undefined {
  return Array.from(el.querySelectorAll('span'))
    .map((span) => span.textContent)
    .find((text) => text === 'Sold' || text === 'No longer listed');
}

function mockSource(): Source {
  return {
    id: 'source-1',
    name: 'eBay',
    platformType: 'ebay',
    url: 'https://ebay.com',
    notes: null,
    active: true,
    connectorConfig: null,
    lastScannedAt: null,
    lastScanFoundCount: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mockListingSummary(overrides: Partial<ListingSummary> = {}): ListingSummary {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Test Gaming PC',
    description: 'A high-end gaming PC',
    listingUrl: 'https://ebay.com/itm/123456',
    askingPrice: 1500,
    listingDate: '2024-01-01',
    status: 'open',
    acquisitionFees: 50,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    nonWorking: false,
    marketplaceStatus: null,
    marketplaceStatusDetectedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comparison: {
      totalExpectedResaleValue: 2000,
      totalCost: 1550,
      difference: 450,
    } as ListingSummary['comparison'],
    identifyPartsStatus: null,
    pricingStatus: 'fully_priced',
    ...overrides,
  };
}

function mockListingDetail(overrides: Partial<ListingDetail> = {}): ListingDetail {
  return { ...mockListingSummary(overrides), expectedParts: [] };
}

function renderListingList(listings: ListingSummary[]) {
  return (
    <ListingList
      listings={listings}
      sources={[]}
      sourcesById={new Map([[mockSource().id, mockSource()]])}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      pendingListingId={null}
      allFilteredIds={[]}
      selectedIds={new Set()}
      onToggleOne={() => {}}
      onToggleAllFiltered={() => {}}
      onSortChange={() => {}}
      columnFilters={{}}
      onColumnFilterChange={() => {}}
      editingListingId={null}
      editingListing={null}
      editingLoading={false}
      onToggleEdit={() => {}}
      onSubmitEdit={async () => {
        throw new Error('onSubmitEdit not exercised');
      }}
      onCancelEdit={() => {}}
      onSavedEdit={() => {}}
    />
  );
}

describe('MarketplaceStatusBadge (unit)', () => {
  it('renders "Sold" for marketplaceStatus "sold"', async () => {
    const el = await mount(<MarketplaceStatusBadge marketplaceStatus="sold" />);
    expect(marketplaceStatusBadgeText(el)).toBe('Sold');
  });

  it('renders "No longer listed" for marketplaceStatus "removed"', async () => {
    const el = await mount(<MarketplaceStatusBadge marketplaceStatus="removed" />);
    expect(marketplaceStatusBadgeText(el)).toBe('No longer listed');
  });
});

describe('ListingList marketplace status badge (Req 1)', () => {
  it('renders "Sold" for a listing with marketplaceStatus: "sold"', async () => {
    const listing = mockListingSummary({ status: 'removed', marketplaceStatus: 'sold' });
    const el = await mount(renderListingList([listing]));
    expect(marketplaceStatusBadgeText(el)).toBe('Sold');
  });

  it('renders "No longer listed" for a listing with marketplaceStatus: "removed"', async () => {
    const listing = mockListingSummary({ status: 'removed', marketplaceStatus: 'removed' });
    const el = await mount(renderListingList([listing]));
    expect(marketplaceStatusBadgeText(el)).toBe('No longer listed');
  });

  it('omits the badge for a listing with marketplaceStatus: null', async () => {
    const listing = mockListingSummary({ marketplaceStatus: null });
    const el = await mount(renderListingList([listing]));
    expect(marketplaceStatusBadgeText(el)).toBeUndefined();
    expect(el.querySelector('[data-testid="marketplace-status-badge"]')).toBeNull();
  });

  it('shows the badge only on the row with a non-null marketplaceStatus when both are present', async () => {
    const flagged = mockListingSummary({ id: 'listing-flagged', status: 'removed', marketplaceStatus: 'sold' });
    const unflagged = mockListingSummary({ id: 'listing-unflagged', marketplaceStatus: null });
    const el = await mount(renderListingList([flagged, unflagged]));
    const rows = Array.from(el.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    expect(marketplaceStatusBadgeText(rows[0] as HTMLElement)).toBe('Sold');
    expect(marketplaceStatusBadgeText(rows[1] as HTMLElement)).toBeUndefined();
    expect((rows[1] as HTMLElement).querySelector('[data-testid="marketplace-status-badge"]')).toBeNull();
  });
});

describe('ListingForm marketplace status badge (Req 1)', () => {
  it('renders "Sold" when editing a listing with initialValue.marketplaceStatus: "sold"', async () => {
    const listing = mockListingDetail({ status: 'removed', marketplaceStatus: 'sold' });
    const el = await mount(<ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(marketplaceStatusBadgeText(el)).toBe('Sold');
  });

  it('renders "No longer listed" when editing a listing with initialValue.marketplaceStatus: "removed"', async () => {
    const listing = mockListingDetail({ status: 'removed', marketplaceStatus: 'removed' });
    const el = await mount(<ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(marketplaceStatusBadgeText(el)).toBe('No longer listed');
  });

  it('omits the badge when editing a listing with initialValue.marketplaceStatus: null', async () => {
    const listing = mockListingDetail({ marketplaceStatus: null });
    const el = await mount(<ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(marketplaceStatusBadgeText(el)).toBeUndefined();
    expect(el.querySelector('[data-testid="marketplace-status-badge"]')).toBeNull();
  });
});

describe('ListingList Status column filter options (Req 1)', () => {
  it('includes a "Removed" checkbox option alongside Open/Accepted/Rejected', async () => {
    const listing = mockListingSummary();
    const el = await mount(renderListingList([listing]));

    const trigger = Array.from(el.querySelectorAll('button')).find((b) => b.getAttribute('aria-label')?.startsWith('Filter by Status'));
    expect(trigger).not.toBeUndefined();

    await act(async () => {
      (trigger as HTMLButtonElement).click();
    });

    // Radix portals the popover content outside the table container.
    const labels = Array.from(document.body.querySelectorAll('label')).map((label) => label.textContent?.trim());
    expect(labels).toContain('Open');
    expect(labels).toContain('Accepted');
    expect(labels).toContain('Rejected');
    expect(labels).toContain('Removed');
  });
});
