// @vitest-environment jsdom
//
// Proof for root-layout's nav-link styling: the active nav link now renders
// with the surfaceContrast background token (instead of the old accent
// background), while hover classes remain unchanged. Mounts RootLayout with
// MemoryRouter to control the active route, following the react-router pattern.
// RootLayout also mounts useThemePreference internally (T4's sidebar theme
// control), which reads window.matchMedia — jsdom does not implement it, so
// every test here installs a minimal stub before mounting, the same way
// use-theme-preference.test.tsx does.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { RootLayout } from '../src/routes/root-layout';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  // Minimal stand-in for window.matchMedia: these tests never drive a live
  // OS-level theme change, so only `.matches` needs to resolve to something
  // and addEventListener/removeEventListener need to exist as no-ops.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

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

describe('RootLayout nav-link styling', () => {
  it('renders the active nav link with bg-surfaceContrast class, not bg-accent', async () => {
    const el = await mount(
      <MemoryRouter initialEntries={['/sources']}>
        <RootLayout />
      </MemoryRouter>,
    );

    // Find the "Sources" nav link, which should be active.
    const navLinks = el.querySelectorAll('nav a');
    let sourcesLink: HTMLElement | null = null;
    for (const link of navLinks) {
      if (link.textContent?.trim() === 'Sources') {
        sourcesLink = link;
        break;
      }
    }

    expect(sourcesLink).not.toBeNull();
    if (!sourcesLink) return; // TypeScript guard

    // The active link must have bg-surfaceContrast and text-accent-foreground,
    // but NOT the standalone bg-accent class (only hover:bg-accent).
    expect(sourcesLink.className).toContain('bg-surfaceContrast');
    expect(sourcesLink.className).toContain('text-accent-foreground');
    // Check for standalone bg-accent using word boundaries: must not appear
    // unless it's part of "hover:bg-accent"
    expect(sourcesLink.className).toMatch(/\bhover:bg-accent\b/);
    // Assert that bg-accent by itself (without prefix) is NOT present
    const classArray = sourcesLink.className.split(/\s+/);
    expect(classArray).not.toContain('bg-accent');
  });

  it('preserves hover:bg-accent and hover:text-accent-foreground classes on all nav links', async () => {
    const el = await mount(
      <MemoryRouter initialEntries={['/sources']}>
        <RootLayout />
      </MemoryRouter>,
    );

    // All nav links should have the hover classes, whether active or not.
    const navLinks = el.querySelectorAll('nav a');
    expect(navLinks.length).toBeGreaterThan(0);

    for (const link of navLinks) {
      expect(link.className).toContain('hover:bg-accent');
      expect(link.className).toContain('hover:text-accent-foreground');
    }
  });

  it('inactive nav link does not have bg-surfaceContrast or standalone bg-accent', async () => {
    const el = await mount(
      <MemoryRouter initialEntries={['/sources']}>
        <RootLayout />
      </MemoryRouter>,
    );

    // Find an inactive link (e.g., "Listings" when we're on "/sources").
    const navLinks = el.querySelectorAll('nav a');
    let listingsLink: HTMLElement | null = null;
    for (const link of navLinks) {
      if (link.textContent?.trim() === 'Listings') {
        listingsLink = link;
        break;
      }
    }

    expect(listingsLink).not.toBeNull();
    if (!listingsLink) return; // TypeScript guard

    // Inactive link should NOT have bg-surfaceContrast
    expect(listingsLink.className).not.toContain('bg-surfaceContrast');
    // Check that hover:bg-accent is present but standalone bg-accent is not
    expect(listingsLink.className).toContain('hover:bg-accent');
    const classArray = listingsLink.className.split(/\s+/);
    expect(classArray).not.toContain('bg-accent');
  });
});
