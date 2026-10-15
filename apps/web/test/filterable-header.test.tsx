// @vitest-environment jsdom
//
// T4: direct unit coverage for FilterableHeader
// (src/features/listings/filterable-header.tsx), mounted on its own inside
// a bare table — not through ListingList or the Listings page, which is
// T5's scope. Proves the three things extending SortableHeader with a
// filter could plausibly break: the label still sorts exactly as before,
// the filter trigger is a sibling of the sort button rather than anything
// nested in or around it, and the active-filter indicator follows the
// `isFiltered` prop alone. Follows listing-list.test.tsx's
// react-dom/client + act() pattern (no RTL in this workspace).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { FilterableHeader } from '../src/features/listings/filterable-header';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Radix's popover positions its content with floating-ui, which observes
  // the trigger's box; jsdom ships no ResizeObserver, so the popover's
  // content would throw on open without this stub. Nothing in these tests
  // asserts on position, only on presence.
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

// A FilterableHeader is a <th>, so it is mounted in the table markup a
// real caller gives it rather than as a loose element.
async function mountHeader(header: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <table>
        <thead>
          <tr>{header}</tr>
        </thead>
      </table>,
    );
  });
  return container;
}

function sortButton(el: HTMLElement): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Asking Price'));
  if (button === undefined) throw new Error('sort button not found');
  return button;
}

function filterTrigger(el: HTMLElement): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.getAttribute('aria-label')?.startsWith('Filter by'));
  if (button === undefined) throw new Error('filter trigger not found');
  return button;
}

function renderHeader(props: Partial<React.ComponentProps<typeof FilterableHeader>> = {}) {
  return (
    <FilterableHeader
      field="askingPrice"
      label="Asking Price"
      onSortChange={() => {}}
      isFiltered={false}
      {...props}
    >
      <div data-testid="filter-body">filter body</div>
    </FilterableHeader>
  );
}

describe('FilterableHeader sort behaviour (unchanged from SortableHeader)', () => {
  it('fires onSortChange with its own field when the label is clicked, with the filter trigger present', async () => {
    const onSortChange = vi.fn();
    const el = await mountHeader(renderHeader({ onSortChange, isFiltered: true }));

    // The filter trigger exists alongside the label, so this click is
    // proof the new button does not swallow or re-route the sort click.
    expect(filterTrigger(el)).not.toBeNull();
    await act(async () => {
      sortButton(el).click();
    });

    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenCalledWith('askingPrice');
  });

  it('renders the ascending arrow and aria-sort=ascending on its own active column', async () => {
    const el = await mountHeader(renderHeader({ sortBy: 'askingPrice', sortDirection: 'asc' }));
    expect(el.querySelector('th')?.getAttribute('aria-sort')).toBe('ascending');
    expect(el.querySelector('svg[aria-label="Sorted ascending"]')).not.toBeNull();
  });

  it('renders the descending arrow and aria-sort=descending when its column is sorted descending', async () => {
    const el = await mountHeader(renderHeader({ sortBy: 'askingPrice', sortDirection: 'desc' }));
    expect(el.querySelector('th')?.getAttribute('aria-sort')).toBe('descending');
    expect(el.querySelector('svg[aria-label="Sorted descending"]')).not.toBeNull();
  });

  it('renders no arrow and aria-sort=none when another column is the sorted one', async () => {
    const el = await mountHeader(renderHeader({ sortBy: 'title', sortDirection: 'asc' }));
    expect(el.querySelector('th')?.getAttribute('aria-sort')).toBe('none');
    expect(el.querySelector('svg[aria-label="Sorted ascending"]')).toBeNull();
  });

  it('disables the sort button while a fetch is in flight (Req 8) without disabling the filter trigger', async () => {
    const onSortChange = vi.fn();
    const el = await mountHeader(renderHeader({ onSortChange, isLoading: true }));

    expect(sortButton(el).disabled).toBe(true);
    expect(filterTrigger(el).disabled).toBe(false);

    await act(async () => {
      sortButton(el).click();
    });
    expect(onSortChange).not.toHaveBeenCalled();
  });
});

describe('FilterableHeader filter trigger', () => {
  it('is a sibling of the sort button, not nested inside it', async () => {
    const el = await mountHeader(renderHeader());

    const sort = sortButton(el);
    const trigger = filterTrigger(el);
    expect(trigger).not.toBe(sort);
    expect(sort.contains(trigger)).toBe(false);
    expect(trigger.contains(sort)).toBe(false);
    // Both live in the same header cell, which is the point of the change.
    expect(sort.closest('th')).toBe(trigger.closest('th'));
  });

  it('opens a popover rendering the caller-supplied filter body', async () => {
    const el = await mountHeader(renderHeader());

    expect(document.body.querySelector('[data-testid="filter-body"]')).toBeNull();

    await act(async () => {
      filterTrigger(el).click();
    });

    // Radix portals the content outside the table, so it is looked up on
    // the document rather than within the mount container.
    expect(document.body.querySelector('[data-testid="filter-body"]')).not.toBeNull();
  });

  it('shows the inactive look and label when isFiltered is false', async () => {
    const el = await mountHeader(renderHeader({ isFiltered: false }));

    const trigger = filterTrigger(el);
    expect(trigger.getAttribute('aria-label')).toBe('Filter by Asking Price');
    expect(trigger.querySelector('svg')?.getAttribute('class')).not.toContain('fill-current');
    expect(trigger.querySelector('span.rounded-full')).toBeNull();
  });

  it('shows the active look and label purely because isFiltered is true, with no filter interaction', async () => {
    const el = await mountHeader(renderHeader({ isFiltered: true }));

    const trigger = filterTrigger(el);
    expect(trigger.getAttribute('aria-label')).toBe('Filter by Asking Price (filter active)');
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('fill-current');
    expect(trigger.querySelector('span.rounded-full')).not.toBeNull();
  });
});
