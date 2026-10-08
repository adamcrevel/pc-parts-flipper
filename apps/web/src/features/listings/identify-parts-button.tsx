import { useEffect, useRef, useState } from 'react';
import type { ExpectedPart, ListingDetail, IdentifyPartsJob, IdentifyPartsJobStage } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { InfoBanner } from '@/components/info-banner';
import { ApiError } from '@/lib/api-client';
import {
  enqueueIdentifyPartsJob,
  fetchIdentifyPartsJob,
  fetchLatestIdentifyPartsJob,
  fetchListing,
  ackIdentifyPartsJob,
} from '@/features/listings/listings-api';

interface IdentifyPartsButtonProps {
  // The saved Listing, or `undefined` while it's still unsaved (create
  // mode): there is no id to identify against yet, so the save-first hint
  // renders in place of the button. Taking the whole Listing rather than
  // `listingId: string | undefined` lets ListingForm hand its own `saved`
  // state straight over, with no `?.`/ternary of its own — one more branch in
  // a component that measures a cyclomatic complexity of 14 (verified with
  // eslint --rule complexity). This reflects additions from prior tasks:
  // pricingStatus state (Req 17), two new polling-related nested functions
  // (startPricingPolling, clearPricingPolling), and extended cleanup logic.
  // Keeping this count updated is a convention this codebase watches by hand;
  // no eslint `complexity` rule enforces it.
  listing: ListingDetail | undefined;
  // Called once a completed job's parts are confirmed saved server-side
  // (apps/server/src/jobs/identifyPartsWorkerPool.ts persists them,
  // aiConfidence/aiSource included, the instant the job finishes — this
  // component never saves anything itself). `expectedParts` is the
  // Listing's full, freshly re-fetched set, already carrying whichever
  // rows should show the "AI suggested" badge (ExpectedPart.aiConfidence/
  // aiSource). The parent re-syncs its own editor rows from it — this
  // component never owns or replaces those rows directly.
  onPartsSaved: (expectedParts: ExpectedPart[]) => void;
}

/**
 * On-demand "Identify Parts" control for an existing Listing: enqueues an
 * async Identify-Parts job via `POST /api/listings/:id/identify-parts`, then
 * polls the job by id every 2 seconds to track its progress through the queue
 * and pipeline stages. The job's identified parts are saved server-side the
 * moment it completes — never by this component — so on completion this
 * only re-fetches the Listing and hands its authoritative Expected Parts
 * back to ListingForm to display. Owns its own job tracking, in-flight/
 * notes/error state the same way PhotoUpload does, and like PhotoUpload it
 * needs a saved Listing (the route reads that Listing's stored photos) — so
 * with no id yet it renders a save-first hint instead.
 *
 * On mount, resumes any non-terminal job already in progress for this Listing,
 * or applies any terminal job not yet delivered to the caller. The queue
 * ensures only one job runs per Listing at a time; a 409 conflict on enqueue
 * is caught and recovered by fetching the active job instead.
 */
