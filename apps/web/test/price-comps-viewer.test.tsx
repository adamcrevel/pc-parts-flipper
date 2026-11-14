// @vitest-environment jsdom
//
// Proof for the "View comps" affordance (price-comps-viewer.tsx, T4):
// collapsed by default (no fetch fired until the user expands it), fetches
// via `fetchPriceComps` on first expand and renders a loading state while
// in flight, then either the comp list (title/link, formatted price or
// "price unknown", condition, Sold/Listed tag) or — when `comps` comes back
// empty — a plain "No comps recorded for this part yet." line, never an
// error state for an empty array (Req 5).
//
// fetchPriceComps is mocked; nothing here touches the network. Mounts the
// real component via react-dom/client + act(), matching
// expected-parts-editor.test.tsx's own no-RTL pattern.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { GetPriceCompsResponse } from '@pc-parts-flipper/shared';
import { PriceCompsViewer } from '../src/features/listings/price-comps-viewer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fetchPriceCompsMock = vi.fn();

vi.mock('@/features/listings/listings-api', () => ({
  fetchPriceComps: (...args: unknown[]) => fetchPriceCompsMock(...args),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  fetchPriceCompsMock.mockReset();
});

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(element);
  });
  return container;
}

function toggleButton(el: HTMLElement): HTMLElement {
  return el.querySelector('[role="button"]') as HTMLElement;
}

const compsResponse: GetPriceCompsResponse = {
  estimatedResaleValue: 289,
  lastResearchedAt: '2026-11-10T00:00:00.000Z',
  comps: [
    { title: 'NVIDIA RTX 3070 FE 8GB — tested working', url: 'https://www.ebay.com/itm/394827561093', priceUsd: 285, condition: 'Used', saleType: 'sold', linkStatus: 'live' },
    { title: 'ASUS TUF RTX 3070 OC 8GB', url: 'https://www.mercari.com/item/m1', priceUsd: null, condition: null, saleType: 'listed', linkStatus: null },
  ],
};

const emptyResponse: GetPriceCompsResponse = { estimatedResaleValue: null, lastResearchedAt: null, comps: [] };

