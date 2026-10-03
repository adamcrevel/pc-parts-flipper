import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// Pulsing placeholder block for list rows, table cells, and cards while data
// loads. Convention: size it (via className, e.g. "h-4 w-32") to match the
// real content it stands in for, and render one per expected row/field so
// the layout doesn't jump once the real data replaces it — this is the
// preferred loading convention over <LoadingSpinner> whenever the final
// shape of the content is already known (lists, cards, tables).
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
