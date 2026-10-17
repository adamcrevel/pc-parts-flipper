import type { EbayConnectorConfig, MercariConnectorConfig, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';

// Draft (string-based, pre-coercion) state for an eBay or Mercari Source's
// connector config, kept as strings while editing — matching
// ExpectedPartsEditor's own string-state-until-submit convention — so a
// blank/invalid entry can be rendered and validated before being coerced
// into EbayConnectorConfig/MercariConnectorConfig. The two platforms share
// this exact shape (queries + optional maxPrice, T11/Req 7), so one draft
// type and one editor component below serve both — only the heading label
// passed in by the caller differs.
export interface ConnectorConfigDraft {
  queries: string[];
  maxPrice: string;
}

// Field-level errors for ConnectorConfigDraft, mirroring
// apps/server/src/routes/sourceValidation.ts's validateEbayConnectorConfig/
// validateMercariConnectorConfig exactly (both rule-for-rule identical):
// `queries` empty is a whole-array error, each blank query is a per-row
// error, and `maxPrice` (if given) must be non-negative.
export interface ConnectorConfigFieldErrors {
  queries?: string;
  queryRows?: Array<string | undefined>;
  maxPrice?: string;
}

/** A blank draft: one empty query row (the UI never allows zero rows) and no max price. */
export function emptyConnectorConfigDraft(): ConnectorConfigDraft {
  return { queries: [''], maxPrice: '' };
}

/**
 * Builds the initial draft for SourceForm: parses `source.connectorConfig`
 * (the JSON-encoded VARCHAR column) back into a ConnectorConfigDraft when
 * editing an eBay or Mercari Source that already has one configured,
 * falling back to emptyConnectorConfigDraft() for a new Source or
 * malformed/absent stored JSON rather than throwing.
 */
export function initialConnectorConfigDraft(source?: Source): ConnectorConfigDraft {
  if (!source?.connectorConfig) {
    return emptyConnectorConfigDraft();
  }
  try {
    const parsed = JSON.parse(source.connectorConfig) as EbayConnectorConfig | MercariConnectorConfig;
    return {
      queries: Array.isArray(parsed.queries) && parsed.queries.length > 0 ? parsed.queries : [''],
      maxPrice: parsed.maxPrice !== undefined ? String(parsed.maxPrice) : '',
    };
  } catch {
    return emptyConnectorConfigDraft();
  }
}

// Validates one ConnectorConfigDraft client-side, mirroring the backend's
// validateEbayConnectorConfig/validateMercariConnectorConfig rule-for-rule
// (Requirement 1/7) so the inline error appears without waiting on a round
// trip: queries must be a non-empty array of non-blank strings, and
// maxPrice, if given, must be a non-negative number.
export function validateConnectorConfig(queries: string[], maxPrice: string): ConnectorConfigFieldErrors {
  const errors: ConnectorConfigFieldErrors = {};

  if (queries.length === 0) {
    errors.queries = 'At least one search query is required.';
  } else {
    const queryRows = queries.map((query) => (query.trim().length === 0 ? 'Query is required.' : undefined));
    if (queryRows.some((error) => error !== undefined)) {
      errors.queryRows = queryRows;
    }
  }

  if (maxPrice.trim().length > 0) {
    const num = Number(maxPrice);
    if (!Number.isFinite(num) || num < 0) {
      errors.maxPrice = 'Max price must be a non-negative number.';
    }
  }

  return errors;
}

/**
 * Coerces a validated ConnectorConfigDraft into the plain-object
 * EbayConnectorConfig/MercariConnectorConfig the server expects — the two
 * types are structurally identical, so one coercion function serves both;
 * the caller (source-form.tsx) assigns the result to whichever of the two
 * matches the Source's own platformType.
 */
export function buildQueriesConnectorConfig(queries: string[], maxPrice: string): EbayConnectorConfig | MercariConnectorConfig {
  const trimmedQueries = queries.map((query) => query.trim());
  const maxPriceNum = maxPrice.trim().length > 0 ? Number(maxPrice) : undefined;
  return maxPriceNum === undefined ? { queries: trimmedQueries } : { queries: trimmedQueries, maxPrice: maxPriceNum };
}

interface ConnectorConfigEditorProps {
  draft: ConnectorConfigDraft;
  errors: ConnectorConfigFieldErrors;
  onChange: (draft: ConnectorConfigDraft) => void;
  // "eBay" or "Mercari" — only the heading text and the per-row aria-label
  // differ between the two platforms this editor serves; everything else
  // (add/remove query rows, max price field, validation) is identical.
  platformLabel: string;
}

/**
 * Repeatable search-query editor plus an optional max-price ceiling,
 * rendered by SourceForm for platformType 'ebay' or 'mercari' (identical
 * config shape, T11). Split out of source-form.tsx (like ExpectedPartsEditor
 * is split out of listing-form.tsx) to keep that file under the ~200-line
 * standing check and because this row-editing logic is self-contained.
 */
export function ConnectorConfigEditor({ draft, errors, onChange, platformLabel }: ConnectorConfigEditorProps) {
  function updateQuery(index: number, value: string) {
    onChange({ ...draft, queries: draft.queries.map((query, i) => (i === index ? value : query)) });
  }

  function addQuery() {
    onChange({ ...draft, queries: [...draft.queries, ''] });
  }

  function removeQuery(index: number) {
    onChange({ ...draft, queries: draft.queries.filter((_, i) => i !== index) });
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{platformLabel} Search Queries</h3>
        <Button type="button" variant="outline" size="sm" onClick={addQuery}>
          Add Query
        </Button>
      </div>
      {errors.queries && <p className="text-xs text-destructive">{errors.queries}</p>}

      {draft.queries.map((query, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="flex-1 space-y-1">
            <input
              value={query}
              onChange={(e) => updateQuery(index, e.target.value)}
              placeholder="Search query"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              aria-label={`${platformLabel} search query ${index + 1}`}
            />
            {errors.queryRows?.[index] && <p className="text-xs text-destructive">{errors.queryRows[index]}</p>}
          </div>
          {/* The UI never lets the list drop to zero rows — Remove is hidden on the last one. */}
          {draft.queries.length > 1 && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => removeQuery(index)}>
              Remove
            </Button>
          )}
        </div>
      ))}

      <div className="space-y-1">
        <label htmlFor="connector-max-price" className="text-sm font-medium">
          Max Price (optional)
        </label>
        <input
          id="connector-max-price"
          type="number"
          step="0.01"
          value={draft.maxPrice}
          onChange={(e) => onChange({ ...draft, maxPrice: e.target.value })}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {errors.maxPrice && <p className="text-xs text-destructive">{errors.maxPrice}</p>}
      </div>
    </div>
  );
}
