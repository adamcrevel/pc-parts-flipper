import { useState, type FormEvent } from 'react';
import type { CreateSourceInput, PlatformType, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';

// Platform options the <select> below renders, paired with the labels
// source-row.tsx uses for display — kept in sync by hand since there are
// only three fixed values (Req 1).
const PLATFORM_OPTIONS: Array<{ value: PlatformType; label: string }> = [
  { value: 'ebay', label: 'eBay' },
  { value: 'facebook_marketplace', label: 'Facebook Marketplace' },
  { value: 'other', label: 'Other' },
];

// Field-level validation messages, keyed by the field they apply to. Mirrors
// the backend's own blank-field checks (apps/server/src/routes/sources.ts)
// so the inline error appears without waiting on a round trip whenever
// possible, while the backend remains the source of truth.
interface FieldErrors {
  name?: string;
  platformType?: string;
  url?: string;
}

interface SourceFormProps {
  initialValue?: Source;
  onSubmit: (input: CreateSourceInput) => Promise<void>;
  onCancel: () => void;
}

// Validates the three required fields client-side, returning per-field
// messages for any left blank (Requirement 13: reject save on blank
// required fields with inline error).
function validate(name: string, platformType: string, url: string): FieldErrors {
  const errors: FieldErrors = {};
  if (name.trim().length === 0) {
    errors.name = 'Name is required.';
  }
  if (platformType.trim().length === 0) {
    errors.platformType = 'Platform is required.';
  }
  if (url.trim().length === 0) {
    errors.url = 'URL is required.';
  }
  return errors;
}

// Create/edit form for a Source. One component backs both modes: passing
// `initialValue` pre-fills the fields for editing; omitting it starts blank
// for creation. The caller (sources-page.tsx) supplies `onSubmit`, which
// POSTs or PUTs depending on which mode it was opened in.
export function SourceForm({ initialValue, onSubmit, onCancel }: SourceFormProps) {
  const [name, setName] = useState(initialValue?.name ?? '');
  const [platformType, setPlatformType] = useState<PlatformType | ''>(initialValue?.platformType ?? '');
  const [url, setUrl] = useState(initialValue?.url ?? '');
  const [notes, setNotes] = useState(initialValue?.notes ?? '');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validate(name, platformType, url);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), platformType: platformType as PlatformType, url: url.trim(), notes: notes.trim() || null });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to save source.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
      <div className="space-y-1">
        <label htmlFor="source-name" className="text-sm font-medium">
          Name
        </label>
        <input
          id="source-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {fieldErrors.name && <p className="text-sm text-destructive">{fieldErrors.name}</p>}
      </div>

      <div className="space-y-1">
        <label htmlFor="source-platform" className="text-sm font-medium">
          Platform
        </label>
        <select
          id="source-platform"
          value={platformType}
          onChange={(e) => setPlatformType(e.target.value as PlatformType)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        >
          <option value="">Select a platform…</option>
          {PLATFORM_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {fieldErrors.platformType && <p className="text-sm text-destructive">{fieldErrors.platformType}</p>}
      </div>

      <div className="space-y-1">
        <label htmlFor="source-url" className="text-sm font-medium">
          URL
        </label>
        <input
          id="source-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {fieldErrors.url && <p className="text-sm text-destructive">{fieldErrors.url}</p>}
      </div>

      <div className="space-y-1">
        <label htmlFor="source-notes" className="text-sm font-medium">
          Notes
        </label>
        <textarea
          id="source-notes"
          value={notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>

      {submitError && <ErrorBanner message={submitError} />}

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
