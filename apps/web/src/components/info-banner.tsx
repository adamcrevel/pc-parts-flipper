import { cn } from '@/lib/utils';

interface InfoBannerProps {
  message: string;
  // When provided, renders a dismiss control that calls this — use it for
  // advisory text the user should be able to clear once read. Omit it for
  // banners that must stay visible while their underlying condition holds.
  onDismiss?: () => void;
  className?: string;
}

// Non-error counterpart to <ErrorBanner>, same convention: render it inline
// below/above the section it describes, passing already-user-facing text,
// e.g. `{notes && <InfoBanner message={notes} onDismiss={() => setNotes(null)} />}`.
// `role="status"` (not "alert") so assistive tech announces it politely —
// this never reports a failure.
export function InfoBanner({ message, onDismiss, className }: InfoBannerProps) {
  return (
    <div
      role="status"
      className={cn('flex items-start justify-between gap-3 rounded-md border border-border bg-muted px-4 py-3 text-sm text-foreground', className)}
    >
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground">
          ×
        </button>
      )}
    </div>
  );
}
