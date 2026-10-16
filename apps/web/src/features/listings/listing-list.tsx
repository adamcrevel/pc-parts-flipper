import { Fragment, useEffect, useRef } from 'react';
import { Image } from 'lucide-react';
import type {
  CreateListingInput,
  IdentifyPartsJobStage,
  ListingColumnFilters,
  ListingDetail,
  ListingSortDirection,
  ListingSortField,
  ListingStatus,
  ListingSummary,
  PricingStatus,
  Source,
} from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ListingForm } from '@/features/listings/listing-form';
import { EbayScanBadge } from '@/features/listings/ebay-scan-badge';
import { NonWorkingBadge } from '@/features/listings/non-working-badge';
import { IdentifyPartsStatusBadge } from '@/features/listings/identify-parts-status-badge';
import { PricingStatusBadge } from '@/features/listings/pricing-status-badge';
import { FilterableHeader } from '@/features/listings/filterable-header';
import { EnumFilterContent, NumberRangeFilterContent, TextFilterContent } from '@/features/listings/filter-content';
import { hasActiveColumnFilter, isColumnFilterSet } from '@/features/listings/column-filters';
import { cn } from '@/lib/utils';

interface ListingListProps {
  listings: ListingSummary[];
  sources: Source[];
  sourcesById: Map<string, Source>;
  // Which Listing's inline edit row is currently open, if any (owned by
  // ListingsPage, which is also the thing fetching the full ListingDetail
  // once a row opens).
  editingListingId: string | null;
  editingListing: ListingDetail | null;
  editingLoading: boolean;
  // Clicking a Listing's title toggles its inline row: opens it (and closes
  // whichever other row was open), or closes it if it's already the open one.
  onToggleEdit: (listing: ListingSummary) => void;
  onSubmitEdit: (input: CreateListingInput) => Promise<ListingDetail>;
  onCancelEdit: () => void;
  onSavedEdit: (listing: ListingDetail) => void;
  onAccept: (listing: ListingSummary) => void;
  onReject: (listing: ListingSummary) => void;
  // Req 4: the Listing id with an accept/reject request currently in
  // flight, if any — its row's buttons are disabled so a user can't fire a
  // second request against the same row before the first one resolves.
  pendingListingId: string | null;
  // Req 2: every Listing id matching the currently-applied filters, across
  // every page — not just the ids of `listings`, the current page's rows.
  // The header checkbox's tri-state is computed against this whole set, so
  // selecting "all" on page 1 reads as checked on page 5 too.
  allFilteredIds: string[];
  // Req 1/3: the ids currently selected. Owned by the page above, so the
  // selection outlives this component's page/filter-driven remounts.
  selectedIds: Set<string>;
  onToggleOne: (id: string) => void;
  onToggleAllFiltered: () => void;
  // The column currently sorted by and its direction, or `undefined` when
  // nothing has been sorted yet (the server's default newest-first order).
  // Only ever one field at a time — clicking a different header replaces it.
  sortBy?: ListingSortField;
  sortDirection?: ListingSortDirection;
  // Clicking a sortable header's label asks the page above to make that
  // field active (ascending) or, when it is already active, to flip its
  // direction. This component holds no sort state of its own.
  onSortChange: (field: ListingSortField) => void;
  // Req 8: true while the page above has a listings fetch in flight that
  // should visibly block interaction with the currently-displayed (now
  // stale) rows — every sortable header disables its click handler and the
  // whole table reads as inert, while the rows themselves stay visible
  // underneath rather than being replaced by a full-page spinner.
  isLoading?: boolean;
  // The filter currently applied to each column (Req 1-7), owned by the
  // page above exactly like the sort state: this component renders each
  // header's filter body from it and reports edits upward as a partial
  // patch — one column's field(s) at a time — never holding filter state
  // of its own. A column's own Clear (Req 9) is the same callback with that
  // column's field(s) set back to undefined.
  columnFilters: ListingColumnFilters;
  onColumnFilterChange: (patch: Partial<ListingColumnFilters>) => void;
}

// One table body plus, for whichever row is open, an extra full-width row
// directly beneath it holding the edit form — an inline "accordion" row
// rather than a separate top-of-page panel, so the form appears next to the
// Listing it edits regardless of scroll position.
const COLUMN_COUNT = 10;

