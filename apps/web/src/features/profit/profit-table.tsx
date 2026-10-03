import { Link } from 'react-router-dom';
import type { PurchaseProfit } from '@pc-parts-flipper/shared';
import { cn } from '@/lib/utils';

interface ProfitTableProps {
  purchases: PurchaseProfit[];
}


/**
 * The Profit dashboard table (Req 10-11): every Purchase's status, price
 * paid, realized sale revenue, fees/shipping, net profit, and a
 * partial/final badge, each row linking through to the Purchase detail
 * screen. Distinct from purchases-table.tsx's simpler per-purchase browsing
 * row (no profit figures) — this is the aggregated rollup.
 */
export function ProfitTable({ purchases }: ProfitTableProps) {
  if (purchases.length === 0) {
    return <p className="text-sm text-muted-foreground">No purchases match the current filters.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Listing</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Progress</th>
            <th className="px-4 py-2 font-medium">Price Paid</th>
            <th className="px-4 py-2 font-medium">Sale Revenue</th>
            <th className="px-4 py-2 font-medium">Fees + Shipping</th>
            <th className="px-4 py-2 font-medium">Net Profit</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {purchases.map((purchase) => (
            <tr key={purchase.purchaseId} className="border-b border-border last:border-0">
              <td className="px-4 py-3 font-medium">{purchase.listingTitle}</td>
              <td className="px-4 py-3 capitalize">{purchase.status.replace('_', ' ')}</td>
              <td className="px-4 py-3">
                {/* Visually distinguishes a still-running Purchase (amber) from one where every Part has resolved (green) — Req 10's "visibly flagged partial/running, distinct from one where every Part has sold". */}
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                    purchase.isFinal ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800',
                  )}
                >
                  {purchase.isFinal ? 'Final' : 'Partial'}
                </span>
              </td>
              <td className="px-4 py-3">${purchase.pricePaid.toFixed(2)}</td>
              <td className="px-4 py-3">${purchase.saleRevenue.toFixed(2)}</td>
              <td className="px-4 py-3">${purchase.feesAndShipping.toFixed(2)}</td>
              <td className={cn('px-4 py-3 font-semibold', purchase.netProfit < 0 ? 'text-red-600' : 'text-emerald-700')}>
                ${purchase.netProfit.toFixed(2)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                <Link to={`/purchases/${purchase.purchaseId}`} className="text-sm font-medium underline underline-offset-4">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
