import type { SaleFieldErrors } from '@/features/sales/validate-sale';

interface SaleFieldsProps {
  soldPrice: string;
  onSoldPriceChange: (value: string) => void;
  soldDate: string;
  onSoldDateChange: (value: string) => void;
  platformFee: string;
  onPlatformFeeChange: (value: string) => void;
  shippingCost: string;
  onShippingCostChange: (value: string) => void;
  buyerNote: string;
  onBuyerNoteChange: (value: string) => void;
  fieldErrors: SaleFieldErrors;
}

/**
 * The plain Record Sale input fields (sold price, sold date, platform fee,
 * shipping cost, optional buyer note) for RecordSaleForm. Split out purely
 * to keep that file under the ~200-line standing check, matching
 * sale-listing-fields.tsx's own split out of sale-listing-form.tsx — all
 * state and validation stay owned by the parent, this is presentational.
 */
export function SaleFields({
  soldPrice,
  onSoldPriceChange,
  soldDate,
  onSoldDateChange,
  platformFee,
  onPlatformFeeChange,
  shippingCost,
  onShippingCostChange,
  buyerNote,
  onBuyerNoteChange,
  fieldErrors,
}: SaleFieldsProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label htmlFor="sale-sold-price" className="text-sm font-medium">
            Sold Price
          </label>
          <input
            id="sale-sold-price"
            type="number"
            step="0.01"
            value={soldPrice}
            onChange={(e) => onSoldPriceChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.soldPrice && <p className="text-sm text-destructive">{fieldErrors.soldPrice}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="sale-sold-date" className="text-sm font-medium">
            Sold Date
          </label>
          <input
            id="sale-sold-date"
            type="date"
            value={soldDate}
            onChange={(e) => onSoldDateChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.soldDate && <p className="text-sm text-destructive">{fieldErrors.soldDate}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label htmlFor="sale-platform-fee" className="text-sm font-medium">
            Platform Fee
          </label>
          <input
            id="sale-platform-fee"
            type="number"
            step="0.01"
            value={platformFee}
            onChange={(e) => onPlatformFeeChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.platformFee && <p className="text-sm text-destructive">{fieldErrors.platformFee}</p>}
        </div>

        <div className="space-y-1">
          <label htmlFor="sale-shipping-cost" className="text-sm font-medium">
            Shipping Cost
          </label>
          <input
            id="sale-shipping-cost"
            type="number"
            step="0.01"
            value={shippingCost}
            onChange={(e) => onShippingCostChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          {fieldErrors.shippingCost && <p className="text-sm text-destructive">{fieldErrors.shippingCost}</p>}
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="sale-buyer-note" className="text-sm font-medium">
          Buyer Note (optional)
        </label>
        <textarea
          id="sale-buyer-note"
          value={buyerNote}
          onChange={(e) => onBuyerNoteChange(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>
    </>
  );
}