// Every sortable/filterable column, in the left-to-right order the table
// renders them: the shared `ListingSortField` value sent to the server
// paired with the header label shown to the user, plus which
// `ListingColumnFilters` field(s) that column's filter lives in (a number
// column has two, its min and max bound). The two non-comparable columns
// (the leading selection checkbox and the trailing Accept/Reject actions)
// carry no comparable value, so they have no entry here and stay plain
// `<th>`s.
const COLUMNS: { field: ListingSortField; label: string; filterKeys: (keyof ListingColumnFilters)[] }[] = [
  { field: 'title', label: 'Title', filterKeys: ['title'] },
  { field: 'source', label: 'Source', filterKeys: ['sourceIds'] },
  { field: 'status', label: 'Status', filterKeys: ['statuses'] },
  { field: 'askingPrice', label: 'Asking Price', filterKeys: ['askingPriceMin', 'askingPriceMax'] },
  { field: 'expectedResale', label: 'Expected Resale', filterKeys: ['expectedResaleMin', 'expectedResaleMax'] },
  { field: 'difference', label: 'Expected Profit', filterKeys: ['differenceMin', 'differenceMax'] },
  { field: 'identifyParts', label: 'Sourcing Status', filterKeys: ['identifyPartsStages'] },
  { field: 'unpriced', label: 'Pricing Status', filterKeys: ['pricingStatuses'] },
];

// The fixed option lists for the three enum columns whose values are
// closed sets (Req 4-6). Source's list is not fixed — it comes from the
// page's live `sources` prop, matched by id — so it is built inline below.
const STATUS_OPTIONS: { value: ListingStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
];

