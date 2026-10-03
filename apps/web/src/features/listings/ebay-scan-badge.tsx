import { cn } from '@/lib/utils';

interface EbayScanBadgeProps {
  // When present, the badge also links out to the original eBay listing
  // (Req 10 detail view); omitted in the queue table, where a row has no
  // room for an outbound link and the badge is informational only. A
  // null/missing listingUrl (allowed by the Listing type even for a
  // scan-created row) falls back to the non-link badge.
  listingUrl?: string | null;
  className?: string;
}

/**
 * Small pill shown on a Listing created by an automated eBay scan
 * (`externalItemId` non-null) — both the Listings queue table row and the
 * Listing detail/edit view render this via the one shared component
 * instead of duplicating the markup. Callers are responsible for only
 * rendering it once `externalItemId !== null` has already been checked.
 */
export function EbayScanBadge({ listingUrl, className }: EbayScanBadgeProps) {
  const badge = (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-emerald-600/40 bg-emerald-600/10 px-2 py-0.5 text-xs font-medium text-emerald-700',
        className,
      )}
    >
      Found via eBay scan
    </span>
  );

  if (!listingUrl) {
    return badge;
  }

  return (
    <a href={listingUrl} target="_blank" rel="noreferrer" className="inline-flex">
      {badge}
    </a>
  );
}
