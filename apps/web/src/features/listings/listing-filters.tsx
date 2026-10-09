import type { ListingStatus, Source } from '@pc-parts-flipper/shared';

// The Req 12 filter values: an empty string means "no filter" for both
// selects, distinct from any real status/Source id value.
export interface ListingsQueueFilterValue {
  status: ListingStatus | '';
  sourceId: string | '';
}

interface ListingFiltersProps {
  value: ListingsQueueFilterValue;
  sources: Source[];
  onChange: (value: ListingsQueueFilterValue) => void;
}

const STATUS_OPTIONS: Array<{ value: ListingStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
];

/**
 * Status and Source filter selects for the Listings view (Req 12). Both
 * selects are controlled: the page owns `value` and re-fetches whenever
 * `onChange` fires, resetting to page 1 so a changed filter never shows a
 * stale offset past the end of the new, smaller result set.
 */
export function ListingFilters({ value, sources, onChange }: ListingFiltersProps) {
  return (
    <div className="flex items-center gap-4">
      <label className="flex items-center gap-2 text-sm">
        Status
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as ListingStatus | '' })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        Source
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm"
          value={value.sourceId}
          onChange={(e) => onChange({ ...value, sourceId: e.target.value })}
        >
          <option value="">All sources</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
