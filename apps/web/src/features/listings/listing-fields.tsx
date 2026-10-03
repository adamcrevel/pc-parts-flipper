import type { Source } from '@pc-parts-flipper/shared';
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
          <select id="listing-source" value={sourceId} onChange={(e) => onSourceIdChange(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm">
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
        <input id="listing-url" value={listingUrl} onChange={(e) => onListingUrlChange(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
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
