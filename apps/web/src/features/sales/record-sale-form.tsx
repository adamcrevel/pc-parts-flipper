import { useState, type FormEvent } from 'react';
import type { RecordSaleResponse } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { SaleFields } from '@/features/sales/sale-fields';
import { recordSale } from '@/features/sales/sales-api';
import { validateSaleFields, type SaleFieldErrors } from '@/features/sales/validate-sale';

interface RecordSaleFormProps {
  partId: string;
  onRecorded: (result: RecordSaleResponse) => void;
}

/**
 * Record Sale form for a `listed` Part (Req 9): sold price, sold date,
 * platform fee, shipping cost, and an optional buyer note, with inline
 * Requirement 13 validation (every money field >= 0, sold date required).
 * On submit, posts the sale, which also advances the Part's status
 * `listed -> sold` (Req 7) — the response carries both, so the caller can
 * confirm the new status without a second round trip.
 */
export function RecordSaleForm({ partId, onRecorded }: RecordSaleFormProps) {
  const [soldPrice, setSoldPrice] = useState('');
  const [soldDate, setSoldDate] = useState('');
  const [platformFee, setPlatformFee] = useState('');
  const [shippingCost, setShippingCost] = useState('');
  const [buyerNote, setBuyerNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<SaleFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateSaleFields(soldPrice, soldDate, platformFee, shippingCost);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const result = await recordSale(partId, {
        soldPrice: Number(soldPrice),
        soldDate,
        platformFee: Number(platformFee),
        shippingCost: Number(shippingCost),
        buyerNote: buyerNote.trim() || null,
      });
      onRecorded(result);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to record sale.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
      <SaleFields
        soldPrice={soldPrice}
        onSoldPriceChange={setSoldPrice}
        soldDate={soldDate}
        onSoldDateChange={setSoldDate}
        platformFee={platformFee}
        onPlatformFeeChange={setPlatformFee}
        shippingCost={shippingCost}
        onShippingCostChange={setShippingCost}
        buyerNote={buyerNote}
        onBuyerNoteChange={setBuyerNote}
        fieldErrors={fieldErrors}
      />

      {submitError && <ErrorBanner message={submitError} />}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Recording…' : 'Record Sale'}
      </Button>
    </form>
  );
}
