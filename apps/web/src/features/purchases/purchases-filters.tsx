import type { PurchaseStatus } from '@pc-parts-flipper/shared';

const STATUS_OPTIONS: Array<{ value: PurchaseStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'ordered', label: 'Ordered' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'received', label: 'Received' },
  { value: 'torn_down', label: 'Torn Down' },
  { value: 'closed', label: 'Closed' },
];

interface PurchasesFiltersProps {
  value: PurchaseStatus | '';
  onChange: (value: PurchaseStatus | '') => void;
}

/**
 * Status filter select for the Purchases list (per this task's simple
 * per-purchase browsing — the full sort/filter dashboard is T13's Req 11
 * aggregation screen). Controlled: the page owns `value` and re-fetches
 * whenever `onChange` fires, resetting to page 1 so a changed filter never
 * shows a stale offset past the end of the new, smaller result set.
 */
export function PurchasesFilters({ value, onChange }: PurchasesFiltersProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      Status
      <select
        className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as PurchaseStatus | '')}
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
