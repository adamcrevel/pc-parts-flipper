import { useState, type FormEvent } from 'react';
import type { Purchase, UpdatePurchaseInput } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';

// Field-level validation messages, keyed by the field they apply to. Mirrors
// the backend's own checks (apps/server/src/routes/purchaseValidation.ts)
// so the inline error appears without waiting on a round trip whenever
// possible, while the backend remains the source of truth.
interface FieldErrors {
  pricePaid?: string;
  purchaseDate?: string;
}

interface PurchaseEditFormProps {
  purchase: Purchase;
  onSubmit: (input: UpdatePurchaseInput) => Promise<void>;
  onCancel: () => void;
}

// Validates the two editable fields client-side (Requirement 13: reject
// save on blank required fields or negative monetary values with an inline
// error). `priceInput` is the raw text field value, not yet parsed.
function validate(priceInput: string, purchaseDate: string): FieldErrors {
  const errors: FieldErrors = {};
  const price = Number(priceInput);
  if (priceInput.trim().length === 0 || !Number.isFinite(price) || price < 0) {
    errors.pricePaid = 'Price paid is required and must be a non-negative number.';
  }
  if (purchaseDate.trim().length === 0) {
    errors.purchaseDate = 'Purchase date is required.';
  }
  return errors;
}

/**
 * Edit form for a Purchase's own price paid / purchase date (Req 5 — kept
 * independent of the originating Listing's asking price). Always opened
 * pre-filled from the current Purchase; the caller (purchase-detail-page.tsx)
 * supplies `onSubmit`, which PUTs the edit.
 */
export function PurchaseEditForm({ purchase, onSubmit, onCancel }: PurchaseEditFormProps) {
  const [priceInput, setPriceInput] = useState(String(purchase.pricePaid));
  const [purchaseDate, setPurchaseDate] = useState(purchase.purchaseDate);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validate(priceInput, purchaseDate);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onSubmit({ pricePaid: Number(priceInput), purchaseDate: purchaseDate.trim() });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to save purchase.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
      <div className="space-y-1">
        <label htmlFor="purchase-price-paid" className="text-sm font-medium">
          Price Paid
        </label>
        <input
          id="purchase-price-paid"
          type="number"
          step="0.01"
          value={priceInput}
          onChange={(e) => setPriceInput(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {fieldErrors.pricePaid && <p className="text-sm text-destructive">{fieldErrors.pricePaid}</p>}
      </div>

      <div className="space-y-1">
        <label htmlFor="purchase-date" className="text-sm font-medium">
          Purchase Date
        </label>
        <input
          id="purchase-date"
          type="date"
          value={purchaseDate}
          onChange={(e) => setPurchaseDate(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {fieldErrors.purchaseDate && <p className="text-sm text-destructive">{fieldErrors.purchaseDate}</p>}
      </div>

      {submitError && <ErrorBanner message={submitError} />}

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
