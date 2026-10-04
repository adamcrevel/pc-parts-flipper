import { cn } from '@/lib/utils';

interface AiSuggestedBadgeProps {
  className?: string;
}

/**
 * Small pill marking an Expected Parts row that the AI identification run
 * proposed and the user has not touched yet (ExpectedPartRow.aiSuggested).
 * Deliberately violet rather than the emerald EbayScanBadge uses: the two
 * can appear on the same screen and mean entirely different things (one is
 * "this Listing came from an eBay scan", this one is "this row is an
 * unreviewed draft"), so they must not read as the same signal.
 */
export function AiSuggestedBadge({ className }: AiSuggestedBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-violet-600/40 bg-violet-600/10 px-2 py-0.5 text-xs font-medium text-violet-700',
        className,
      )}
    >
      AI suggested
    </span>
  );
}
