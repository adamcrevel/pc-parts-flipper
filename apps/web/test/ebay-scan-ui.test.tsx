// @vitest-environment jsdom
//
// T10 proof: the eBay-scan UI surface added to the Listings queue table and
// the Listing detail/edit form, plus the comparison summary's "no Expected
// Parts" guard. Mounts the real components (not reimplementations) with
// react-dom/client + act(), following error-boundary.test.tsx's pattern
// (no React Testing Library dependency in this workspace).
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { CreateListingInput, ListingDetail, ListingSummary, Source } from '@pc-parts-flipper/shared';
import { ListingsQueueTable } from '../src/features/listings-queue/listings-queue-table';
import { ListingForm } from '../src/features/listings/listing-form';
import { ListingComparisonSummary } from '../src/features/listings/listing-comparison-summary';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Builds one open ListingSummary, overridable per test — matches the fields
// the queue table and comparison columns render.
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
    ...overrides,
  };
}

// Builds one ListingDetail (ListingForm's `initialValue` shape), overridable
// per test, with a single Expected Part by default so create/edit cases
// outside the warning scenario start from a "filled" state.
function makeListingDetail(overrides: Partial<ListingDetail> = {}): ListingDetail {
  return {
    ...makeListing(),
    expectedParts: [{ id: 'part-1', componentCategory: 'CPU', description: 'CPU', estimatedResaleValue: 150 }],
    ...overrides,
  };
}

