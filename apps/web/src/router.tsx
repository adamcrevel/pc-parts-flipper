import { createBrowserRouter, Navigate } from 'react-router-dom';
import { RootLayout } from '@/routes/root-layout';
import { SourcesPage } from '@/routes/sources-page';
import { ListingsPage } from '@/routes/listings-page';
import { PurchasesPage } from '@/routes/purchases-page';
import { PurchaseDetailPage } from '@/routes/purchase-detail-page';
import { TeardownPage } from '@/routes/teardown-page';
import { PartsPage } from '@/routes/parts-page';
import { SaleListingsPage } from '@/routes/sale-listings-page';
import { SaleListingNewPage } from '@/routes/sale-listing-new-page';
import { SaleListingDetailPage } from '@/routes/sale-listing-detail-page';
import { RecordSalePage } from '@/routes/record-sale-page';
import { ProfitDashboardPage } from '@/routes/profit-dashboard-page';

// Top-level route tree: every screen nests under RootLayout's <Outlet/>. The
// path list mirrors the full nav contract (Sources, Listings, Purchases,
// Parts, Sale Listings, Profit Dashboard) from the feature plan. Each path
// maps to its real screen; the paths themselves should stay stable since
// the sidebar nav (see root-layout.tsx) links to them by path.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      // Bare "/" redirects to Sources rather than rendering a separate
      // "home" screen — the plan has no dedicated landing page.
      { index: true, element: <Navigate to="/sources" replace /> },
      { path: 'sources', element: <SourcesPage /> },
      { path: 'listings', element: <ListingsPage /> },
      { path: 'purchases', element: <PurchasesPage /> },
      { path: 'purchases/:id', element: <PurchaseDetailPage /> },
      { path: 'purchases/:id/teardown', element: <TeardownPage /> },
      { path: 'parts', element: <PartsPage /> },
      { path: 'sale-listings', element: <SaleListingsPage /> },
      { path: 'sale-listings/new/:partId', element: <SaleListingNewPage /> },
      { path: 'sale-listings/:id', element: <SaleListingDetailPage /> },
      { path: 'record-sale/:partId', element: <RecordSalePage /> },
      { path: 'profit-dashboard', element: <ProfitDashboardPage /> },
    ],
  },
]);
