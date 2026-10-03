import { NavLink, Outlet } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '@/components/error-boundary';

// Full nav contract from the feature plan (Goal/Tasks T5-T13): one entry per
// top-level screen, in the order the sidebar renders them.
const NAV_ITEMS = [
  { to: '/sources', label: 'Sources' },
  { to: '/listings', label: 'Listings' },
  { to: '/listings-queue', label: 'Listings Queue' },
  { to: '/purchases', label: 'Purchases' },
  { to: '/parts', label: 'Parts' },
  { to: '/sale-listings', label: 'Sale Listings' },
  { to: '/profit-dashboard', label: 'Profit Dashboard' },
] as const;

// App shell: a persistent left sidebar nav plus a main content area. Every
// top-level screen renders inside the <Outlet/> via the route tree in
// router.tsx; this layout itself never changes per-screen. The <Outlet/> is
// wrapped in an <ErrorBoundary/> so a render crash in one screen shows an
// error banner in the content area without taking down the sidebar nav.
export function RootLayout() {
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
                    isActive && 'bg-accent text-accent-foreground',
                  )
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="flex-1 overflow-y-auto p-6">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
