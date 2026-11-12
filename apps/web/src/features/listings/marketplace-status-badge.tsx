import type { MarketplaceListingStatus } from '@pc-parts-flipper/shared';
import { cn } from '@/lib/utils';

interface MarketplaceStatusBadgeProps {
  marketplaceStatus: MarketplaceListingStatus;
  className?: string;
}

const LABEL: Record<MarketplaceListingStatus, string> = {
  sold: 'Sold',
  removed: 'No longer listed',
};

/**
 * Small pill marking a Listing the scan pipeline has auto-transitioned to
 * `'removed'` status after a per-item recheck confirmed it's genuinely gone
 * from its own marketplace (Req 1, 3) — text distinguishes sold
 * (listing.marketplaceStatus === 'sold') from simply delisted
 * (listing.marketplaceStatus === 'removed'). Displayed in the listings
 * queue table and the listing detail/edit view. Uses rose/red styling to
 * distinguish it visually from NonWorkingBadge (amber) and EbayScanBadge
 * (emerald) — each badge conveys a separate concern, so they must read as
 * distinct signals on the same screen. Callers are responsible for only
 * rendering it once `listing.marketplaceStatus !== null` has already been
 * checked.
 */
export function MarketplaceStatusBadge({ marketplaceStatus, className }: MarketplaceStatusBadgeProps) {
  return (
    <span
      data-testid="marketplace-status-badge"
      className={cn(
        'inline-flex items-center rounded-full border border-rose-600/40 bg-rose-600/10 px-2 py-0.5 text-xs font-medium text-rose-700',
        className,
      )}
    >
      {LABEL[marketplaceStatus]}
    </span>
  );
}
