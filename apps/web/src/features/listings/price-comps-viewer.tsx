import { useState } from 'react';
import type { ComponentCategory, GetPriceCompsResponse, PriceComp } from '@pc-parts-flipper/shared';
import { ChevronDown } from 'lucide-react';
import { fetchPriceComps } from '@/features/listings/listings-api';
import { cn } from '@/lib/utils';

interface PriceCompsViewerProps {
  category: ComponentCategory | '';
  brand: string;
  partNumber: string;
}

/** Renders a comp's `priceUsd` as `$123.45`, or the "price unknown" fallback when the model found no clean price for it. */
function formatCompPrice(priceUsd: number | null): string {
  return priceUsd === null ? 'price unknown' : `$${priceUsd.toFixed(2)}`;
}

/** One comp row: title (linked out to the source), price, condition (if present), a Sold/Listed tag (if the model could tell which), and an Archived tag when the link was confirmed dead and swapped for a Wayback Machine snapshot. */
function PriceCompRow({ comp }: { comp: PriceComp }) {
  return (
    <a
      href={comp.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm hover:bg-accent"
    >
      <span className="min-w-0 flex-1 truncate underline decoration-muted-foreground/40 underline-offset-2">{comp.title}</span>
      <span className={cn('shrink-0', comp.priceUsd === null ? 'text-xs italic text-muted-foreground' : 'font-medium')}>{formatCompPrice(comp.priceUsd)}</span>
      {comp.condition !== null && <span className="shrink-0 text-xs text-muted-foreground">{comp.condition}</span>}
      {comp.saleType !== null && (
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium',
            comp.saleType === 'sold' ? 'border-teal-600/40 bg-teal-600/10 text-teal-700' : 'border-border bg-muted text-muted-foreground',
          )}
        >
          {comp.saleType === 'sold' ? 'Sold' : 'Listed'}
        </span>
      )}
      {comp.linkStatus === 'archived' && (
        <span className={cn('inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium', 'border-amber-600/40 bg-amber-600/10 text-amber-700')}>
          Archived
        </span>
      )}
    </a>
  );
}

/**
 * The expanded panel body: a loading line while in flight, the fetch's
 * error message if it failed, the comp list if any came back, or the plain
 * "No comps recorded for this part yet." empty-state line (Req 5) — never
 * an error for a genuinely empty `comps` array, only for a failed fetch.
 * Early-returns on each state in turn instead of chaining `&&` conditions,
 * which is what keeps this (and PriceCompsViewer below) under the
 * complexity cap despite covering four distinct states.
 */
function PriceCompsPanel({ loading, error, response }: { loading: boolean; error: string | null; response: GetPriceCompsResponse | null }) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading comps…</p>;
  if (error !== null) return <p className="text-sm text-destructive">{error}</p>;
  if (response === null) return null;
  if (response.comps.length === 0) return <p className="text-sm text-muted-foreground">No comps recorded for this part yet.</p>;
  return (
    <>
      {response.comps.map((comp, index) => (
        <PriceCompRow key={index} comp={comp} />
      ))}
    </>
  );
}

/**
 * "View comps" toggle for one Expected Parts row (T4), rendered next to the
 * row's estimatedResaleValue input. Collapsed by default so an unopened row
 * costs nothing; on first expand, fetches GET /api/price-comps for this
 * exact (category, brand, partNumber) combo via `fetchPriceComps` and
 * caches the result in state so re-collapsing/re-expanding never
 * re-fetches. The toggle is a `role="button"` span rather than a real
 * `<button>`: it renders inside expected-parts-editor.tsx's row trigger,
 * which Radix's CollapsibleTrigger already renders as a `<button>`, and a
 * real `<button>` nested inside another is invalid HTML that browsers
 * silently mis-parse.
 */
export function PriceCompsViewer({ category, brand, partNumber }: PriceCompsViewerProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<GetPriceCompsResponse | null>(null);

  // Fetches on the first expand only — toggling closed and back open with
  // `response` already set must not re-hit the network.
  function handleToggle() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (!nextExpanded || response !== null || loading) return;
    if (category === '') return;

    setLoading(true);
    setError(null);
    fetchPriceComps(category, brand, partNumber)
      .then((result) => setResponse(result))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load comps'))
      .finally(() => setLoading(false));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggle();
          }
        }}
        className="inline-flex cursor-pointer items-center gap-1 self-start rounded-full border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-expanded={expanded}
      >
        <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform duration-200', expanded ? 'rotate-0' : '-rotate-90')} aria-hidden="true" />
        View comps
      </span>

      {expanded && (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-2">
          <PriceCompsPanel loading={loading} error={error} response={response} />
        </div>
      )}
    </div>
  );
}
