import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Filter } from 'lucide-react';
import type { ListingSortDirection, ListingSortField } from '@pc-parts-flipper/shared';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * The filter half of a FilterableHeader: a funnel icon button, filled and
 * dotted while `isFiltered`, outline otherwise, so a filtered column reads
 * as filtered without opening its popover. Kept separate from
 * FilterableHeader below so neither function carries the other's
 * branching; it forwards its ref and the props Radix injects, which is
 * what lets `PopoverTrigger asChild` own this real <button> rather than
 * wrapping it in one.
 */
const FilterTrigger = forwardRef<HTMLButtonElement, { label: string; isFiltered: boolean } & ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ label, isFiltered, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        'relative inline-flex cursor-pointer items-center rounded-sm border-0 bg-transparent p-0.5 transition-colors hover:text-foreground',
        isFiltered && 'text-foreground',
        className,
      )}
      aria-label={`Filter by ${label}${isFiltered ? ' (filter active)' : ''}`}
      {...props}
    >
      <Filter className={cn('h-3.5 w-3.5 shrink-0', isFiltered && 'fill-current')} aria-hidden="true" />
      {isFiltered && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />}
    </button>
  ),
);
FilterTrigger.displayName = 'FilterTrigger';

/**
 * A sortable column header that also carries that column's filter. The
 * label is the same sort button `SortableHeader` has always rendered —
 * same markup, same arrow-only-when-active rule, same `aria-sort`, same
 * Req 8 `isLoading` disabling — and clicking it still only sorts. The
 * filter lives in a second, sibling button next to it: a separate
 * interactive element inside the same `<th>`, never nested inside the sort
 * button, so neither one's click can reach the other. That button opens a
 * popover rendering whatever filter body the caller passes as `children`
 * (one of TextFilterContent / EnumFilterContent /
 * NumberRangeFilterContent), which keeps this component ignorant of what
 * any particular column's filter actually looks like.
 *
 * `isFiltered` drives the trigger's active look — a filled funnel plus a
 * dot, versus an outline funnel — and is a plain prop rather than anything
 * derived here, so the indicator can never drift from the filter the page
 * has actually applied. Unlike the sort button the trigger stays enabled
 * while `isLoading`: a user watching a slow fetch should still be able to
 * open a filter and adjust it, and the table's own loading overlay already
 * governs interaction with the stale rows.
 */
export function FilterableHeader({
  field,
  label,
  sortBy,
  sortDirection,
  onSortChange,
  isLoading,
  isFiltered,
  children,
}: {
  field: ListingSortField;
  label: string;
  sortBy?: ListingSortField;
  sortDirection?: ListingSortDirection;
  onSortChange: (field: ListingSortField) => void;
  isLoading?: boolean;
  // True when this column currently has a non-empty filter applied. Owned
  // by the page that owns the filter values themselves.
  isFiltered: boolean;
  // The filter body rendered inside this column's popover.
  children: ReactNode;
}) {
  const isActive = sortBy === field;
  // A field can only ever be active ascending or descending; an active
  // field with no direction yet reads as ascending, matching the page's own
  // first-click behaviour.
  const isDescending = isActive && sortDirection === 'desc';
  const Arrow = isDescending ? ArrowDown : ArrowUp;

  return (
    <th className="px-4 py-2 font-medium" aria-sort={isActive ? (isDescending ? 'descending' : 'ascending') : 'none'}>
      <div className="inline-flex items-center gap-1">
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onSortChange(field)}
          disabled={isLoading}
        >
          {label}
          {isActive && <Arrow className="h-3.5 w-3.5 shrink-0" aria-label={`Sorted ${isDescending ? 'descending' : 'ascending'}`} />}
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <FilterTrigger label={label} isFiltered={isFiltered} />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-3 font-normal normal-case text-foreground">
            {children}
          </PopoverContent>
        </Popover>
      </div>
    </th>
  );
}
