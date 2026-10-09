import { Monitor, Moon, Sun } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '@/components/error-boundary';
import { useThemePreference, type ThemePreference } from '@/lib/use-theme-preference';

// Full nav contract from the feature plan (Goal/Tasks T5-T13): one entry per
// top-level screen, in the order the sidebar renders them.
const NAV_ITEMS = [
  { to: '/sources', label: 'Sources' },
  { to: '/listings', label: 'Listings' },
  { to: '/purchases', label: 'Purchases' },
  { to: '/parts', label: 'Parts' },
  { to: '/sale-listings', label: 'Sale Listings' },
  { to: '/profit-dashboard', label: 'Profit Dashboard' },
] as const;

// The sidebar's theme control: one icon button per ThemePreference value,
// in the order rendered. The icon alone (plus an aria-label) identifies
// each option — keeps the control compact next to the nav list above it.
const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

// App shell: a persistent left sidebar nav plus a main content area. Every
// top-level screen renders inside the <Outlet/> via the route tree in
// router.tsx; this layout itself never changes per-screen. The <Outlet/> is
// wrapped in an <ErrorBoundary/> so a render crash in one screen shows an
// error banner in the content area without taking down the sidebar nav.
export function RootLayout() {
  const { theme, setTheme } = useThemePreference();

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav className="w-56 shrink-0 border-r border-border p-4">
        <h2 className="mb-4 text-lg font-bold">PC Parts Flipper</h2>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  // NavLink's render-prop className: highlight whichever nav
                  // entry matches the current route.
                  cn(
                    'block rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground',
                    isActive && 'bg-surfaceContrast text-accent-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Theme</p>
          <div className="flex gap-1">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                type="button"
                variant={theme === value ? 'default' : 'outline'}
                size="icon"
                aria-label={label}
                aria-pressed={theme === value}
                onClick={() => setTheme(value)}
              >
                <Icon className="h-4 w-4" />
              </Button>
            ))}
          </div>
        </div>
      </nav>
      <main className="flex-1 overflow-y-auto p-6">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
