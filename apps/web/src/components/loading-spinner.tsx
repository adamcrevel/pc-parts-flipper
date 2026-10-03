import { cn } from '@/lib/utils';

interface LoadingSpinnerProps {
  className?: string;
  label?: string;
}

// Reusable loading indicator. Convention: render this in place of content
// while a screen's initial data fetch is in flight, e.g.
// `if (isLoading) return <LoadingSpinner />`. For list/table screens where
// the final layout shape is already known, prefer <Skeleton> instead so the
// page doesn't reflow once real content replaces the placeholder.
export function LoadingSpinner({ className, label = 'Loading…' }: LoadingSpinnerProps) {
  return (
    <div className={cn('flex items-center justify-center gap-2 p-8 text-muted-foreground', className)} role="status">
      {/* Decorative spinner glyph; the text label carries the accessible status */}
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
