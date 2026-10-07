// @vitest-environment jsdom
//
// Proof for useThemePreference (use-theme-preference.ts): defaulting to
// 'system' with nothing stored, an explicit choice persisting to
// localStorage and applying the `dark` class synchronously (ahead of any
// effect/re-render), and a live matchMedia 'change' event updating the
// applied class while still in 'system' mode. Mounts the real hook inside a
// tiny probe component with react-dom/client + act(), following
// error-boundary.test.tsx / photo-upload.test.tsx's pattern (no React
// Testing Library in this workspace). jsdom does not implement
// window.matchMedia at all, so each test installs a controllable stub.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { useThemePreference, type ThemePreference } from '../src/lib/use-theme-preference';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'pc-parts-flipper:theme';

type ChangeListener = (event: MediaQueryListEvent) => void;

/**
 * Minimal controllable stand-in for `window.matchMedia('(prefers-color-scheme: dark)')`,
 * which jsdom does not implement. Only the subset the hook actually calls
 * (reading `.matches`, `addEventListener('change', ...)`,
 * `removeEventListener('change', ...)`) is real; everything else is cast
 * away since no test here drives it.
 */
function installMatchMediaMock(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<ChangeListener>();

  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.delete(listener);
    },
    // Cast reason: jsdom has no real MediaQueryList to satisfy structurally
    // (no addListener/removeListener/dispatchEvent/onchange implementation
    // exists here), and this test only ever drives the three members above.
  } as unknown as MediaQueryList;

  window.matchMedia = () => mediaQueryList;

  return {
    setMatches: (next: boolean) => {
      matches = next;
      listeners.forEach((listener) => listener({ matches: next } as MediaQueryListEvent));
    },
    listenerCount: () => listeners.size,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let probeApi: { theme: ThemePreference; setTheme: (next: ThemePreference) => void } | null = null;

function ThemeProbe() {
  probeApi = useThemePreference();
  return <span data-testid="theme-value">{probeApi.theme}</span>;
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  await act(async () => {
    root = createRoot(container!);
    root.render(<ThemeProbe />);
  });
  return container;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  probeApi = null;
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('useThemePreference', () => {
  it('defaults to system with nothing stored, and applies the OS-resolved class without writing to localStorage', async () => {
    installMatchMediaMock(false);

    const el = await mount();

    expect(el.querySelector('[data-testid="theme-value"]')?.textContent).toBe('system');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('writes an explicit choice to localStorage and applies the dark class synchronously, ahead of any effect/re-render', async () => {
    installMatchMediaMock(false);
    await mount();

    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Calling setTheme directly here, outside of act(), is deliberate: it
    // proves the class/localStorage write happen inside setTheme's own
    // synchronous call stack rather than depending on React scheduling a
    // re-render and flushing the theme-applying effect afterward. If that
    // write were moved into the effect instead, this assertion would still
    // see the pre-update DOM, since no act()/flush has run yet.
    probeApi!.setTheme('dark');

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    // Flush the resulting re-render so afterEach's unmount doesn't warn.
    await act(async () => {});
    expect(probeApi!.theme).toBe('dark');
  });

  it('survives a fresh hook mount simulating a page reload: a prior explicit choice is read back and applied on first render', async () => {
    installMatchMediaMock(false);
    await mount();

    probeApi!.setTheme('dark');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('dark');

    // Flush the setTheme-triggered re-render, then unmount this instance
    // and discard its state entirely, so the next mount below has nothing
    // to inherit from except what's actually sitting in localStorage —
    // the same thing a real page reload would start from.
    await act(async () => {});
    act(() => {
      root?.unmount();
    });
    container?.remove();
    probeApi = null;

    const el = await mount();

    // The fresh instance's very first render already reflects the stored
    // choice: both the hook's returned value and the DOM class it applied
    // as its initial-render side effect, with no setTheme call in this
    // second mount at all.
    expect(el.querySelector('[data-testid="theme-value"]')?.textContent).toBe('dark');
    expect(probeApi!.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('reacts to a live matchMedia change event while in system mode, without touching the stored preference', async () => {
    const media = installMatchMediaMock(false);
    await mount();

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(media.listenerCount()).toBe(1);

    await act(async () => {
      media.setMatches(true);
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // The stored/returned preference is still 'system' — only the applied
    // class moved, matching the OS, not a silently-promoted explicit choice.
    expect(probeApi!.theme).toBe('system');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
