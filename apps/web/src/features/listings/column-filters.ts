import type { ListingColumnFilters } from '@pc-parts-flipper/shared';

// The one place that knows which `ListingColumnFilters` fields exist and
// what "no filter" looks like for each — a missing/`undefined` scalar, an
// empty string, or an empty array. listings-api.ts walks this list to
// build query params, listing-list.tsx uses it to light each header's
// active indicator and to tell a filtered-to-zero table apart from a
// genuinely empty one, and listings-page.tsx uses it to show "Clear all".
// Keeping all three on this single list means a field added to the shared
// type can't be sent by one and ignored by another.

/**
 * Every `ListingColumnFilters` key, in query-param order. Built from an
 * object `satisfies Record<keyof ListingColumnFilters, true>` so adding a
 * field to the shared type without listing it here is a compile error.
 */
export const COLUMN_FILTER_KEYS = Object.keys({
  title: true,
  sourceIds: true,
  statuses: true,
  askingPriceMin: true,
  askingPriceMax: true,
  expectedResaleMin: true,
  expectedResaleMax: true,
  differenceMin: true,
  differenceMax: true,
  identifyPartsStages: true,
  pricingStatuses: true,
} satisfies Record<keyof ListingColumnFilters, true>) as (keyof ListingColumnFilters)[];

/** True when one filter field holds a real value: a non-empty array, or a defined, non-empty scalar. */
export function isColumnFilterSet(value: ListingColumnFilters[keyof ListingColumnFilters]): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== undefined && value !== '';
}

/** True when at least one of the 11 filter fields is set (Req 8's "Clear all" condition, Req 13's filtered-empty condition). */
export function hasActiveColumnFilter(filters: ListingColumnFilters): boolean {
  return COLUMN_FILTER_KEYS.some((key) => isColumnFilterSet(filters[key]));
}
