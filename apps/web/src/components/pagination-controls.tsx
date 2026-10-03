import { Button } from '@/components/ui/button';

interface PaginationControlsProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

/**
 * Reusable prev/next pagination bar for any screen paging a backend list
 * endpoint by `limit`/`offset` (Req 15: the Listings queue and Purchases
 * dashboard both need this). `page` is 1-indexed; renders nothing once
 * every row fits on a single page, so screens below one page's worth of
 * rows stay visually unchanged.
 */
export function PaginationControls({ page, pageSize, total, onPageChange }: PaginationControlsProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (pageCount <= 1) {
    return null;
  }

  return (
    <div className="flex items-center justify-between pt-2 text-sm">
      <span className="text-muted-foreground">
        Page {page} of {pageCount} ({total} total)
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Previous
        </Button>
        <Button variant="outline" size="sm" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>
          Next
        </Button>
      </div>
    </div>
  );
}
