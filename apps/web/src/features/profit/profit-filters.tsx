import type { ProfitSortBy, ProfitSortDir, PurchaseStatus } from '@pc-parts-flipper/shared';

// The Req 11 filter/sort values: 'all' partial filter means no filter applied
// (both running and final rows show), distinct from explicitly choosing one.
export interface ProfitFilterValue {
  status: PurchaseStatus | '';
  partial: 'all' | 'partial' | 'final';
  sortBy: ProfitSortBy;
  sortDir: ProfitSortDir;
}

interface ProfitFiltersProps {
  value: ProfitFilterValue;
  onChange: (value: ProfitFilterValue) => void;
}

const STATUS_OPTIONS: Array<{ value: PurchaseStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'ordered', label: 'Ordered' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'received', label: 'Received' },
  { value: 'torn_down', label: 'Torn Down' },
  { value: 'closed', label: 'Closed' },
];

const PARTIAL_OPTIONS: Array<{ value: ProfitFilterValue['partial']; label: string }> = [
  { value: 'all', label: 'Partial + Final' },
  { value: 'partial', label: 'Partial (running) only' },
  { value: 'final', label: 'Final only' },
];

const SORT_BY_OPTIONS: Array<{ value: ProfitSortBy; label: string }> = [
  { value: 'purchaseDate', label: 'Purchase Date' },
  { value: 'netProfit', label: 'Net Profit' },
  { value: 'pricePaid', label: 'Price Paid' },
];

/**
 * Status, partial/final, and sort controls for the Profit dashboard (Req
 * 11). Fully controlled: the page owns `value` and re-fetches from
 * GET /api/purchases/profit whenever `onChange` fires, resetting to page 1
 * (handled by the caller) so a changed filter never shows a stale offset
 * past the end of the new, smaller result set.
 */
export function ProfitFilters({ value, onChange }: ProfitFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm">
        Status
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as PurchaseStatus | '' })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        Progress
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          value={value.partial}
          onChange={(e) => onChange({ ...value, partial: e.target.value as ProfitFilterValue['partial'] })}
        >
          {PARTIAL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        Sort by
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          value={value.sortBy}
          onChange={(e) => onChange({ ...value, sortBy: e.target.value as ProfitSortBy })}
        >
          {SORT_BY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        Direction
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          value={value.sortDir}
          onChange={(e) => onChange({ ...value, sortDir: e.target.value as ProfitSortDir })}
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
      </label>
    </div>
  );
}
