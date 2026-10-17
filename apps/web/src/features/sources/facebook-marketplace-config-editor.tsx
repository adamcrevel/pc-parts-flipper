import type { FacebookMarketplaceConnectorConfig, Source } from '@pc-parts-flipper/shared';
import { Button } from '@/components/ui/button';

// Draft (string-based, pre-coercion) state for a Facebook Marketplace
// Source's connector config. Split out of connector-config-editor.tsx
// (rather than folded into that file's shared eBay/Mercari editor) because
// Facebook Marketplace's config adds two extra optional fields —
// `location`/`radiusMiles` — on top of the queries+maxPrice shape eBay and
// Mercari share, the same split-sibling-file pattern
// apps/server/src/connectors/mercariConnector.ts/mercariItemDetail.ts uses
// to keep each file near the project's ~200-line standing check.
export interface FacebookConnectorConfigDraft {
  queries: string[];
  maxPrice: string;
  location: string;
  radiusMiles: string;
}

// Field-level errors for FacebookConnectorConfigDraft, mirroring
// apps/server/src/routes/sourceValidation.ts's
// validateFacebookMarketplaceConnectorConfig exactly: `queries` empty is a
// whole-array error, each blank query is a per-row error, and
// `maxPrice`/`radiusMiles` (if given) must each be non-negative.
// `location` carries no validation — any string, including blank, is
// accepted (a blank one normalizes to omitted at submit time).
export interface FacebookConnectorConfigFieldErrors {
  queries?: string;
  queryRows?: Array<string | undefined>;
  maxPrice?: string;
  radiusMiles?: string;
}

/** A blank draft: one empty query row (the UI never allows zero rows), no max price, no location filter. */
export function emptyFacebookConnectorConfigDraft(): FacebookConnectorConfigDraft {
  return { queries: [''], maxPrice: '', location: '', radiusMiles: '' };
}

/**
 * Builds the initial draft for SourceForm: parses `source.connectorConfig`
 * (the JSON-encoded VARCHAR column) back into a FacebookConnectorConfigDraft
 * when editing a Facebook Marketplace Source that already has one
 * configured, falling back to emptyFacebookConnectorConfigDraft() for a new
 * Source or malformed/absent stored JSON rather than throwing.
 */
export function initialFacebookConnectorConfigDraft(source?: Source): FacebookConnectorConfigDraft {
  if (!source?.connectorConfig) {
    return emptyFacebookConnectorConfigDraft();
  }
  try {
    const parsed = JSON.parse(source.connectorConfig) as FacebookMarketplaceConnectorConfig;
    return {
      queries: Array.isArray(parsed.queries) && parsed.queries.length > 0 ? parsed.queries : [''],
      maxPrice: parsed.maxPrice !== undefined ? String(parsed.maxPrice) : '',
      location: parsed.location ?? '',
      radiusMiles: parsed.radiusMiles !== undefined ? String(parsed.radiusMiles) : '',
    };
  } catch {
    return emptyFacebookConnectorConfigDraft();
  }
}

// Validates one FacebookConnectorConfigDraft client-side, mirroring the
// backend's validateFacebookMarketplaceConnectorConfig rule-for-rule
// (Requirement 7) so the inline error appears without waiting on a round
// trip: queries must be a non-empty array of non-blank strings, and
// maxPrice/radiusMiles, if given, must each be a non-negative number.
export function validateFacebookConnectorConfig(draft: FacebookConnectorConfigDraft): FacebookConnectorConfigFieldErrors {
  const errors: FacebookConnectorConfigFieldErrors = {};

  if (draft.queries.length === 0) {
    errors.queries = 'At least one search query is required.';
  } else {
    const queryRows = draft.queries.map((query) => (query.trim().length === 0 ? 'Query is required.' : undefined));
    if (queryRows.some((error) => error !== undefined)) {
      errors.queryRows = queryRows;
    }
  }

  if (draft.maxPrice.trim().length > 0) {
    const num = Number(draft.maxPrice);
    if (!Number.isFinite(num) || num < 0) {
      errors.maxPrice = 'Max price must be a non-negative number.';
    }
  }

  if (draft.radiusMiles.trim().length > 0) {
    const num = Number(draft.radiusMiles);
    if (!Number.isFinite(num) || num < 0) {
      errors.radiusMiles = 'Radius must be a non-negative number.';
    }
  }

  return errors;
}

/** Coerces a validated FacebookConnectorConfigDraft into the plain-object FacebookMarketplaceConnectorConfig the server expects. */
export function buildFacebookConnectorConfig(draft: FacebookConnectorConfigDraft): FacebookMarketplaceConnectorConfig {
  const trimmedQueries = draft.queries.map((query) => query.trim());
  const maxPrice = draft.maxPrice.trim().length > 0 ? Number(draft.maxPrice) : undefined;
  const radiusMiles = draft.radiusMiles.trim().length > 0 ? Number(draft.radiusMiles) : undefined;
  const location = draft.location.trim().length > 0 ? draft.location.trim() : undefined;
  return {
    queries: trimmedQueries,
    ...(location === undefined ? {} : { location }),
    ...(radiusMiles === undefined ? {} : { radiusMiles }),
    ...(maxPrice === undefined ? {} : { maxPrice }),
  };
}

interface FacebookConnectorConfigEditorProps {
  draft: FacebookConnectorConfigDraft;
  errors: FacebookConnectorConfigFieldErrors;
  onChange: (draft: FacebookConnectorConfigDraft) => void;
}

/**
 * Repeatable search-query editor plus optional max-price, location, and
 * search-radius fields, rendered by SourceForm only when platformType is
 * 'facebook_marketplace' (T11/Req 7) — the same query-row add/remove
 * mechanics as connector-config-editor.tsx's shared eBay/Mercari editor,
 * plus the two Facebook-only location fields Facebook Marketplace search
 * supports and eBay/Mercari (both nationwide marketplaces) have no
 * equivalent for.
 */
export function FacebookConnectorConfigEditor({ draft, errors, onChange }: FacebookConnectorConfigEditorProps) {
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
        <h3 className="text-sm font-medium">Facebook Marketplace Search Queries</h3>
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
              aria-label={`Facebook Marketplace search query ${index + 1}`}
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
        <label htmlFor="connector-location" className="text-sm font-medium">
          Location (optional)
        </label>
        <input
          id="connector-location"
          value={draft.location}
          onChange={(e) => onChange({ ...draft, location: e.target.value })}
          placeholder="City, State"
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="connector-radius-miles" className="text-sm font-medium">
          Radius (miles, optional)
        </label>
        <input
          id="connector-radius-miles"
          type="number"
          step="1"
          value={draft.radiusMiles}
          onChange={(e) => onChange({ ...draft, radiusMiles: e.target.value })}
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        {errors.radiusMiles && <p className="text-xs text-destructive">{errors.radiusMiles}</p>}
      </div>

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