describe('PriceCompsViewer', () => {
  it('renders only the collapsed "View comps" toggle and fires no fetch until expanded', async () => {
    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);

    expect(el.textContent).toContain('View comps');
    expect(toggleButton(el).getAttribute('aria-expanded')).toBe('false');
    expect(fetchPriceCompsMock).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain('No comps recorded');
  });

  it('fetches via fetchPriceComps with the given category/brand/partNumber on first expand and shows a loading state while in flight', async () => {
    let resolveFetch!: (value: GetPriceCompsResponse) => void;
    fetchPriceCompsMock.mockReturnValue(new Promise<GetPriceCompsResponse>((resolve) => (resolveFetch = resolve)));

    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);
    await act(async () => toggleButton(el).click());

    expect(fetchPriceCompsMock).toHaveBeenCalledWith('GPU', 'NVIDIA', 'RTX 3070');
    expect(el.textContent).toContain('Loading comps');

    await act(async () => {
      resolveFetch(emptyResponse);
      await Promise.resolve();
    });
  });

  it('renders each comp row (title as a real new-tab link, formatted price, condition, Sold/Listed tag) when comps come back', async () => {
    fetchPriceCompsMock.mockResolvedValue(compsResponse);
    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);

    await act(async () => toggleButton(el).click());

    const links = Array.from(el.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links).toHaveLength(2);

    expect(links[0].getAttribute('href')).toBe('https://www.ebay.com/itm/394827561093');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].textContent).toContain('NVIDIA RTX 3070 FE 8GB — tested working');
    expect(links[0].textContent).toContain('$285.00');
    expect(links[0].textContent).toContain('Used');
    expect(links[0].textContent).toContain('Sold');

    expect(links[1].textContent).toContain('price unknown');
    expect(links[1].textContent).toContain('Listed');
    expect(links[1].textContent).not.toContain('Sold');

    expect(links[0].textContent).not.toContain('Archived');
    expect(links[1].textContent).not.toContain('Archived');
  });

  it('renders an Archived pill only for a comp whose linkStatus is \'archived\', not for \'live\' or null', async () => {
    fetchPriceCompsMock.mockResolvedValue({
      estimatedResaleValue: null,
      lastResearchedAt: '2026-11-10T00:00:00.000Z',
      comps: [
        { title: 'Dead-link listing', url: 'https://web.archive.org/web/2026/https://example.com/itm/1', priceUsd: 199, condition: 'Used', saleType: 'sold', linkStatus: 'archived' },
        { title: 'Live listing', url: 'https://www.ebay.com/itm/2', priceUsd: 99, condition: 'New', saleType: 'listed', linkStatus: 'live' },
        { title: 'Unchecked listing', url: 'https://www.ebay.com/itm/3', priceUsd: 50, condition: 'New', saleType: null, linkStatus: null },
      ],
    } satisfies GetPriceCompsResponse);
    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);

    await act(async () => toggleButton(el).click());

    const links = Array.from(el.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links).toHaveLength(3);

    expect(links[0].textContent).toContain('Archived');
    expect(links[1].textContent).not.toContain('Archived');
    expect(links[2].textContent).not.toContain('Archived');
  });

  it('renders the Archived pill alongside the Sold pill, not in place of it, on the same comp row', async () => {
    fetchPriceCompsMock.mockResolvedValue({
      estimatedResaleValue: null,
      lastResearchedAt: '2026-11-10T00:00:00.000Z',
      comps: [
        { title: 'Dead-link sold listing', url: 'https://web.archive.org/web/2026/https://example.com/itm/1', priceUsd: 199, condition: 'Used', saleType: 'sold', linkStatus: 'archived' },
      ],
    } satisfies GetPriceCompsResponse);
    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);

    await act(async () => toggleButton(el).click());

    const links = Array.from(el.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('Archived');
    expect(links[0].textContent).toContain('Sold');
  });

  it('renders the Archived pill alongside the Listed pill, not in place of it, on the same comp row', async () => {
    fetchPriceCompsMock.mockResolvedValue({
      estimatedResaleValue: null,
      lastResearchedAt: '2026-11-10T00:00:00.000Z',
      comps: [
        { title: 'Dead-link listed listing', url: 'https://web.archive.org/web/2026/https://example.com/itm/2', priceUsd: 99, condition: 'New', saleType: 'listed', linkStatus: 'archived' },
      ],
    } satisfies GetPriceCompsResponse);
    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);

    await act(async () => toggleButton(el).click());

    const links = Array.from(el.querySelectorAll('a')) as HTMLAnchorElement[];
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('Archived');
    expect(links[0].textContent).toContain('Listed');
  });

  it('renders the plain empty-state line, not an error, when comps comes back as an empty array', async () => {
    fetchPriceCompsMock.mockResolvedValue(emptyResponse);
    const el = await mount(<PriceCompsViewer category="PSU" brand="Corsair" partNumber="RM750" />);

    await act(async () => toggleButton(el).click());

    expect(el.textContent).toContain('No comps recorded for this part yet.');
    expect(el.querySelectorAll('a')).toHaveLength(0);
    expect(el.textContent?.toLowerCase()).not.toContain('error');
  });

  it('does not re-fetch on a second expand once a response has already been cached', async () => {
    fetchPriceCompsMock.mockResolvedValue(compsResponse);
    const el = await mount(<PriceCompsViewer category="GPU" brand="NVIDIA" partNumber="RTX 3070" />);

    await act(async () => toggleButton(el).click());
    expect(fetchPriceCompsMock).toHaveBeenCalledTimes(1);

    await act(async () => toggleButton(el).click()); // collapse
    await act(async () => toggleButton(el).click()); // expand again

    expect(fetchPriceCompsMock).toHaveBeenCalledTimes(1);
  });
});
