import type { IdentifyPartsJobStage } from '@pc-parts-flipper/shared';
import { cn } from '@/lib/utils';

interface IdentifyPartsStatusBadgeProps {
  // The Listing's latest identify-parts job state (ListingSummary.identifyPartsStatus):
  // null when no job has ever been run for that Listing, which is a distinct
  // state from a job that is still queued — the former renders a muted dash,
  // the latter an in-progress pill.
  status: { stage: IdentifyPartsJobStage; errorMessage: string | null } | null;
  className?: string;
}

// Short per-stage labels for the four non-terminal stages, mirroring the
// single-listing IdentifyPartsButton's own getStageMessage wording but
// trimmed to pill length — a table cell has no room for that component's
// full sentences.
const IN_PROGRESS_LABELS: Record<'queued' | 'identifying' | 'sourcing_references' | 'comparing', string> = {
  queued: 'Waiting to run…',
  identifying: 'In progress',
  sourcing_references: 'In progress',
  comparing: 'In progress',
};

/**
 * Small pill showing the state of a Listing's latest Identify-Parts job in
 * the listings queue table's "Identify Parts" column (Req 10/11). Four
 * visual states: no job yet (muted em-dash), still running (sky pill with a
 * pulsing dot), completed (teal pill), failed (destructive pill whose
 * native `title` attribute carries the job's error message, so the failure
 * reason is readable on hover without a tooltip component). Sky/teal/
 * destructive are deliberately none of the colours already in use on this
 * screen — EbayScanBadge is emerald, NonWorkingBadge amber, AiSuggestedBadge
 * violet — so job state never reads as one of those other signals.
 */
export function IdentifyPartsStatusBadge({ status, className }: IdentifyPartsStatusBadgeProps) {
  if (status === null) {
    return <span className={cn('text-xs text-muted-foreground', className)}>—</span>;
  }

  if (status.stage === 'completed') {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full border border-teal-600/40 bg-teal-600/10 px-2 py-0.5 text-xs font-medium text-teal-700',
          className,
        )}
      >
        Complete
      </span>
    );
  }

  if (status.stage === 'failed') {
    return (
      <span
        className={cn(
          'inline-flex cursor-help items-center rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive',
          className,
        )}
        // Req 11: the failure reason on hover. `errorMessage` is allowed to
        // be null even for a failed job, in which case no title is set at
        // all rather than one reading "null".
        title={status.errorMessage ?? undefined}
      >
        Failed
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-sky-600/40 bg-sky-600/10 px-2 py-0.5 text-xs font-medium text-sky-700',
        className,
      )}
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-600" />
      {IN_PROGRESS_LABELS[status.stage]}
    </span>
  );
}
