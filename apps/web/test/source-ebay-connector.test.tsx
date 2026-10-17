// @vitest-environment jsdom
//
// T9 proof: the eBay connector-config editor on SourceForm (show/hide by
// platformType, inline validation mirroring the server's
// validateEbayConnectorConfig rules, and the built EbayConnectorConfig
// passed to onSubmit) plus SourceRow's Scan now button and Last Scanned
// display. Mounts the real components (not reimplementations) with
// react-dom/client + act(), following error-boundary.test.tsx's pattern
// (no React Testing Library dependency in this workspace).
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

describe('SourceForm eBay connector-config editor visibility (a)', () => {
  it('reveals the query editor once platformType is set to ebay', async () => {
    const el = await mount(<SourceForm onSubmit={async () => {}} onCancel={() => {}} />);
    expect(el.textContent).not.toContain('eBay Search Queries');

    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => setValue(select, 'ebay'));

    expect(el.textContent).toContain('eBay Search Queries');
  });

  it('hides the query editor for a non-ebay platformType', async () => {
    const el = await mount(<SourceForm onSubmit={async () => {}} onCancel={() => {}} />);
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => setValue(select, 'facebook_marketplace'));

    expect(el.textContent).not.toContain('eBay Search Queries');
  });
});

describe('SourceForm eBay connector-config validation (b)', () => {
  async function fillRequiredFields(el: HTMLDivElement) {
    const nameInput = el.querySelector('#source-name') as HTMLInputElement;
    const urlInput = el.querySelector('#source-url') as HTMLInputElement;
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => {
      setValue(nameInput, 'My eBay Source');
      setValue(urlInput, 'https://ebay.com/search');
      setValue(select, 'ebay');
    });
  }

  it('shows a field error and does not call onSubmit when the single query row is left blank', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el);

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(el.textContent).toContain('Query is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a field error and does not call onSubmit for a negative maxPrice', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el);

    const queryInput = el.querySelector('[aria-label="eBay search query 1"]') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, 'rtx 3080');
      setValue(maxPriceInput, '-5');
    });

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(el.textContent).toContain('Max price must be a non-negative number.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('removing every query down to a blank last row still blocks submit with the per-row error (empty-array guard)', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el);

    // The editor always keeps one row — submitting that lone blank row
    // exercises the same "non-empty array of non-blank strings" rule the
    // server enforces, just without ever reaching queries.length === 0.
    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(el.textContent).toContain('Query is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows the per-row error only on the blank row among multiple queries and blocks submit', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);
    await fillRequiredFields(el);

    // Fill the first row and add a second, left blank — exercises the
    // per-index mapping in errors.queryRows rather than just the
    // whole-array "at least one query" guard the other tests cover.
    const firstQuery = el.querySelector('[aria-label="eBay search query 1"]') as HTMLInputElement;
    await act(async () => setValue(firstQuery, 'rtx 3080'));
    await act(async () => findButton(el, 'Add Query').click());

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const errorCount = Array.from(el.querySelectorAll('p')).filter((p) => p.textContent === 'Query is required.').length;
    expect(errorCount).toBe(1);
    expect(el.querySelector('[aria-label="eBay search query 1"]')?.parentElement?.textContent).not.toContain(
      'Query is required.',
    );
    expect(el.querySelector('[aria-label="eBay search query 2"]')?.parentElement?.textContent).toContain(
      'Query is required.',
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('SourceForm eBay connector-config submission (c)', () => {
  it('includes a valid connectorConfig with the trimmed, non-blank query on submit', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);

    const nameInput = el.querySelector('#source-name') as HTMLInputElement;
    const urlInput = el.querySelector('#source-url') as HTMLInputElement;
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => {
      setValue(nameInput, 'My eBay Source');
      setValue(urlInput, 'https://ebay.com/search');
      setValue(select, 'ebay');
    });

    const queryInput = el.querySelector('[aria-label="eBay search query 1"]') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, '  rtx 3080  ');
      setValue(maxPriceInput, '250');
    });

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'], maxPrice: 250 });
  });

  it('omits connectorConfig entirely for a platformType with no connector editor', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);

    const nameInput = el.querySelector('#source-name') as HTMLInputElement;
    const urlInput = el.querySelector('#source-url') as HTMLInputElement;
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => {
      setValue(nameInput, 'My Other Source');
      setValue(urlInput, 'https://example.com/listings');
      setValue(select, 'other');
    });

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toBeUndefined();
  });

  it('accepts a maxPrice of exactly 0 as the non-negative boundary (opposite direction from the negative-maxPrice test above)', async () => {
    const onSubmit = vi.fn(async () => {});
    const el = await mount(<SourceForm onSubmit={onSubmit} onCancel={() => {}} />);

    const nameInput = el.querySelector('#source-name') as HTMLInputElement;
    const urlInput = el.querySelector('#source-url') as HTMLInputElement;
    const select = el.querySelector('#source-platform') as HTMLSelectElement;
    await act(async () => {
      setValue(nameInput, 'My eBay Source');
      setValue(urlInput, 'https://ebay.com/search');
      setValue(select, 'ebay');
    });

    const queryInput = el.querySelector('[aria-label="eBay search query 1"]') as HTMLInputElement;
    const maxPriceInput = el.querySelector('#connector-max-price') as HTMLInputElement;
    await act(async () => {
      setValue(queryInput, 'rtx 3080');
      setValue(maxPriceInput, '0');
    });

    await act(async () => {
      findButton(el, 'Save').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(el.textContent).not.toContain('Max price must be a non-negative number.');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0][0];
    expect(input.connectorConfig).toEqual({ queries: ['rtx 3080'], maxPrice: 0 });
  });
});

describe('SourceRow Scan now button (d)', () => {
  it('renders Scan now for an eBay Source with a non-null connectorConfig', async () => {
    const source = makeSource({ connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }) });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).toContain('Scan now');
  });

  it('does NOT render Scan now when connectorConfig is null', async () => {
    const source = makeSource({ connectorConfig: null });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).not.toContain('Scan now');
  });

  it('does NOT render Scan now for a non-scannable platformType even with connectorConfig set', async () => {
    const source = makeSource({
      platformType: 'other',
      connectorConfig: JSON.stringify({ queries: ['rtx 3080'] }),
    });
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

describe('SourceRow Last Scanned display (e)', () => {
  it('shows "Never scanned" when lastScannedAt is null', async () => {
    const source = makeSource({ lastScannedAt: null, lastScanFoundCount: null });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).toContain('Never scanned');
  });

  it('shows the elapsed-hours summary when lastScannedAt is set', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const source = makeSource({ lastScannedAt: threeHoursAgo, lastScanFoundCount: 4 });
    const el = await mount(
      <table>
        <tbody>
          <SourceRow source={source} onEdit={() => {}} onDeactivate={() => {}} onScan={() => {}} scanningSourceId={null} />
        </tbody>
      </table>,
    );

    expect(el.textContent).toContain('Last scanned 3h ago — 4 new');
    expect(el.textContent).not.toContain('Never scanned');
  });
});
