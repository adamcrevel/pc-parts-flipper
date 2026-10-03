import { cn } from '@/lib/utils';

interface ErrorBannerProps {
  message: string;
  className?: string;
}

// Reusable inline error display. Convention: render this below a form or in
// place of a list when a fetch/mutation fails, passing the caught error's
// user-facing message, e.g.
// `catch (err) { setError(err instanceof ApiError ? err.message : 'Something went wrong'); }`
// then `{error && <ErrorBanner message={error} />}`. For whole-screen render
// crashes (not caught fetch/mutation errors), <ErrorBoundary> renders this
// automatically instead.
export function ErrorBanner({ message, className }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn('rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive', className)}
    >
      {message}
    </div>
  );
}
