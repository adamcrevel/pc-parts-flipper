import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import type { PurchaseDetail } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/loading-spinner';
import { ErrorBanner } from '@/components/error-banner';
import { ApiError } from '@/lib/api-client';
import { fetchPurchase, updatePurchase, updatePurchaseStatus } from '@/features/purchases/purchases-api';
import { PurchaseStatusControl } from '@/features/purchases/purchase-status-control';
import { PurchaseEditForm } from '@/features/purchases/purchase-edit-form';

/** Navigation state the teardown screen (T9) hands off on a successful submission, so this screen can show a one-time confirmation without a Parts API this task doesn't build (T10 owns the full Parts screen). */
interface TeardownCompleteState {
  createdPartIds: string[];
}

/**
 * Purchase detail screen (Req 5): full status with a lifecycle indicator
 * and one-step-forward status update, the Purchase's own editable price
 * paid/purchase date, and the originating Listing's title plus its
 * Expected Parts — the same context T9's teardown screen reconciles
 * against.
 */
export function PurchaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const teardownComplete = location.state as TeardownCompleteState | null;
  const [purchase, setPurchase] = useState<PurchaseDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isAdvancing, setIsAdvancing] = useState(false);

  const loadPurchase = useCallback(async () => {
    if (!id) return;
    setLoadError(null);
    try {
      setPurchase(await fetchPurchase(id));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load purchase.');
    }
  }, [id]);

  useEffect(() => {
    void loadPurchase();
  }, [loadPurchase]);

  async function handleAdvance(nextStatus: Parameters<typeof updatePurchaseStatus>[1]) {
    if (!purchase) return;
    setActionError(null);
    setIsAdvancing(true);
    try {
      const next = await updatePurchaseStatus(purchase.id, nextStatus);
      setPurchase(next);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to update status.');
    } finally {
      setIsAdvancing(false);
    }
  }

  async function handleEditSubmit(input: Parameters<typeof updatePurchase>[1]) {
    if (!purchase) return;
    const next = await updatePurchase(purchase.id, input);
    setPurchase(next);
    setIsEditing(false);
  }

  if (loadError) {
    return <ErrorBanner message={loadError} />;
  }
  if (!purchase) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <div>
        <Link to="/purchases" className="text-sm text-muted-foreground underline underline-offset-4">
          ← Back to Purchases
        </Link>
        <h1 className="text-2xl font-semibold">{purchase.listing.title}</h1>
      </div>

      {actionError && <ErrorBanner message={actionError} />}

      {teardownComplete && (
        <Card>
          <CardHeader>
            <CardTitle>Teardown Complete</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{teardownComplete.createdPartIds.length} part(s) created. Full Parts screen coming in a later task.</p>
            <ul className="list-inside list-disc text-muted-foreground">
              {teardownComplete.createdPartIds.map((partId) => (
                <li key={partId}>{partId}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Status</CardTitle>
          {purchase.status === 'received' && (
            <Button asChild size="sm">
              <Link to={`/purchases/${purchase.id}/teardown`}>Start Teardown</Link>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <PurchaseStatusControl status={purchase.status} onAdvance={handleAdvance} isAdvancing={isAdvancing} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Purchase Details</CardTitle>
          {!isEditing && (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <PurchaseEditForm purchase={purchase} onSubmit={handleEditSubmit} onCancel={() => setIsEditing(false)} />
          ) : (
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Price Paid</dt>
              <dd>${purchase.pricePaid.toFixed(2)}</dd>
              <dt className="text-muted-foreground">Purchase Date</dt>
              <dd>{purchase.purchaseDate}</dd>
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expected Parts</CardTitle>
        </CardHeader>
        <CardContent>
          {purchase.listing.expectedParts.length === 0 ? (
            <p className="text-sm text-muted-foreground">This listing had no Expected Parts recorded.</p>
          ) : (
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Category</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium">Est. Resale Value</th>
                </tr>
              </thead>
              <tbody>
                {purchase.listing.expectedParts.map((part) => (
                  <tr key={part.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">{part.componentCategory}</td>
                    <td className="px-4 py-3">{part.description}</td>
                    <td className="px-4 py-3">${part.estimatedResaleValue.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
