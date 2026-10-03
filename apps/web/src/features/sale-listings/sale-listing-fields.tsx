import type { PlatformType } from '@pc-parts-flipper/shared';
import type { SaleListingFieldErrors } from '@/features/sale-listings/validate-sale-listing';

// Platform display labels/order, matching apps/web/src/features/sources'
// own PLATFORM_OPTIONS/PLATFORM_LABELS — Sale Listings reuse the same fixed
// enum (Req 8), so the same three values/labels apply here.
const PLATFORM_OPTIONS: Array<{ value: PlatformType; label: string }> = [
  { value: 'ebay', label: 'eBay' },
  { value: 'facebook_marketplace', label: 'Facebook Marketplace' },
  { value: 'other', label: 'Other' },
];

interface SaleListingFieldsProps {
  platform: PlatformType;
  onPlatformChange: (value: PlatformType) => void;
  title: string;
  onTitleChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  askingPrice: string;
  onAskingPriceChange: (value: string) => void;
  fieldErrors: SaleListingFieldErrors;
}

/**
 * The plain draft-editor input fields (platform, title, description,
 * asking price) for SaleListingForm. Split out purely to keep that file
 * under the ~200-line standing check, matching listing-fields.tsx's own
 * split out of listing-form.tsx — all state and validation stay owned by
 * the parent, this is presentational.
 */
export function SaleListingFields({
  platform,
  onPlatformChange,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  askingPrice,
  onAskingPriceChange,
  fieldErrors,
}: SaleListingFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label htmlFor="sale-listing-title" className="text-sm font-medium">
            Title
          </label>
          <input
            id="sale-listing-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.title && <p className="text-sm text-destructive">{fieldErrors.title}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="sale-listing-platform" className="text-sm font-medium">
            Platform
          </label>
          <select
            id="sale-listing-platform"
            value={platform}
            onChange={(e) => onPlatformChange(e.target.value as PlatformType)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="sale-listing-description" className="text-sm font-medium">
          Description
        </label>
        <textarea
          id="sale-listing-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="sale-listing-asking-price" className="text-sm font-medium">
          Asking Price ($)
        </label>
        <input
          id="sale-listing-asking-price"
          type="number"
          step="0.01"
          value={askingPrice}
          onChange={(e) => onAskingPriceChange(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {fieldErrors.askingPrice && <p className="text-sm text-destructive">{fieldErrors.askingPrice}</p>}
      </div>
    </>
  );
}