// Req 5: the six job stages plus the explicit `'none'` sentinel the server
// matches to a Listing with no identify-parts job at all.
const IDENTIFY_PARTS_STAGE_OPTIONS: { value: IdentifyPartsJobStage | 'none'; label: string }[] = [
  { value: 'none', label: '(Not started)' },
  { value: 'queued', label: 'Queued' },
  { value: 'identifying', label: 'Identifying' },
  { value: 'sourcing_references', label: 'Sourcing References' },
  { value: 'comparing', label: 'Comparing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const PRICING_STATUS_OPTIONS: { value: PricingStatus; label: string }[] = [
  { value: 'not_priced', label: 'Not Priced' },
  { value: 'partially_priced', label: 'Partially Priced' },
  { value: 'fully_priced', label: 'Fully Priced' },
];

// An enum filter reports `[]` for "nothing checked"; the page's filter
// object stores that as an absent field (A4), the same way the text and
// number columns store theirs.
function checkedSetOrUndefined<T extends string>(value: T[]): T[] | undefined {
  return value.length > 0 ? value : undefined;
}

// The props every column's filter body is built from: which column, its
// header label, the page's whole filter object (each body reads only its
// own field(s)), the Sources for the Source column's options, and the
// patch callback. Shared by the two components below.
interface ColumnFilterContentProps {
  field: ListingSortField;
  label: string;
  columnFilters: ListingColumnFilters;
  sources: Source[];
  onChange: (patch: Partial<ListingColumnFilters>) => void;
}

/**
 * The checkbox multi-select body for one of the four enum columns (Req
 * 3-6): the column's fixed option list — or, for Source, one option per
 * Source the page knows about, every Source including inactive ones since
 * a past Listing may belong to one, labelled by name but matched by id —
 * bound to that column's array field. Split out of ColumnFilterContent
 * purely so neither switch has to carry the other's cases.
 */
function EnumColumnFilterContent({
  field,
  label,
  columnFilters,
  sources,
  onChange,
}: ColumnFilterContentProps & { field: 'source' | 'status' | 'identifyParts' | 'unpriced' }) {
  switch (field) {
    case 'source':
      return (
        <EnumFilterContent
          label={label}
          options={sources.map((source) => ({ value: source.id, label: source.name }))}
          value={columnFilters.sourceIds ?? []}
          onChange={(value) => onChange({ sourceIds: checkedSetOrUndefined(value) })}
        />
      );
    case 'status':
      return <EnumFilterContent label={label} options={STATUS_OPTIONS} value={columnFilters.statuses ?? []} onChange={(value) => onChange({ statuses: checkedSetOrUndefined(value) })} />;
    case 'identifyParts':
      return (
        <EnumFilterContent
          label={label}
          options={IDENTIFY_PARTS_STAGE_OPTIONS}
          value={columnFilters.identifyPartsStages ?? []}
          onChange={(value) => onChange({ identifyPartsStages: checkedSetOrUndefined(value) })}
        />
      );
    case 'unpriced':
      return (
        <EnumFilterContent
          label={label}
          options={PRICING_STATUS_OPTIONS}
          value={columnFilters.pricingStatuses ?? []}
          onChange={(value) => onChange({ pricingStatuses: checkedSetOrUndefined(value) })}
        />
      );
  }
}

/**
 * The filter body for one column's FilterableHeader popover: the content
 * component matching that column's type, bound to its field(s) in
 * `columnFilters`. Each change is reported as a patch holding only this
 * column's field(s), with a column's "no filter" value normalised to
 * `undefined` (`''` for text, `[]` for an enum) so the page's filter
 * object never carries an empty-but-present field. A number column's two
 * bounds always travel together in one patch (Req 7). The `isFiltered`
 * indicator is computed by the caller from the same `filterKeys` list, so
 * the two can't disagree about which field a column reads.
 */
function ColumnFilterContent(props: ColumnFilterContentProps) {
  const { field, label, columnFilters, onChange } = props;
  switch (field) {
    case 'title':
      return <TextFilterContent label={label} value={columnFilters.title ?? ''} onChange={(value) => onChange({ title: value === '' ? undefined : value })} />;
    case 'askingPrice':
      return (
        <NumberRangeFilterContent
          label={label}
          value={{ min: columnFilters.askingPriceMin, max: columnFilters.askingPriceMax }}
          onChange={(range) => onChange({ askingPriceMin: range.min, askingPriceMax: range.max })}
        />
      );
    case 'expectedResale':
      return (
        <NumberRangeFilterContent
          label={label}
          value={{ min: columnFilters.expectedResaleMin, max: columnFilters.expectedResaleMax }}
          onChange={(range) => onChange({ expectedResaleMin: range.min, expectedResaleMax: range.max })}
        />
      );
    case 'difference':
      return (
        <NumberRangeFilterContent
          label={label}
          value={{ min: columnFilters.differenceMin, max: columnFilters.differenceMax }}
          onChange={(range) => onChange({ differenceMin: range.min, differenceMax: range.max })}
        />
      );
    default:
      return <EnumColumnFilterContent {...props} field={field} />;
  }
}

/**
 * Table of every Listing (Req 2), each row showing the Req 3 comparison,
 * Source, Identify-Parts status, and Accept/Reject actions, plus a
 * selection checkbox column. Clicking a Listing's title (not a separate
 * Edit button) opens that Listing's edit form inline, directly below its
 * row. Every data column's header both sorts and filters that column.
 *
 * Two distinct empty states: with no rows and no active filter the table
 * is replaced by the "No listings yet" prompt, but once any column filter
 * is active (Req 13) the table — and so every header's filter and sort —
 * stays rendered, with a single full-width row saying nothing matched, so
 * a user can loosen the filter from right where they tightened it.
 */
export function ListingList({
  listings,
  sources,
  sourcesById,
  editingListingId,
  editingListing,
  editingLoading,
  onToggleEdit,
  onSubmitEdit,
  onCancelEdit,
  onSavedEdit,
  onAccept,
  onReject,
  pendingListingId,
  allFilteredIds,
  selectedIds,
  onToggleOne,
  onToggleAllFiltered,
  sortBy,
  sortDirection,
  onSortChange,
  isLoading,
  columnFilters,
  onColumnFilterChange,
}: ListingListProps) {
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  // Req 3: none/some/all of the *filtered* ids selected. With no filtered
  // ids at all nothing can be selected, so the header reads unchecked.
  const selectedFilteredCount = allFilteredIds.reduce((count, id) => (selectedIds.has(id) ? count + 1 : count), 0);
  const allFilteredSelected = allFilteredIds.length > 0 && selectedFilteredCount === allFilteredIds.length;
  const someFilteredSelected = selectedFilteredCount > 0 && selectedFilteredCount < allFilteredIds.length;

  // `indeterminate` is a DOM property with no JSX attribute, so it can only
  // be set imperatively on the element itself after each render that
  // changes it.
  useEffect(() => {
    if (headerCheckboxRef.current !== null) {
      headerCheckboxRef.current.indeterminate = someFilteredSelected;
    }
  }, [someFilteredSelected]);

  if (listings.length === 0 && !hasActiveColumnFilter(columnFilters)) {
    return <p className="text-sm text-muted-foreground">No listings yet. Add one to get started.</p>;
  }

  return (
    <div className="relative overflow-x-auto">
      {isLoading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <LoadingSpinner />
        </div>
      )}
      <table className="w-full border-collapse text-left text-sm">
        <thead className="relative z-20 bg-card">
          <tr className="border-b border-border text-muted-foreground">
            <th className="w-8 px-4 py-2 font-medium">
              <input
                ref={headerCheckboxRef}
                type="checkbox"
                aria-label="Select all filtered listings"
                checked={allFilteredSelected}
                onChange={onToggleAllFiltered}
              />
            </th>
            {COLUMNS.map((column) => (
              <FilterableHeader
                key={column.field}
                field={column.field}
                label={column.label}
                sortBy={sortBy}
                sortDirection={sortDirection}
                onSortChange={onSortChange}
                isLoading={isLoading}
                isFiltered={column.filterKeys.some((key) => isColumnFilterSet(columnFilters[key]))}
              >
                <ColumnFilterContent field={column.field} label={column.label} columnFilters={columnFilters} sources={sources} onChange={onColumnFilterChange} />
              </FilterableHeader>
            ))}
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody className={cn(isLoading && 'pointer-events-none opacity-60')}>
          {listings.length === 0 && (
            <tr>
              <td colSpan={COLUMN_COUNT} className="px-4 py-6 text-center text-muted-foreground">
                No listings match the current filters.
              </td>
            </tr>
          )}
          {listings.map((listing) => {
            const isOpen = listing.id === editingListingId;
            return (
              <Fragment key={listing.id}>
                <tr className={cn('border-b border-border last:border-0', isOpen && 'bg-muted/50')}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${listing.title}`}
                      checked={selectedIds.has(listing.id)}
                      onChange={() => onToggleOne(listing.id)}
                    />
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto whitespace-normal p-0 text-left font-medium"
                        onClick={() => onToggleEdit(listing)}
                      >
                        {listing.title}
                      </Button>
                      {listing.photoPaths.length > 0 && <Image className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Has photos" />}
                      {listing.externalItemId !== null && <EbayScanBadge />}
                      {listing.nonWorking && <NonWorkingBadge />}
                    </div>
                  </td>
                  <td className="px-4 py-3">{sourcesById.get(listing.sourceId)?.name ?? 'Unknown source'}</td>
                  <td className="px-4 py-3 capitalize">{listing.status}</td>
                  <td className="px-4 py-3">${listing.askingPrice.toFixed(2)}</td>
                  <td className="px-4 py-3">${listing.comparison.totalExpectedResaleValue.toFixed(2)}</td>
                  <td className={cn('px-4 py-3 font-medium', listing.comparison.difference >= 0 ? 'text-emerald-600' : 'text-destructive')}>
                    ${listing.comparison.difference.toFixed(2)}
                  </td>
                  <td className="px-4 py-3">
                    <IdentifyPartsStatusBadge status={listing.identifyPartsStatus} />
                  </td>
                  <td className="px-4 py-3">
                    <PricingStatusBadge pricingStatus={listing.pricingStatus} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {listing.status === 'open' && (
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => onAccept(listing)} disabled={listing.id === pendingListingId}>
                          Accept
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => onReject(listing)} disabled={listing.id === pendingListingId}>
                          Reject
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b border-border bg-muted/50 last:border-0">
                    <td colSpan={COLUMN_COUNT} className="px-4 py-3">
                      {editingLoading || editingListing === null ? (
                        <LoadingSpinner />
                      ) : (
                        <ListingForm initialValue={editingListing} sources={sources} onSubmit={onSubmitEdit} onCancel={onCancelEdit} onSaved={onSavedEdit} />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