const sourcesById = new Map<string, Source>([
  ['source-1', { id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' }],
]);

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
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

const BADGE_TEXT = 'Found via eBay scan';
const WARNING_TEXT = 'No Expected Parts recorded yet — add them before accepting';

describe('ListingsQueueTable eBay scan badge', () => {
  it('(a) renders the "Found via eBay scan" badge on a row whose externalItemId is set', async () => {
    const listing = makeListing({ externalItemId: 'ebay-123', externalSource: 'ebay' });
    const el = await mount(
      <ListingsQueueTable listings={[listing]} sourcesById={sourcesById} onAccept={() => {}} onReject={() => {}} pendingListingId={null} />,
    );

    expect(el.textContent).toContain(BADGE_TEXT);
  });

  it('(b) does NOT render the badge on a row whose externalItemId is null', async () => {
    const listing = makeListing({ externalItemId: null });
    const el = await mount(
      <ListingsQueueTable listings={[listing]} sourcesById={sourcesById} onAccept={() => {}} onReject={() => {}} pendingListingId={null} />,
    );

    expect(el.textContent).not.toContain(BADGE_TEXT);
  });
});

describe('ListingForm eBay scan badge (detail/edit view)', () => {
  it('(c) links the badge to the Listing\'s listingUrl when externalItemId is set', async () => {
    const initialValue = makeListingDetail({
      externalItemId: 'ebay-123',
      externalSource: 'ebay',
      listingUrl: 'https://www.ebay.com/itm/123',
    });
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async () => initialValue}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    const link = el.querySelector('a[href="https://www.ebay.com/itm/123"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain(BADGE_TEXT);
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('does not render the badge when externalItemId is null', async () => {
    const initialValue = makeListingDetail({ externalItemId: null, externalSource: null });
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async () => initialValue}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(el.textContent).not.toContain(BADGE_TEXT);
  });

  it('does not render the badge in create mode, where there is no initialValue at all', async () => {
    const el = await mount(
      <ListingForm
        initialValue={undefined}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async (input) => makeListingDetail({ ...input, expectedParts: [] })}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(el.textContent).not.toContain(BADGE_TEXT);
  });
});

describe('ListingComparisonSummary no-Expected-Parts warning (Req 10)', () => {
  it('(d) shows the exact warning text when expectedPartsCount is 0', async () => {
    const el = await mount(
      <ListingComparisonSummary totalExpectedResaleValue={0} totalCost={100} difference={-100} expectedPartsCount={0} />,
    );

    expect(el.textContent).toBe(WARNING_TEXT);
  });

  it('(d) shows the normal $ comparison when expectedPartsCount is non-zero', async () => {
    const el = await mount(
      <ListingComparisonSummary totalExpectedResaleValue={150} totalCost={100} difference={50} expectedPartsCount={1} />,
    );

    expect(el.textContent).not.toContain(WARNING_TEXT);
    expect(el.textContent).toContain('$150.00');
    expect(el.textContent).toContain('Projected profit');
  });
});

describe('ListingComparisonSummary in ListingForm context (Req 10)', () => {
  it('(f) shows the warning in ListingForm when editing a scan-created Listing with no filled Expected Parts', async () => {
    const initialValue = makeListingDetail({
      externalItemId: 'ebay-123',
      externalSource: 'ebay',
      expectedParts: [], // No parts filled in yet
    });
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async () => initialValue}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(el.textContent).toContain(WARNING_TEXT);
  });

  it('(g) shows the warning in ListingForm when creating a manual Listing with no filled Expected Parts', async () => {
    const el = await mount(
      <ListingForm
        initialValue={undefined} // Create mode, no initial value
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async (input) => makeListingDetail({ ...input, expectedParts: [] })}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(el.textContent).toContain(WARNING_TEXT);
  });

  it('(h) does NOT show the warning in ListingForm when a scan-created Listing has at least one filled Expected Part', async () => {
    const initialValue = makeListingDetail({
      externalItemId: 'ebay-123',
      externalSource: 'ebay',
      expectedParts: [{ id: 'part-1', componentCategory: 'CPU', description: 'CPU', estimatedResaleValue: 150 }],
    });
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async () => initialValue}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(el.textContent).not.toContain(WARNING_TEXT);
    expect(el.textContent).toContain('Projected profit');
  });
});

describe('ListingsQueueTable regression: non-badge columns and Accept/Reject still work (Req 4/12)', () => {
  it('renders status/source/price/comparison columns and fires onAccept/onReject for a normal (non-scanned) row', async () => {
    const accepted: ListingSummary[] = [];
    const rejected: ListingSummary[] = [];
    const listing = makeListing({
      externalItemId: null,
      askingPrice: 120,
      comparison: { totalExpectedResaleValue: 200, totalCost: 120, difference: 80 },
    });
    const el = await mount(
      <ListingsQueueTable
        listings={[listing]}
        sourcesById={sourcesById}
        onAccept={(l) => accepted.push(l)}
        onReject={(l) => rejected.push(l)}
        pendingListingId={null}
      />,
    );

    // Non-badge columns: source name, status, asking price, expected
    // resale, and difference all still render for an un-scanned row.
    expect(el.textContent).toContain('Test Source');
    expect(el.textContent).toContain('open');
    expect(el.textContent).toContain('$120.00');
    expect(el.textContent).toContain('$200.00');
    expect(el.textContent).toContain('$80.00');

    const buttons = Array.from(el.querySelectorAll('button'));
    const acceptButton = buttons.find((b) => b.textContent === 'Accept');
    const rejectButton = buttons.find((b) => b.textContent === 'Reject');
    expect(acceptButton).toBeDefined();
    expect(rejectButton).toBeDefined();

    await act(async () => {
      acceptButton!.click();
    });
    expect(accepted).toEqual([listing]);

    await act(async () => {
      rejectButton!.click();
    });
    expect(rejected).toEqual([listing]);
  });
});

describe('ListingForm regression: Save/Cancel flow and Expected Parts editor still work', () => {
  it('calls onCancel (without calling onSubmit) when Cancel is clicked', async () => {
    let cancelled = false;
    let submitted = false;
    const initialValue = makeListingDetail();
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async () => {
          submitted = true;
          return initialValue;
        }}
        onCancel={() => {
          cancelled = true;
        }}
        onSaved={() => {}}
      />,
    );

    const cancelButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement;
    expect(cancelButton).toBeDefined();
    await act(async () => {
      cancelButton.click();
    });

    expect(cancelled).toBe(true);
    expect(submitted).toBe(false);
  });

  it('submits the pre-filled fields via onSubmit and forwards the result to onSaved when Save is clicked', async () => {
    const initialValue = makeListingDetail({ listingUrl: 'https://example.com/listing-9', title: 'Regression Listing' });
    const submittedInputs: CreateListingInput[] = [];
    const savedListings: ListingDetail[] = [];
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async (input) => {
          submittedInputs.push(input);
          return { ...initialValue, ...input };
        }}
        onCancel={() => {}}
        onSaved={(listing) => savedListings.push(listing)}
      />,
    );

    const form = el.querySelector('form') as HTMLFormElement;
    expect(form).not.toBeNull();
    // jsdom's "click a submit button" default action does not reliably fire
    // a submit event on a <form> that is not attached to `document` (the
    // mount() helper here deliberately keeps the container detached, same
    // as every other test in this file), so the submit event is dispatched
    // directly — exactly what a real browser's click-to-submit algorithm
    // would hand React's onSubmit handler.
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(submittedInputs).toHaveLength(1);
    expect(submittedInputs[0].title).toBe('Regression Listing');
    expect(submittedInputs[0].listingUrl).toBe('https://example.com/listing-9');
    expect(savedListings).toHaveLength(1);
    expect(savedListings[0].title).toBe('Regression Listing');
  });

  it('Add Part appends a new blank row, and Remove deletes it again', async () => {
    const initialValue = makeListingDetail();
    const el = await mount(
      <ListingForm
        initialValue={initialValue}
        sources={[sourcesById.get('source-1')!]}
        onSubmit={async () => initialValue}
        onCancel={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(el.querySelector('[aria-label="Expected part 2 description"]')).toBeNull();

    const addPartButton = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Add Part') as HTMLButtonElement;
    expect(addPartButton).toBeDefined();
    await act(async () => {
      addPartButton.click();
    });

    const secondRowDescription = el.querySelector('[aria-label="Expected part 2 description"]');
    expect(secondRowDescription).not.toBeNull();

    const removeButtons = Array.from(el.querySelectorAll('button')).filter((b) => b.textContent === 'Remove');
    expect(removeButtons).toHaveLength(2);
    await act(async () => {
      removeButtons[1].click();
    });

    expect(el.querySelector('[aria-label="Expected part 2 description"]')).toBeNull();
  });
});
