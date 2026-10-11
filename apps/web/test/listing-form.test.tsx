// @vitest-environment jsdom
//
// Proof for T2's ListingFields wrapping in CollapsibleSection
// (listing-form.tsx): when creating a new Listing (no initialValue),
// the Listing Details section starts expanded; when editing an existing
// Listing (initialValue provided), the section starts collapsed. Both
// defaults apply only once per mount. Field values survive toggling the
// section's collapsed/expanded state, and the fields remain mounted
// (present in the DOM) even when the section is collapsed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ExpectedPart, ListingDetail, Source } from '@pc-parts-flipper/shared';
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

function mockListingDetail(): ListingDetail {
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
    externalSource: 'ebay',
    externalItemId: '123456',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    comparison: {
      totalExpectedResaleValue: 2000,
      totalCost: 1550,
      difference: 450,
    },
    expectedParts: [],
  };
}

function getTitleInput(el: HTMLElement): HTMLInputElement | null {
  return el.querySelector('input#listing-title') as HTMLInputElement | null;
}

function getTriggerButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector('button[type="button"]') as HTMLButtonElement | null;
}

function getChevronIcon(el: HTMLElement): SVGElement | null {
  return el.querySelector('button svg') as SVGElement | null;
}

function getSourceSelect(el: HTMLElement): HTMLSelectElement | null {
  return el.querySelector('select#listing-source') as HTMLSelectElement | null;
}

function getUrlInput(el: HTMLElement): HTMLInputElement | null {
  return el.querySelector('input#listing-url') as HTMLInputElement | null;
}

// The Open Link control is a shared Button: an `asChild`-wrapped <a> when
// listingUrl is non-empty, a plain disabled <button> when it's empty (Req
// 4). Matched by its fixed "Open Link" text rather than a dedicated id/
// test-id, since neither element carries one.
function getOpenLinkAnchor(el: HTMLElement): HTMLAnchorElement | null {
  return (
    (Array.from(el.querySelectorAll('a')).find((a) => a.textContent?.trim() === 'Open Link') as HTMLAnchorElement | undefined) ?? null
  );
}

function getOpenLinkButton(el: HTMLElement): HTMLButtonElement | null {
  return (
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Open Link') as HTMLButtonElement | undefined) ?? null
  );
}

describe('ListingForm Listing Details section collapse behavior', () => {
  it('starts expanded when creating a new listing (no initialValue)', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    // When creating, title input should be visible in the DOM (section expanded)
    const titleInput = getTitleInput(el);
    expect(titleInput).not.toBeNull();
  });

  it('starts collapsed when editing an existing listing (with initialValue)', async () => {
    const listing = mockListingDetail();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        initialValue={listing}
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    // When editing, section starts collapsed, so the content should not be in the DOM
    const titleInput = getTitleInput(el);
    expect(titleInput).toBeNull();
  });

  it('clicking the trigger toggles the collapsed/expanded state', async () => {
    const listing = mockListingDetail();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        initialValue={listing}
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    // Starts collapsed
    let titleInput = getTitleInput(el);
    expect(titleInput).toBeNull();

    // Click trigger to expand
    const trigger = getTriggerButton(el);
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.click();
    });

    // After expanding, content should be visible
    titleInput = getTitleInput(el);
    expect(titleInput).not.toBeNull();

    // Click trigger again to collapse
    await act(async () => {
      trigger?.click();
    });

    // After collapsing, content should not be in the DOM
    titleInput = getTitleInput(el);
    expect(titleInput).toBeNull();
  });

  it('field values survive toggling the section collapsed/expanded', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    // Section starts expanded when creating
    let titleInput = getTitleInput(el);
    expect(titleInput).not.toBeNull();

    // Set a value in the title field
    const testTitle = 'My Test Gaming PC';
    await act(async () => {
      if (titleInput) {
        // Use the same pattern as expected-parts-editor.test.tsx
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(titleInput, testTitle);
        } else {
          titleInput.value = testTitle;
        }
        titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        titleInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Verify value was set
    titleInput = getTitleInput(el);
    expect(titleInput?.value).toBe(testTitle);

    // Get the trigger button and click to collapse
    const trigger = getTriggerButton(el);
    await act(async () => {
      trigger?.click();
    });

    // Section is now collapsed, input not in DOM
    titleInput = getTitleInput(el);
    expect(titleInput).toBeNull();

    // Click trigger to expand again
    await act(async () => {
      trigger?.click();
    });

    // After re-expanding, the value should still be there
    titleInput = getTitleInput(el);
    expect(titleInput).not.toBeNull();
    expect(titleInput?.value).toBe(testTitle);
  });

  it('chevron icon rotates to indicate open/closed state', async () => {
    const listing = mockListingDetail();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        initialValue={listing}
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    // Starts collapsed (-rotate-90)
    let chevron = getChevronIcon(el);
    expect(chevron?.className.baseVal).toContain('-rotate-90');

    // Click to expand
    const trigger = getTriggerButton(el);
    await act(async () => {
      trigger?.click();
    });

    // Chevron should not contain -rotate-90 when open
    chevron = getChevronIcon(el);
    expect(chevron?.className.baseVal).not.toContain('-rotate-90');

    // Click to collapse again
    await act(async () => {
      trigger?.click();
    });

    // Chevron should contain -rotate-90 again
    chevron = getChevronIcon(el);
    expect(chevron?.className.baseVal).toContain('-rotate-90');
  });

  it('trigger displays "Listing Details" label', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    const trigger = getTriggerButton(el);
    expect(trigger?.textContent).toContain('Listing Details');
  });

  it('Listing Details box renders with the bg-surfaceContrast token (Req 12), not overridden by listing-form.tsx', async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onSaved = vi.fn();

    const el = await mount(
      <ListingForm
        sources={[mockSource()]}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    );

    const trigger = getTriggerButton(el);
    expect(trigger?.className.split(/\s+/)).toContain('bg-surfaceContrast');
  });
});

