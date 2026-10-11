import type { PricingStatus } from '@pc-parts-flipper/shared';
import { cn } from '@/lib/utils';

interface PricingStatusBadgeProps {
  pricingStatus: PricingStatus;
  className?: string;
}

/**
 * Pill marking a Listing's pricing state in the "Pricing Status" column of
 * the listings queue table, keyed on listing.pricingStatus. Always
 * renders — unlike the badges it sits beside (EbayScanBadge, NonWorkingBadge,
 * AiSuggestedBadge) it is never absent, just one of three states:
 * "Not Priced" (neutral/muted) when no identified part has a resale price
 * set, "Partially Priced" (destructive/red) when some but not all
 * identified parts have a price, or "Fully Priced" (teal, matching
 * IdentifyPartsStatusBadge's "completed"-stage pill) once every identified
 * part has a price.
 */
export function PricingStatusBadge({ pricingStatus, className }: PricingStatusBadgeProps) {
  if (pricingStatus === 'not_priced') {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground',
          className,
        )}
      >
        Not Priced
      </span>
    );
  }

  if (pricingStatus === 'partially_priced') {
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
