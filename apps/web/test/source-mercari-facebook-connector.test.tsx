// @vitest-environment jsdom
//
// T11 proof: Mercari reuses the shared queries+maxPrice connector-config
// editor (connector-config-editor.tsx) unchanged, Facebook Marketplace's
// own editor (facebook-marketplace-config-editor.tsx) renders and validates
// its extra location/radiusMiles fields on top of that same shape, and
// SourceRow's generalized canScan now returns true for both new platform
// types. Mounts the real components (not reimplementations) with
// react-dom/client + act(), following source-ebay-connector.test.tsx's own
// pattern (no React Testing Library dependency in this workspace).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { Source } from '@pc-parts-flipper/shared';
import { SourceForm } from '../src/features/sources/source-form';
import { SourceRow } from '../src/features/sources/source-row';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Builds one Source, overridable per test, with sane defaults for every
// field SourceForm/SourceRow read.
function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    name: 'Test Source',
    platformType: 'ebay',
    url: 'https://example.com',
    notes: null,
    active: true,
    connectorConfig: null,
    lastScannedAt: null,
    lastScanFoundCount: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
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
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

function findButton(el: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!button) {
    throw new Error(`No button found with text "${text}"`);
  }
  return button as HTMLButtonElement;
}

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (input instanceof HTMLInputElement && setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fillRequiredFields(el: HTMLDivElement, platformType: string) {
  const nameInput = el.querySelector('#source-name') as HTMLInputElement;
  const urlInput = el.querySelector('#source-url') as HTMLInputElement;
  const select = el.querySelector('#source-platform') as HTMLSelectElement;
  await act(async () => {
    setValue(nameInput, 'My Source');
    setValue(urlInput, 'https://example.com/search');
    setValue(select, platformType);
  });
}

async function submitForm(el: HTMLDivElement) {
  await act(async () => {
    findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('SourceForm platform options (Mercari)', () => {
  it('offers Mercari as a selectable platform option', async () => {
    const el = await mount(<SourceForm onSubmit={async () => {}} onCancel={() => {}} />);
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(optionValues).toContain('mercari');
  });
});

describe('SourceForm Mercari connector-config editor (reuses the eBay shape)', () => {
  it('reveals the Mercari query editor once platformType is set to mercari', async () => {
    const el = await mount(<SourceForm onSubmit={async () => {}} onCancel={() => {}} />);
    expect(el.textContent).not.toContain('Mercari Search Queries');

    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => setValue(select, 'mercari'));

    expect(el.textContent).toContain('Mercari Search Queries');
    // Confirms this is the same shared editor eBay uses, not a distinct
    // reimplementation — eBay's own heading is not simultaneously present.
    expect(el.textContent).not.toContain('eBay Search Queries');
  });

  it('shows the same per-row error as eBay when the single query row is left blank', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'mercari');

    await submitForm(el);

    expect(el.textContent).toContain('Query is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the same maxPrice error as eBay for a negative maxPrice', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'mercari');

    const queryInput = el.querySelector('[aria-label="Mercari search query 1"]') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, 'rtx 3080');
      setValue(maxPriceInput, '-5');
    });

    await submitForm(el);

    expect(el.textContent).toContain('Max price must be a non-negative number.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('includes a valid MercariConnectorConfig with the trimmed query and numeric maxPrice on submit', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'mercari');

    const queryInput = el.querySelector('[aria-label="Mercari search query 1"]') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, '  rtx 3080  ');
      setValue(maxPriceInput, '250');
    });

    await submitForm(el);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'], maxPrice: 250 });
  });
});

describe('SourceForm Facebook Marketplace connector-config editor (extra location/radiusMiles fields)', () => {
  it('reveals the Facebook Marketplace editor, including its location and radius fields, once platformType is set', async () => {
    const el = await mount(<SourceForm onSubmit={async () => {}} onCancel={() => {}} />);
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => setValue(select, 'facebook_marketplace'));

    expect(el.textContent).toContain('Facebook Marketplace Search Queries');
    expect(el.querySelector('#connector-location')).not.toBeNull();
    expect(el.querySelector('#connector-radius-miles')).not.toBeNull();
    expect(el.querySelector('#connector-max-price')).not.toBeNull();
  });

  it('shows a field error and does not call onSubmit when the single query row is left blank', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'facebook_marketplace');

    await submitForm(el);

    expect(el.textContent).toContain('Query is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a field error and does not call onSubmit for a negative radiusMiles', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'facebook_marketplace');

    const queryInput = el.querySelector('[aria-label="Facebook Marketplace search query 1"]') as HTMLInputElement;
    const radiusInput = el.querySelector('#connector-radius-miles') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, 'rtx 3080');
      setValue(radiusInput, '-10');
    });

    await submitForm(el);

    expect(el.textContent).toContain('Radius must be a non-negative number.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('accepts a radiusMiles of exactly 0 as the non-negative boundary (opposite direction from the negative-radius test above)', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'facebook_marketplace');

    const queryInput = el.querySelector('[aria-label="Facebook Marketplace search query 1"]') as HTMLInputElement;
    const radiusInput = el.querySelector('#connector-radius-miles') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, 'rtx 3080');
      setValue(radiusInput, '0');
    });

    await submitForm(el);

    expect(el.textContent).not.toContain('Radius must be a non-negative number.');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'], radiusMiles: 0 });
  });

  it('shows a field error and does not call onSubmit for a negative maxPrice', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'facebook_marketplace');

    const queryInput = el.querySelector('[aria-label="Facebook Marketplace search query 1"]') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, 'rtx 3080');
      setValue(maxPriceInput, '-5');
    });

    await submitForm(el);

    expect(el.textContent).toContain('Max price must be a non-negative number.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('includes a valid FacebookMarketplaceConnectorConfig with queries, location, radiusMiles, and maxPrice on submit', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'facebook_marketplace');

    const queryInput = el.querySelector('[aria-label="Facebook Marketplace search query 1"]') as HTMLInputElement;
    const locationInput = el.querySelector('#connector-location') as HTMLInputElement;
    const radiusInput = el.querySelector('#connector-radius-miles') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, '  rtx 3080  ');
      setValue(locationInput, '  Seattle, WA  ');
      setValue(radiusInput, '25');
      setValue(maxPriceInput, '250');
    });

    await submitForm(el);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'], location: 'Seattle, WA', radiusMiles: 25, maxPrice: 250 });
  });

  it('omits location entirely when left blank (blank normalizes to omitted, not an empty string)', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el, 'facebook_marketplace');

    const queryInput = el.querySelector('[aria-label="Facebook Marketplace search query 1"]') as HTMLInputElement;
    await act(async () => setValue(queryInput, 'rtx 3080'));

    await submitForm(el);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'] });
    expect(input.connectorConfig.location).toBeUndefined();
  });
});

describe('SourceRow canScan generalized to Mercari and Facebook Marketplace', () => {
  it('renders Scan now for a Mercari Source with a non-null connectorConfig', async () => {
    const source = makeSource({ platformType: 'mercari', connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }) });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).toContain('Scan now');
    expect(el.textContent).toContain('Mercari');
  });

  it('renders Scan now for a Facebook Marketplace Source with a non-null connectorConfig', async () => {
    const source = makeSource({
      platformType: 'facebook_marketplace',
      connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
    });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).toContain('Scan now');
  });

  it('does NOT render Scan now for a Mercari Source with a null connectorConfig', async () => {
    const source = makeSource({ platformType: 'mercari', connectorConfig: null });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).not.toContain('Scan now');
  });
});
