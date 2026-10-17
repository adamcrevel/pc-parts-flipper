import { Link } from 'react-router-dom';
import type { PlatformType, SaleListing } from '@pc-parts-flipper/shared';
import { cn } from '@/lib/utils';

// Platform display labels, matching sources' own PLATFORM_LABELS — Sale
// Listings reuse the same fixed enum (Req 8).
const PLATFORM_LABELS: Record<PlatformType, string> = {
  ebay: 'eBay',
  mercari: 'Mercari',
  facebook_marketplace: 'Facebook Marketplace',
  other: 'Other',
};

interface SaleListingsListProps {
  saleListings: SaleListing[];
}

/**
 * Table of every Sale Listing (Req 8): platform, title, asking price, the
 * owning Part reference, and a draft/listed status badge derived from
 * `listedAt` (null = draft, set = posted — see saleListings.ts's shared
 * doc comment for why this is the chosen representation rather than a
 * separate status column). Each row links to the detail/edit screen.
 */
export function SaleListingsList({ saleListings }: SaleListingsListProps) {
  if (saleListings.length === 0) {
    return <p className="text-sm text-muted-foreground">No sale listings yet. Prepare one from a ready-to-list Part.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Title</th>
            <th className="px-4 py-2 font-medium">Platform</th>
            <th className="px-4 py-2 font-medium">Asking Price</th>
            <th className="px-4 py-2 font-medium">Part</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {saleListings.map((saleListing) => (
            <tr key={saleListing.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3 font-medium">
                <Link to={`/sale-listings/${saleListing.id}`} className="text-primary underline-offset-4 hover:underline">
                  {saleListing.title}
                </Link>
              </td>
              <td className="px-4 py-3">{PLATFORM_LABELS[saleListing.platform]}</td>
              <td className="px-4 py-3">${saleListing.askingPrice.toFixed(2)}</td>
              <td className="px-4 py-3">
                <Link to="/parts" title={saleListing.partId} className="text-primary underline-offset-4 hover:underline">
                  {saleListing.partId.slice(0, 8)}…
                </Link>
              </td>
              <td className="px-4 py-3">
                <span
                  className={cn(
                    'inline-block rounded-full border px-3 py-1 text-xs font-medium',
                    saleListing.listedAt ? 'border-emerald-600 bg-emerald-600/10 text-emerald-700' : 'border-border text-muted-foreground',
                  )}
                >
                  {saleListing.listedAt ? 'Listed' : 'Draft'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
