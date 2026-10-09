// @vitest-environment jsdom
//
// T1: direct unit coverage for the relocated ListingFilters component
// (apps/web/src/features/listings/listing-filters.tsx, renamed from
// ListingsQueueFilters). The existing suites (bulk-identify-parts-ui.test.tsx,
// listings-page.test.tsx) only ever drive the *status* select through the
// mounted ListingsPage — neither they nor the now-deleted
// listings-queue-page.test.tsx ever exercised the Source select's onChange
// wiring via the DOM. This file mounts ListingFilters directly (not through
// the page) and proves both selects render their options and fire onChange
// with the correctly-merged filter value (Req 2's contract).
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { Source } from '@pc-parts-flipper/shared';
import { ListingFilters, type ListingsQueueFilterValue } from '../src/features/listings/listing-filters';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sources: Source[] = [
  { id: 'source-1', name: 'Test Source', platformType: 'ebay', url: null, notes: null, active: true, createdAt: '2024-01-01', updatedAt: '2024-01-01' },
];

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

function selects(el: HTMLElement): HTMLSelectElement[] {
  return Array.from(el.querySelectorAll('select'));
}

describe('ListingFilters (Req 2)', () => {
  it('renders the status select with all four options and the Source select with "All sources" plus every passed Source', async () => {
    const value: ListingsQueueFilterValue = { status: '', sourceId: '' };
    const el = await mount(<ListingFilters value={value} sources={sources} onChange={() => {}} />);

    const [statusSelect, sourceSelect] = selects(el);
    expect(Array.from(statusSelect.options).map((o) => o.value)).toEqual(['', 'open', 'accepted', 'rejected']);
    expect(Array.from(statusSelect.options).map((o) => o.textContent)).toEqual([
      'All statuses',
      'Open',
      'Accepted',
      'Rejected',
    ]);
    expect(Array.from(sourceSelect.options).map((o) => o.value)).toEqual(['', 'source-1']);
    expect(Array.from(sourceSelect.options).map((o) => o.textContent)).toEqual(['All sources', 'Test Source']);
  });

  it('fires onChange with the status field updated and sourceId carried over unchanged when the status select changes', async () => {
    const value: ListingsQueueFilterValue = { status: '', sourceId: 'source-1' };
    let received: ListingsQueueFilterValue | null = null;
    const el = await mount(
      <ListingFilters value={value} sources={sources} onChange={(v) => (received = v)} />,
    );

    const [statusSelect] = selects(el);
    await act(async () => {
      statusSelect.value = 'open';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(received).toEqual({ status: 'open', sourceId: 'source-1' });
  });

  it('fires onChange with the sourceId field updated and status carried over unchanged when the Source select changes', async () => {
    const value: ListingsQueueFilterValue = { status: 'open', sourceId: '' };
    let received: ListingsQueueFilterValue | null = null;
    const el = await mount(
      <ListingFilters value={value} sources={sources} onChange={(v) => (received = v)} />,
    );

    const [, sourceSelect] = selects(el);
    await act(async () => {
      sourceSelect.value = 'source-1';
      sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(received).toEqual({ status: 'open', sourceId: 'source-1' });
  });
});
