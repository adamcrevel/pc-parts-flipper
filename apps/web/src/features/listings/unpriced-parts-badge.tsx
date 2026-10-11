import { cn } from '@/lib/utils';

interface UnpricedPartsBadgeProps {
  hasUnpricedParts: boolean;
  className?: string;
}

/**
 * Small pill marking a Listing that has at least one identified part with no
 * resale price set (listing.hasUnpricedParts). Displayed in the listings
 * queue table. Uses destructive (red) styling to distinguish it visually
 * from NonWorkingBadge (amber), EbayScanBadge (emerald), and
 * AiSuggestedBadge (violet) — each badge conveys a separate concern, so they
 * must read as distinct signals on the same screen. Renders nothing when
 * the listing has no unpriced parts.
 */
export function UnpricedPartsBadge({ hasUnpricedParts, className }: UnpricedPartsBadgeProps) {
  if (!hasUnpricedParts) {
    return null;
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive',
        className,
      )}
    >
      Unpriced
    </span>
  );
}
