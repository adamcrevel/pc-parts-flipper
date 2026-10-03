import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PurchaseDetail } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { fetchPurchase } from '@/features/purchases/purchases-api';
import { fetchTeardownForm, submitTeardown } from '@/features/teardown/teardown-api';
import { AdditionalPartsEditor } from '@/features/teardown/additional-parts-editor';
import { TeardownChecklist } from '@/features/teardown/teardown-checklist';
import {
  buildSubmitTeardownInput,
  initialTeardownRows,
  type AdditionalPartRow,
  type AdditionalPartRowErrors,
  type TeardownRow,
  type TeardownRowErrors,
} from '@/features/teardown/teardown-form-state';
import { validateAdditionalPartRows, validateTeardownRows } from '@/features/teardown/validate-teardown';

/**
 * Teardown checklist screen (Req 6): reconciles every Expected Part on a
 * 'received' Purchase's originating Listing against what actually arrived,
 * plus any Additional Parts found. Submitting creates the resulting Part
 * records and moves the Purchase to 'torn_down' (apps/server/src/routes/teardown.ts),
 * then returns to the Purchase detail screen.
 */
export function TeardownPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [purchase, setPurchase] = useState<PurchaseDetail | null>(null);
  const [rows, setRows] = useState<TeardownRow[]>([]);
  const [rowErrors, setRowErrors] = useState<TeardownRowErrors[]>([]);
  const [additionalRows, setAdditionalRows] = useState<AdditionalPartRow[]>([]);
  const [additionalRowErrors, setAdditionalRowErrors] = useState<AdditionalPartRowErrors[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadTeardownForm = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      // Sequential, not Promise.all — DuckDB's single shared connection
      // (apps/server/src/db/client.ts) proved intermittently unreliable
      // under overlapping concurrent queries (T8's lesson); the same
      // caution applies here since both calls hit that one server process.
      const purchaseDetail = await fetchPurchase(id);
      setPurchase(purchaseDetail);
      const form = await fetchTeardownForm(id);
      setRows(initialTeardownRows(form.expectedParts));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load the teardown form.');
    }
  }, [id]);

  useEffect(() => {
    void loadTeardownForm();
  }, [loadTeardownForm]);

  async function handleSubmit() {
    if (!id) return;
    const nextRowErrors = validateTeardownRows(rows);
    const nextAdditionalRowErrors = validateAdditionalPartRows(additionalRows);
    setRowErrors(nextRowErrors);
    setAdditionalRowErrors(nextAdditionalRowErrors);
    const hasRowErrors = nextRowErrors.some((errors) => Object.keys(errors).length > 0);
    const hasAdditionalErrors = nextAdditionalRowErrors.some((errors) => Object.keys(errors).length > 0);
    if (hasRowErrors || hasAdditionalErrors) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const result = await submitTeardown(id, buildSubmitTeardownInput(rows, additionalRows));
      navigate(`/purchases/${id}`, { state: { createdPartIds: result.createdParts.map((part) => part.id) } });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Failed to submit teardown.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (loadError) {
    return <ErrorBanner message={loadError} />;
  }
  if (!purchase) {
    return <LoadingSpinner />;
  }
  if (purchase.status !== 'received') {
    return (
      <div className="space-y-4">
        <Link to={`/purchases/${purchase.id}`} className="text-sm text-muted-foreground underline underline-offset-4">
          ← Back to Purchase
        </Link>
        <ErrorBanner message={`Teardown is only available while a purchase is 'received'; this purchase is currently '${purchase.status}'.`} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link to={`/purchases/${purchase.id}`} className="text-sm text-muted-foreground underline underline-offset-4">
          ← Back to Purchase
        </Link>
        <h1 className="text-2xl font-semibold">Teardown: {purchase.listing.title}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Expected Parts</CardTitle>
        </CardHeader>
        <CardContent>
          <TeardownChecklist rows={rows} rowErrors={rowErrors} onChange={setRows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Additional Parts Found</CardTitle>
        </CardHeader>
        <CardContent>
          <AdditionalPartsEditor rows={additionalRows} rowErrors={additionalRowErrors} onChange={setAdditionalRows} />
        </CardContent>
      </Card>

      {submitError && <ErrorBanner message={submitError} />}

      <div className="flex gap-2">
        <Button onClick={() => void handleSubmit()} disabled={isSubmitting}>
          {isSubmitting ? 'Submitting…' : 'Submit Teardown'}
        </Button>
      </div>
    </div>
  );
}
