import type { PartStatus } from '@pc-parts-flipper/shared';

const STATUS_OPTIONS: Array<{ value: PartStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'ready_to_list', label: 'Ready to List' },
  { value: 'listed', label: 'Listed' },
  { value: 'sold', label: 'Sold' },
  { value: 'unsellable', label: 'Unsellable' },
];

interface PartsFiltersProps {
  value: PartStatus | '';
  onChange: (value: PartStatus | '') => void;
}

/**
 * Status filter select for the Parts list (Req 7, 10). Controlled: the page
 * owns `value` and re-fetches whenever `onChange` fires, resetting to page
 * 1 so a changed filter never shows a stale offset past the end of the new,
 * smaller result set — same convention as PurchasesFilters.
 */
export function PartsFilters({ value, onChange }: PartsFiltersProps) {
  return (
    <label className="flex items-center gap-2 text-sm">
      Status
      <select
        className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
        value={value}
        onChange={(e) => onChange(e.target.value as PartStatus | '')}
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
