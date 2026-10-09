import { useState } from 'react';
import type { IdentifyPartsBulkOutcome, IdentifyPartsBulkResult } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { InfoBanner } from '@/components/info-banner';
import { ApiError } from '@/lib/api-client';
import { enqueueBulkIdentifyParts } from '@/features/listings/listings-api';

interface BulkIdentifyPartsBarProps {
  // Req 1/3: the ids currently selected in the queue table, owned by the
  // page above so the selection survives paging and filter changes. Taking
  // the Set rather than a count lets this component send the request itself
  // instead of making the page assemble the payload for it.
  selectedIds: Set<string>;
  // Called once a bulk enqueue request has completed (Req 8/9): the server
  // answered, whatever the per-Listing outcomes were. A request that failed
  // at the network/request level never calls this, so the selection stays
  // intact and the user can retry without re-picking rows.
  onCleared: () => void;
}

/**
 * Fixed bottom action bar for the Listings Queue's bulk Identify-Parts run
 * (Req 8/9): shows how many rows are selected and enqueues one
 * `POST /api/listings/identify-parts/bulk` for all of them, then reports
 * back what the server did with each — queued, already running, or not
 * found — rather than silently dropping the ids it could not act on.
 *
 * Owns its own in-flight/summary/error state the same way
 * IdentifyPartsButton does, and renders nothing at all when there is
 * neither a selection nor a summary still worth showing: the parent mounts
 * it unconditionally, so keeping that gate here is what lets the result
 * banner outlive the selection it reports on (clearing the selection on
 * success would otherwise unmount the banner the instant it appeared).
 */
export function BulkIdentifyPartsBar({ selectedIds, onCleared }: BulkIdentifyPartsBarProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleIdentify() {
    setSubmitError(null);
    setSummary(null);
    setIsSubmitting(true);

    try {
      const results = await enqueueBulkIdentifyParts([...selectedIds]);
      setSummary(formatBulkSummary(results));
      onCleared();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to start bulk identify parts.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const selectedCount = selectedIds.size;
  if (selectedCount === 0 && summary === null && submitError === null) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-4 py-3 shadow-lg">
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        {summary !== null && <InfoBanner message={summary} onDismiss={() => setSummary(null)} />}
        {submitError !== null && <ErrorBanner message={submitError} />}
        {selectedCount > 0 && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-muted-foreground">{selectedCount} selected</span>
            <Button type="button" size="sm" onClick={() => void handleIdentify()} disabled={isSubmitting}>
              {isSubmitting ? 'Starting…' : 'Identify Parts'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// Req 8/9: one user-facing line counting each outcome bucket the server can
// report. `not_found` is always named when present — those ids were asked
// for and nothing ran for them, which the user has to be told rather than
// left to infer from a smaller queued count.
function formatBulkSummary(results: IdentifyPartsBulkResult[]): string {
  const counts: Record<IdentifyPartsBulkOutcome, number> = { queued: 0, already_active: 0, not_found: 0 };
  for (const result of results) {
    counts[result.outcome] += 1;
  }

  const parts = [`Queued ${counts.queued} listing(s) for Identify Parts.`];
  if (counts.already_active > 0) {
    parts.push(`${counts.already_active} already running.`);
  }
  if (counts.not_found > 0) {
    parts.push(`${counts.not_found} not found.`);
  }
  return parts.join(' ');
}
