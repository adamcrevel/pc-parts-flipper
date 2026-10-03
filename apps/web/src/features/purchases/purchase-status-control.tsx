import type { PurchaseStatus } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Mirrors apps/server/src/routes/purchaseValidation.ts's PURCHASE_STATUS_ORDER
// (Req 5) — kept in sync by hand since there are only five fixed statuses.
const STATUS_ORDER: readonly PurchaseStatus[] = ['ordered', 'shipped', 'received', 'torn_down', 'closed'];
const STATUS_LABELS: Record<PurchaseStatus, string> = {
  ordered: 'Ordered',
  shipped: 'Shipped',
  received: 'Received',
  torn_down: 'Torn Down',
  closed: 'Closed',
};

interface PurchaseStatusControlProps {
  status: PurchaseStatus;
  onAdvance: (next: PurchaseStatus) => void;
  isAdvancing: boolean;
}

/**
 * Lifecycle indicator plus a one-step-forward status-update control (Req
 * 5). Each stage renders highlighted once reached; the primary action only
 * ever offers the single next status, matching the API's one-step-forward
 * rule — there is nothing for the user to pick, since skipping or reversing
 * is never a valid choice.
 */
export function PurchaseStatusControl({ status, onAdvance, isAdvancing }: PurchaseStatusControlProps) {
  const currentIndex = STATUS_ORDER.indexOf(status);
  const next = currentIndex < STATUS_ORDER.length - 1 ? STATUS_ORDER[currentIndex + 1] : null;

  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-2 text-sm">
        {STATUS_ORDER.map((stage, index) => (
          <li key={stage} className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full border px-3 py-1',
                index <= currentIndex ? 'border-emerald-600 bg-emerald-600/10 text-emerald-700 font-medium' : 'border-border text-muted-foreground',
              )}
            >
              {STATUS_LABELS[stage]}
            </span>
            {index < STATUS_ORDER.length - 1 && <span className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>
      {next && (
        <Button onClick={() => onAdvance(next)} disabled={isAdvancing}>
          {isAdvancing ? 'Updating…' : `Mark as ${STATUS_LABELS[next]}`}
        </Button>
      )}
      {!next && <p className="text-sm text-muted-foreground">This purchase has reached its final status.</p>}
    </div>
  );
}
