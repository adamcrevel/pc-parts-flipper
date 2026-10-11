import { cn } from '@/lib/utils';

interface PricingStatusBadgeProps {
  hasUnpricedParts: boolean;
  className?: string;
}

/**
 * Pill marking a Listing's pricing state in the "Pricing Status" column of
 * the listings queue table, keyed on listing.hasUnpricedParts. Always
 * renders — unlike the badges it sits beside (EbayScanBadge, NonWorkingBadge,
 * AiSuggestedBadge) it is never absent, just one of two states: "Partially
 * Priced" (destructive/red, matching the old "Unpriced" pill's styling) when
 * at least one identified part has no resale price set, or "Fully Priced"
 * (teal, matching IdentifyPartsStatusBadge's "completed"-stage pill) once
 * every identified part has a price.
 */
export function PricingStatusBadge({ hasUnpricedParts, className }: PricingStatusBadgeProps) {
  if (hasUnpricedParts) {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive',
          className,
        )}
      >
        Partially Priced
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-teal-600/40 bg-teal-600/10 px-2 py-0.5 text-xs font-medium text-teal-700',
        className,
      )}
    >
      Fully Priced
    </span>
  );
}
