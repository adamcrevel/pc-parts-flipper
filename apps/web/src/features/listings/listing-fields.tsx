import type { Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import type { ListingFieldErrors } from '@/features/listings/validate-listing';

interface ListingFieldsProps {
  sources: Source[];
  title: string;
  onTitleChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  listingUrl: string;
  onListingUrlChange: (value: string) => void;
  sourceId: string;
  onSourceIdChange: (value: string) => void;
  askingPrice: string;
  onAskingPriceChange: (value: string) => void;
  listingDate: string;
  onListingDateChange: (value: string) => void;
  acquisitionFees: string;
  onAcquisitionFeesChange: (value: string) => void;
  // True once the Listing has been saved at least once (ListingForm passes
  // `Boolean(saved)`). A Listing's Source is fixed at creation time — the
  // scan/import pipeline keys off it — so editing an existing row disables
  // the picker (Req 5) while a brand-new, not-yet-saved row leaves it open
  // (Req 6).
  sourceReadOnly: boolean;
  fieldErrors: ListingFieldErrors;
}

/**
 * The plain listing-level input fields (title, source, description, URL,
 * asking price, listing date, acquisition fees) for ListingForm. Split out
 * purely to keep listing-form.tsx under the ~200-line standing check — all
 * state and validation stay owned by the parent, this is presentational.
 */
export function ListingFields({
  sources,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  listingUrl,
  onListingUrlChange,
  sourceId,
  onSourceIdChange,
  askingPrice,
  onAskingPriceChange,
  listingDate,
  onListingDateChange,
  acquisitionFees,
  onAcquisitionFeesChange,
  sourceReadOnly,
  fieldErrors,
}: ListingFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label htmlFor="listing-title" className="text-sm font-medium">
            Title
          </label>
          <input id="listing-title" value={title} onChange={(e) => onTitleChange(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
          {fieldErrors.title && <p className="text-sm text-destructive">{fieldErrors.title}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="listing-source" className="text-sm font-medium">
            Source
          </label>
          <select
            id="listing-source"
            value={sourceId}
            onChange={(e) => onSourceIdChange(e.target.value)}
            disabled={sourceReadOnly}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="">Select a source…</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
          {fieldErrors.sourceId && <p className="text-sm text-destructive">{fieldErrors.sourceId}</p>}
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="listing-description" className="text-sm font-medium">
          Description
        </label>
        <textarea
          id="listing-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="listing-url" className="text-sm font-medium">
          Listing URL
        </label>
        <div className="flex gap-2">
          {/* The field is free text (no format validation beyond "required"
              in validate-listing.ts), so a blank/whitespace-only value has
              no URL to open — rendered as a disabled plain button (Req 4)
              rather than `asChild` over an `<a>` with an empty/missing
              href, which would be a dead link target. */}
          {listingUrl.trim() ? (
            <Button type="button" variant="outline" size="sm" asChild>
              <a href={listingUrl} target="_blank" rel="noreferrer">
                Open Link
              </a>
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled>
              Open Link
            </Button>
          )}
          <input
            id="listing-url"
            value={listingUrl}
            onChange={(e) => onListingUrlChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>
        {fieldErrors.listingUrl && <p className="text-sm text-destructive">{fieldErrors.listingUrl}</p>}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1">
          <label htmlFor="listing-asking-price" className="text-sm font-medium">
            Asking Price ($)
          </label>
          <input
            id="listing-asking-price"
            type="number"
            step="0.01"
            value={askingPrice}
            onChange={(e) => onAskingPriceChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.askingPrice && <p className="text-sm text-destructive">{fieldErrors.askingPrice}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="listing-date" className="text-sm font-medium">
            Listing Date
          </label>
          <input
            id="listing-date"
            type="date"
            value={listingDate}
            onChange={(e) => onListingDateChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.listingDate && <p className="text-sm text-destructive">{fieldErrors.listingDate}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="listing-fees" className="text-sm font-medium">
            Acquisition Fees / Shipping ($)
          </label>
          <input
            id="listing-fees"
            type="number"
            step="0.01"
            value={acquisitionFees}
            onChange={(e) => onAcquisitionFeesChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.acquisitionFees && <p className="text-sm text-destructive">{fieldErrors.acquisitionFees}</p>}
        </div>
      </div>
    </>
  );
}
