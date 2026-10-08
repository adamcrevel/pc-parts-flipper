import { cn } from '@/lib/utils';

interface NonWorkingBadgeProps {
  className?: string;
}

/**
 * Small pill marking a Listing where the computer cannot be powered on or has
 * non-functional components (listing.nonWorking). Displayed in the listings
 * queue table and the listing detail/edit view. Uses amber/orange styling to
 * distinguish it visually from EbayScanBadge (emerald) and AiSuggestedBadge
 * (violet) — each badge conveys a separate concern, so they must read as
 * distinct signals on the same screen.
 */
export function NonWorkingBadge({ className }: NonWorkingBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-amber-600/40 bg-amber-600/10 px-2 py-0.5 text-xs font-medium text-amber-700',
        className,
      )}
    >
      Non-working
    </span>
  );
}
