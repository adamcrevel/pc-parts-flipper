// @vitest-environment jsdom
//
// Proof for T6's Listing-level NonWorkingBadge (Req 4): the badge rendered
// in the Listings queue table (listings-queue-table.tsx) and the Listing
// detail/edit view (listing-form.tsx) is gated on `listing.nonWorking` /
// `initialValue?.nonWorking` respectively — present for a flagged Listing,
// absent for an unflagged one, in both places independently. Mounts the
// real components through react-dom/client + act(), following
// listing-form.test.tsx's own pattern (no RTL in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingsQueueTable } from '../src/features/listings-queue/listings-queue-table';
import { ListingForm } from '../src/features/listings/listing-form';

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

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

/** The badge's own exact text (non-working-badge.tsx) — the one thing that marks its presence. */
function nonWorkingBadgePresent(el: HTMLElement): boolean {
  return Array.from(el.querySelectorAll('span')).some((span) => span.textContent === 'Non-working');
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comparison: {
      totalExpectedResaleValue: 2000,
      totalCost: 1550,
      difference: 450,
    } as ListingSummary['comparison'],
    ...overrides,
  };
}

function mockListingDetail(overrides: Partial<ListingDetail> = {}): ListingDetail {
  return { ...mockListingSummary(overrides), expectedParts: [] };
}

describe('ListingsQueueTable non-working badge (Req 4)', () => {
  it('renders the badge for a listing flagged nonWorking: true', async () => {
    const listing = mockListingSummary({ nonWorking: true });
    const el = await mount(
      <ListingsQueueTable listings={[listing]} sourcesById={new Map([[mockSource().id, mockSource()]])} onAccept={vi.fn()} onReject={vi.fn()} pendingListingId={null} />,
    );
    expect(nonWorkingBadgePresent(el)).toBe(true);
  });

  it('omits the badge for a listing with nonWorking: false', async () => {
    const listing = mockListingSummary({ nonWorking: false });
    const el = await mount(
      <ListingsQueueTable listings={[listing]} sourcesById={new Map([[mockSource().id, mockSource()]])} onAccept={vi.fn()} onReject={vi.fn()} pendingListingId={null} />,
    );
    expect(nonWorkingBadgePresent(el)).toBe(false);
  });

  it('shows the badge only on the flagged row when both a flagged and unflagged listing are present', async () => {
    const flagged = mockListingSummary({ id: 'listing-flagged', nonWorking: true });
    const unflagged = mockListingSummary({ id: 'listing-unflagged', nonWorking: false });
    const el = await mount(
      <ListingsQueueTable
        listings={[flagged, unflagged]}
        sourcesById={new Map([[mockSource().id, mockSource()]])}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        pendingListingId={null}
      />,
    );
    const rows = Array.from(el.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(2);
    expect(nonWorkingBadgePresent(rows[0] as HTMLElement)).toBe(true);
    expect(nonWorkingBadgePresent(rows[1] as HTMLElement)).toBe(false);
  });
});

describe('ListingForm non-working badge (Req 4)', () => {
  it('renders the badge when editing a listing flagged initialValue.nonWorking: true', async () => {
    const listing = mockListingDetail({ nonWorking: true });
    const el = await mount(<ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(nonWorkingBadgePresent(el)).toBe(true);
  });

  it('omits the badge when editing a listing with initialValue.nonWorking: false', async () => {
    const listing = mockListingDetail({ nonWorking: false });
    const el = await mount(<ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />);
    expect(nonWorkingBadgePresent(el)).toBe(false);
  });
});
