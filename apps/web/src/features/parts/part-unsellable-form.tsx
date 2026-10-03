import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';

interface PartUnsellableFormProps {
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}

/**
 * Inline "Mark Unsellable" reason-note form, opened per-row from
 * PartsTable for a `ready_to_list` Part (Req 7). The reason note is
 * required (Requirement 13: reject save on blank required fields with
 * inline error) — validated client-side here, mirroring the backend's own
 * check in apps/server/src/routes/partValidation.ts, which remains the
 * source of truth.
 */
export function PartUnsellableForm({ onSubmit, onCancel }: PartUnsellableFormProps) {
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reason.trim().length === 0) {
      setFieldError('A reason note is required to mark a part unsellable.');
      return;
    }
    setFieldError(null);
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to mark part unsellable.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="space-y-1">
        <label htmlFor="unsellable-reason" className="text-sm font-medium">
          Reason
        </label>
        <textarea
          id="unsellable-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why can't this part be sold?"
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {fieldError && <p className="text-sm text-destructive">{fieldError}</p>}
      </div>

      {submitError && <ErrorBanner message={submitError} />}

      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Confirm Unsellable'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
