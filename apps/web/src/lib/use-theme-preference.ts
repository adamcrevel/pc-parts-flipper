import { useCallback, useEffect, useState } from 'react';

// The three choices the sidebar's theme control offers. 'system' means
// "follow the OS", not a fixed value — it is re-derived from matchMedia
// every time it's applied, not stored as whichever of light/dark it
// resolved to at the moment it was picked.
export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'pc-parts-flipper:theme';

/** Narrows an arbitrary localStorage read to a valid ThemePreference, defaulting to 'system'. */
function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Reads the stored preference, defaulting to 'system' when nothing (or something invalid) is stored. */
function readStoredTheme(): ThemePreference {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isThemePreference(stored) ? stored : 'system';
}

/**
 * Resolves a stored preference to the concrete light/dark value that should
 * actually be applied: 'light'/'dark' pass through unchanged, 'system' is
 * re-derived from the OS's current prefers-color-scheme every call (never
 * cached), so a later call after an OS change returns the new value.
 */
function resolveEffectiveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies (or removes) Tailwind's `dark` class on the document root to match the resolved effective theme. */
function applyEffectiveTheme(effective: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', effective === 'dark');
}

/**
 * Theme preference hook: reads/writes the user's Light/Dark/System choice
 * under the `pc-parts-flipper:theme` localStorage key and keeps the `dark`
 * class on <html> in sync with it.
 *
 * Flow:
 *  - Initial state is read synchronously from localStorage (defaulting to
 *    'system') so the very first render already has the right preference —
 *    the effect below then applies the matching class as its one-time
 *    side effect of touching the DOM.
 *  - While the preference is 'system', an effect subscribes to
 *    matchMedia('(prefers-color-scheme: dark)')'s `change` event so a live
 *    OS-level flip (no reload) re-applies the `dark` class immediately; the
 *    stored preference itself stays 'system' throughout — only the applied
 *    class moves. The subscription is torn down on cleanup/preference
 *    change, same as any other effect-owned listener.
 *  - `setTheme` is used for an explicit 'light'/'dark' choice: it writes to
 *    localStorage and applies the resolved class synchronously, in the
 *    same tick as the call, rather than leaving the DOM stale until the
 *    effect below next runs — that would otherwise show a one-frame flash
 *    of the old theme before the effect catches up.
 */
export function useThemePreference() {
  const [theme, setThemeState] = useState<ThemePreference>(() => readStoredTheme());

  useEffect(() => {
    applyEffectiveTheme(resolveEffectiveTheme(theme));

    if (theme !== 'system') return;

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => applyEffectiveTheme(resolveEffectiveTheme('system'));
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    window.localStorage.setItem(STORAGE_KEY, next);
    applyEffectiveTheme(resolveEffectiveTheme(next));
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}
