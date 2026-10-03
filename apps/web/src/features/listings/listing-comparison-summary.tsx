interface ListingComparisonSummaryProps {
  totalExpectedResaleValue: number;
  totalCost: number;
  difference: number;
  // Req 10: count of Expected Parts currently on the Listing (editable
  // rows pre-save, or the saved ListingDetail's array once loaded). Zero
  // means the $ comparison below is comparing a sum of nothing against
  // the asking price, which is misleading rather than informative, so a
  // warning replaces it instead — applies to every Listing with no
  // Expected Parts yet, not only scan-created ones.
  expectedPartsCount: number;
}

/**
 * The Req 3 live comparison display: sum of Expected Parts' estimated
 * resale values vs. (asking price + acquisition fees), plus the resulting
 * projected profit/loss. Split out of listing-form.tsx purely to keep that
 * component's own cyclomatic complexity (one of the things feature-reviewer
 * checks) low — the two ternaries below live here instead.
 */
export function ListingComparisonSummary({
  totalExpectedResaleValue,
  totalCost,
  difference,
  expectedPartsCount,
}: ListingComparisonSummaryProps) {
  if (expectedPartsCount === 0) {
    return (
      <div role="alert" className="rounded-md border border-amber-600/50 bg-amber-600/10 p-3 text-sm text-amber-800">
        No Expected Parts recorded yet — add them before accepting
      </div>
    );
  }

  const isProfit = difference >= 0;
  return (
    <div className="rounded-md border border-border bg-muted/50 p-3 text-sm">
      <p>
        Expected resale total: <span className="font-medium">${totalExpectedResaleValue.toFixed(2)}</span> vs. cost (asking + fees):{' '}
        <span className="font-medium">${totalCost.toFixed(2)}</span>
      </p>
      <p className={isProfit ? 'font-medium text-emerald-600' : 'font-medium text-destructive'}>
        {isProfit ? 'Projected profit' : 'Projected loss'}: ${Math.abs(difference).toFixed(2)}
      </p>
    </div>
  );
}
