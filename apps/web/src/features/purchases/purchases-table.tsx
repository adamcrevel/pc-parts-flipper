import { Link } from 'react-router-dom';
import type { PurchaseSummary } from '@pc-parts-flipper/shared';

interface PurchasesTableProps {
  purchases: PurchaseSummary[];
}

/**
 * The Purchases list table: every Purchase's status, linked Listing title,
 * price paid, and purchase date, each row linking through to its detail
 * screen (Req 5). Full sort/filter/net-profit aggregation (Req 10-11) is
 * T13's dashboard — this is the simpler per-purchase browsing list.
 */
export function PurchasesTable({ purchases }: PurchasesTableProps) {
  if (purchases.length === 0) {
    return <p className="text-sm text-muted-foreground">No purchases match the current filter.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-4 py-2 font-medium">Listing</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Price Paid</th>
            <th className="px-4 py-2 font-medium">Purchase Date</th>
            <th className="px-4 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {purchases.map((purchase) => (
            <tr key={purchase.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3 font-medium">{purchase.listing.title}</td>
              <td className="px-4 py-3 capitalize">{purchase.status.replace('_', ' ')}</td>
              <td className="px-4 py-3">${purchase.pricePaid.toFixed(2)}</td>
              <td className="px-4 py-3">{purchase.purchaseDate}</td>
              <td className="whitespace-nowrap px-4 py-3 text-right">
                <Link to={`/purchases/${purchase.id}`} className="text-sm font-medium underline underline-offset-4">
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