export function IdentifyPartsButton({ listing, onPartsSaved }: IdentifyPartsButtonProps) {
  const [job, setJob] = useState<IdentifyPartsJob | null>(null);
  const [identifyError, setIdentifyError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  // Free-text caveats from the model that belong to the run as a whole
  // rather than any one part (e.g. "these look like stock photos").
  // Dismissible: it is advisory, and nothing depends on it staying up.
  const [notes, setNotes] = useState<string | null>(null);
  // Shows "Pricing N part(s)…" while the background price-estimation
  // pipeline (part-price-estimation feature) is still filling in
  // estimatedResaleValue for rows the identify-parts job just marked
  // priceSource: 'auto'. Only ever set from applyTerminalJob below — never
  // from a plain Listing Save, which doesn't touch this component at all.
  const [pricingStatus, setPricingStatus] = useState<string | null>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const pricingPollIntervalRef = useRef<number | null>(null);

  // Stage-to-message mapping for non-terminal jobs.
  function getStageMessage(stage: IdentifyPartsJobStage): string {
    switch (stage) {
      case 'queued':
        return 'Waiting to run…';
      case 'identifying':
        return 'Reading the listing text and photos with AI…';
      case 'sourcing_references':
        return 'Sourcing reference photos from manufacturer sites…';
      case 'comparing':
        return 'Comparing photos against reference images…';
      default:
        return '';
    }
  }

  // Applies a terminal job result (success or failure) and marks it as
  // delivered. On success, re-fetches the Listing rather than trusting the
  // job's own copy of the parts: the worker pool already persisted them,
  // badge fields included (apps/server/src/jobs/identifyPartsWorkerPool.ts),
  // so this is reading back what's actually saved, not submitting anything
  // itself. Requires a saved `listing` prop, which is always true here —
  // this function is only ever reached once the save-first gate below has
  // already passed.
  async function applyTerminalJob(terminalJob: IdentifyPartsJob) {
    try {
      if (terminalJob.stage === 'completed' && terminalJob.parts && listing) {
        const refreshed = await fetchListing(listing.id);
        onPartsSaved(refreshed.expectedParts);
        if (terminalJob.notes && terminalJob.notes.trim().length > 0) {
          setNotes(terminalJob.notes);
        }
        const unpriced = refreshed.expectedParts.filter((part) => part.priceSource === 'auto' && part.estimatedResaleValue === null).length;
        if (unpriced > 0) {
          startPricingPolling(listing.id, unpriced);
        }
      } else if (terminalJob.stage === 'failed') {
        setIdentifyError(terminalJob.errorMessage || 'Job failed with no error message.');
      }
    } finally {
      await ackIdentifyPartsJob(terminalJob.id);
    }
  }

  // Clears the pricing-status polling interval if one is running.
  function clearPricingPolling() {
    if (pricingPollIntervalRef.current !== null) {
      clearInterval(pricingPollIntervalRef.current);
      pricingPollIntervalRef.current = null;
    }
  }

  // Starts polling the Listing every 2000ms -- the same interval
  // startPolling above uses for job-stage polling -- to watch the
  // background price-estimation pipeline fill in estimatedResaleValue for
  // rows applyTerminalJob just found still priceSource: 'auto' with no
  // price yet. Only ever called from applyTerminalJob above (Req 17): this
  // is the identify-parts completion path, never a plain Listing Save, so
  // this loop never starts from anywhere else. Stops once every such row
  // has a price, or silently after 60 polls (2 minutes) -- the pipeline may
  // simply be slow, or a row may never resolve a price, and neither is an
  // error this component should surface.
  function startPricingPolling(listingId: string, initialUnpriced: number) {
    clearPricingPolling();
    let pollsRemaining = 60;
    setPricingStatus(`Pricing ${initialUnpriced} part(s)…`);
    pricingPollIntervalRef.current = window.setInterval(async () => {
      try {
        const refreshed = await fetchListing(listingId);
        const unpriced = refreshed.expectedParts.filter((part) => part.priceSource === 'auto' && part.estimatedResaleValue === null).length;
        onPartsSaved(refreshed.expectedParts);

        if (unpriced === 0) {
          clearPricingPolling();
          setPricingStatus(null);
          return;
        }

        pollsRemaining -= 1;
        if (pollsRemaining <= 0) {
          clearPricingPolling();
          setPricingStatus(null);
          return;
        }

        setPricingStatus(`Pricing ${unpriced} part(s)…`);
      } catch {
        clearPricingPolling();
        setPricingStatus(null);
      }
    }, 2000);
  }

  // Clears the polling interval if one is running.
  function clearPolling() {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }

  // Starts polling the given job every 2000ms until it reaches a terminal state.
  function startPolling(jobId: string) {
    clearPolling();
    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const polledJob = await fetchIdentifyPartsJob(jobId);
        setJob(polledJob);

        if (polledJob.stage === 'completed' || polledJob.stage === 'failed') {
          clearPolling();
          await applyTerminalJob(polledJob);
          setJob(null);
        }
      } catch (err) {
        clearPolling();
        setIdentifyError(err instanceof ApiError ? err.message : 'Failed to fetch job status.');
        setJob(null);
      }
    }, 2000);
  }

  // On mount, resume any non-terminal job or apply any terminal undelivered job.
  useEffect(() => {
    if (listing === undefined) {
      return;
    }

    const id = listing.id;

    async function resumeJob() {
      setIdentifyError(null);
      setInfoMessage(null);
      setNotes(null);

      try {
        const latest = await fetchLatestIdentifyPartsJob(id);
        if (latest === null) {
          return;
        }

        if (latest.stage === 'completed' || latest.stage === 'failed') {
          // Terminal job that hasn't been delivered yet.
          if (!latest.delivered) {
            await applyTerminalJob(latest);
          }
        } else {
          // Non-terminal job: resume polling.
          setJob(latest);
          startPolling(latest.id);
        }
      } catch (err) {
        setIdentifyError(err instanceof ApiError ? err.message : 'Failed to resume identify job.');
      }
    }

    resumeJob();

    return () => {
      clearPolling();
      clearPricingPolling();
    };
  }, [listing?.id]);

  // Handle "Identify Parts" button click: enqueue a new job.
  async function handleIdentify(id: string) {
    setIdentifyError(null);
    setInfoMessage(null);
    setNotes(null);

    try {
      const newJob = await enqueueIdentifyPartsJob(id);
      setJob(newJob);
      startPolling(newJob.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Job already exists for this listing; fetch and resume it.
        try {
          const active = await fetchLatestIdentifyPartsJob(id);
          if (active && (active.stage === 'queued' || active.stage === 'identifying' || active.stage === 'sourcing_references' || active.stage === 'comparing')) {
            setJob(active);
            setInfoMessage('Already identifying this listing\'s parts');
            startPolling(active.id);
          } else {
            setIdentifyError('Could not resume existing job.');
          }
        } catch (resumeErr) {
          setIdentifyError(resumeErr instanceof ApiError ? resumeErr.message : 'Failed to resume existing job.');
        }
      } else {
        setIdentifyError(err instanceof ApiError ? err.message : 'Failed to identify parts.');
      }
    }
  }

  // Create mode: nothing exists server-side to identify against yet, so the
  // control is replaced by the same kind of save-first hint PhotoUpload's
  // gate shows. Declared after the hooks above so hook order stays stable.
  if (listing === undefined) {
    return <p className="text-sm text-muted-foreground">Save the listing to identify parts with AI.</p>;
  }

  const isIdentifying = job !== null && job.stage !== 'completed' && job.stage !== 'failed';
  const statusMessage = (isIdentifying && job ? getStageMessage(job.stage) : '') || pricingStatus || '';

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" onClick={() => void handleIdentify(listing.id)} disabled={isIdentifying}>
        {isIdentifying ? 'Identifying parts…' : 'Identify Parts'}
      </Button>

      {statusMessage && <p className="text-sm text-muted-foreground">{statusMessage}</p>}
      {infoMessage && <InfoBanner message={infoMessage} onDismiss={() => setInfoMessage(null)} />}
      {notes !== null && <InfoBanner message={notes} onDismiss={() => setNotes(null)} />}
      {identifyError && <ErrorBanner message={identifyError} />}
    </div>
  );
}