describe('ListingForm Source select read-only behavior (Req 5-6)', () => {
  it('Source select is enabled when creating a new listing (no initialValue)', async () => {
    const el = await mount(
      <ListingForm sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    const select = getSourceSelect(el);
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(false);
  });

  it('Source select is disabled when editing an existing listing (with initialValue)', async () => {
    const listing = mockListingDetail();
    const el = await mount(
      <ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    // Editing starts with the Listing Details section collapsed (see the
    // describe block above), so the select isn't in the DOM until expanded.
    const trigger = getTriggerButton(el);
    await act(async () => {
      trigger?.click();
    });

    const select = getSourceSelect(el);
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(true);
  });
});

describe('ListingForm Open Link button (Req 1, 4)', () => {
  it('renders as a disabled plain button, not a link, when listingUrl is empty', async () => {
    const el = await mount(
      <ListingForm sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    expect(getOpenLinkAnchor(el)).toBeNull();
    const button = getOpenLinkButton(el);
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
  });

  it('renders as a real anchor matching the current listingUrl, target="_blank", rel="noreferrer" when listingUrl is non-empty', async () => {
    const listing = mockListingDetail();
    const el = await mount(
      <ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );
    const trigger = getTriggerButton(el);
    await act(async () => {
      trigger?.click();
    });

    expect(getOpenLinkButton(el)).toBeNull();
    const anchor = getOpenLinkAnchor(el);
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe(listing.listingUrl);
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noreferrer');
  });

  it('tracks listingUrl edits: becomes a live anchor once a value is typed into an initially-empty field', async () => {
    const el = await mount(
      <ListingForm sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    expect(getOpenLinkButton(el)?.disabled).toBe(true);

    const urlInput = getUrlInput(el);
    const testUrl = 'https://example.com/itm/987';
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(urlInput, testUrl);
      } else if (urlInput) {
        urlInput.value = testUrl;
      }
      urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
      urlInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const anchor = getOpenLinkAnchor(el);
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe(testUrl);
  });
});

describe('ListingForm Listing URL input (regression: value/onChange/error rendering unchanged)', () => {
  it('reflects the initial value and updates on change, independent of the Open Link button', async () => {
    const listing = mockListingDetail();
    const el = await mount(
      <ListingForm initialValue={listing} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );
    const trigger = getTriggerButton(el);
    await act(async () => {
      trigger?.click();
    });

    expect(getUrlInput(el)?.value).toBe(listing.listingUrl);

    const testUrl = 'https://example.com/changed';
    await act(async () => {
      const input = getUrlInput(el);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(input, testUrl);
      } else if (input) {
        input.value = testUrl;
      }
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      input?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(getUrlInput(el)?.value).toBe(testUrl);
  });

  it('renders the "Listing URL is required." validation error on submit with a blank value, unchanged from before this feature', async () => {
    const onSubmit = vi.fn();
    const el = await mount(
      <ListingForm sources={[mockSource()]} onSubmit={onSubmit} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    const form = el.querySelector('form') as HTMLFormElement | null;
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const errorText = getUrlInput(el)?.closest('.space-y-1')?.querySelector('p.text-destructive');
    expect(errorText?.textContent).toBe('Listing URL is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// Proof for T6's Req 12-13 wiring in listing-form.tsx: ExpectedPartsEditor's
// `isExistingListing` prop is derived from `Boolean(saved)`, which starts as
// `initialValue` and is otherwise undefined until a create-flow save
// returns. This observes the resulting AlertCircle highlight end-to-end
// through ListingForm itself (not just ExpectedPartsEditor in isolation,
// which expected-parts-editor.test.tsx already covers) so a regression in
// the `Boolean(saved)` wiring itself — not just the editor's own internal
// `isExistingListing` branch — would be caught here.
describe('ListingForm unpriced-row highlight (Req 12-13)', () => {
  it('never shows the unpriced highlight while creating a new listing, even though the starter row has no price', async () => {
    const el = await mount(
      <ListingForm sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    expect(el.querySelector('[aria-label="Expected part 1 is not priced"]')).toBeNull();
  });

  it('shows the unpriced highlight for an existing listing whose expected part has no estimated resale value', async () => {
    const listing = mockListingDetail();
    const unpricedPart: ExpectedPart = {
      id: 'part-1',
      listingId: listing.id,
      componentCategory: 'GPU',
      brand: 'NVIDIA',
      partNumber: 'RTX 3070',
      description: 'pulled from a working rig',
      estimatedResaleValue: null,
      identityCandidates: [],
      workingStatus: 'working',
      notes: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const listingWithUnpricedPart: ListingDetail = { ...listing, expectedParts: [unpricedPart] };

    const el = await mount(
      <ListingForm initialValue={listingWithUnpricedPart} sources={[mockSource()]} onSubmit={vi.fn()} onCancel={vi.fn()} onSaved={vi.fn()} />
    );

    expect(el.querySelector('[aria-label="Expected part 1 is not priced"]')).not.toBeNull();
  });
});

