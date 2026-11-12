// Mercari item-detail status value reading/mapping (Req 3/7), split out of
// mercariStatusChecker.ts purely to keep that file under this codebase's
// ~200-line-per-file convention (mirrors mercariSearchMapping.ts's own split
// off mercariConnector.ts). Nothing here talks to a browser or the network
// itself — it only reads the raw `status` string out of an already-parsed
// `__NEXT_DATA__` payload and maps it to the shared ListingLiveStatus the
// scan service understands. mercariStatusChecker.ts owns the actual page
// navigation/fetch that produces the `__NEXT_DATA__` payload this file reads.
//
// The real status value set was confirmed live during this task, not
// guessed from the search response's own `on_sale`/`trading` values alone:
// this sandbox's live Mercari access (confirmed by loading a real GPU
// category page and a real item-detail page, both HTTP 200 with a genuine
// `__NEXT_DATA__` payload) let the JS chunks a real item-detail page itself
// loads be fetched and read directly. One chunk
// (`_next/static/chunks/27334s6ruemmk.js`, served from
// `u-web-assets.mercdn.net` alongside a real item-detail page load) ships
// Mercari's own `ITEM_STATUS`/`STATUS_MAP` constants verbatim:
// `{ON_SALE:"on_sale",STOP:"stop",CANCEL:"cancel",SOLD_OUT:"sold_out",
// REMOVED_ITEM_STATUSES:["stop","cancel","admin_cancel"]}` alongside a
// numeric `STATUS_MAP` (`UNKNOWN`, `ON_SALE`, `TRADING`, `SOLD_OUT`, `STOP`,
// `CANCEL`, `ADMIN_CANCEL`). That is Mercari's own code, not a guess, and it
// draws a line this task's own mapping follows exactly: `stop`/`cancel`/
// `admin_cancel` are grouped by Mercari's own `REMOVED_ITEM_STATUSES` as
// distinct from `sold_out` — so this checker does *not* fold every
// non-`on_sale` status into `'sold'`, only the ones Mercari's own code
// doesn't call "removed".
//
//   - `on_sale` -> 'active'. Confirmed live: a real for-sale GPU item's
//     detail page (`m27546568456`) carried `status: "on_sale"`.
//   - `trading` -> 'sold'. Confirmed live against two real items pulled
//     from a live search response with `status: "trading"`
//     (`m96657608897`, `m72171980682`): both items' own detail pages
//     carried the identical `status: "trading"` plus a populated
//     `lastSoldAt` — a buyer has committed, so the listing is no longer
//     reachable for anyone else to buy, which is this project's definition
//     of `'sold'` even before Mercari's own escrow finishes.
//   - `sold_out` -> 'sold'. This is Mercari's own shipped enum value for a
//     fully completed sale (see `STATUS_MAP.SOLD_OUT` above) — read
//     straight out of Mercari's own code, not inferred — but this task
//     never observed it live on a real detail page: every in-escrow item
//     reachable from a live search this task could run still carried
//     `trading`, and a fully completed sale's item never appeared in any
//     search result (Mercari's own search appears to drop `sold_out` items
//     entirely rather than merely deprioritize them, across every keyword
//     this task tried), leaving no id to walk to its own detail page. The
//     mapping itself is unambiguous (it isn't a removed status per
//     Mercari's own code), but the specific "does the detail page's own
//     node actually surface `sold_out` the same way it surfaces `trading`"
//     question is unconfirmed — flagged here plainly rather than silently
//     presented as equally confirmed.
//   - `stop` | `cancel` | `admin_cancel` -> 'removed'. Mercari's own
//     `REMOVED_ITEM_STATUSES` grouping (confirmed live, read verbatim out
//     of Mercari's own production JS as above): the seller paused or
//     cancelled the listing, or Mercari's own moderation removed it — none
//     of these mean a sale happened, so mapping them to `'sold'` (as a
//     literal "anything other than on_sale" rule would) would be wrong.
//     Not independently confirmed against a real detail page during this
//     task — Mercari's own search API has no way to surface an already-
//     removed item id to walk to its detail page — but the value names and
//     their "removed" grouping come from Mercari's own shipped code, not a
//     guess.
//   - HTTP 404, or the page loading without the expected `__NEXT_DATA__`
//     tag/`ItemDetail:<id>` node at all -> 'removed'. Confirmed live
//     against a fabricated item id (`m00000000000`): the page itself 404s
//     and its own node is absent from `serverState` — the same pair of
//     signals a seller-deleted listing would produce.
//   - Any other status value, or any other navigation/parse failure (a
//     non-404 non-2xx response, a malformed `__NEXT_DATA__` payload),
//     throws AppError(502) rather than guessing a status — mirrors
//     ebayConnector.ts's own `checkItemStatus` convention of never silently
//     reading an unexpected failure as a mundane, successful outcome.
import { AppError } from '../error-handler.js';
import type { ListingLiveStatus } from './types.js';

// Every confirmed Mercari item-detail `status` value mapped to the
// ListingLiveStatus the scan service understands (see this file's header
// comment for the confirmed value set and its sourcing). `on_sale` maps to
// `'active'`; `trading`/`sold_out` to `'sold'` (a buyer has already claimed
// the item); `stop`/`cancel`/`admin_cancel` to `'removed'` — Mercari's own
// `REMOVED_ITEM_STATUSES` grouping, read verbatim out of Mercari's own
// shipped JS, deliberately excluding `sold_out`. Any status not listed here
// is unrecognized and `mapItemStatus` throws rather than guessing.
const LIVE_STATUS_BY_MERCARI_STATUS: Record<string, ListingLiveStatus> = {
  on_sale: 'active',
  trading: 'sold',
  sold_out: 'sold',
  stop: 'removed',
  cancel: 'removed',
  admin_cancel: 'removed',
};

/**
 * Reads one item's raw `status` string out of an already-parsed
 * `__NEXT_DATA__` payload. Mirrors mercariItemDetail.ts's `readDescription`
 * exactly — same node path (`props.pageProps.serverState["ItemDetail:<id>"]`),
 * same "undefined on any missing/wrong-shaped step, never throws" contract
 * — but reads the node's `status` field instead of its `description` field.
 * Optional chaining short-circuits to `undefined` the same way a
 * step-by-step type-guard chain would: a primitive or null/undefined value
 * at any step has no matching property, so the chain resolves to
 * `undefined` without throwing either way.
 */
export function readItemStatus(nextData: unknown, externalItemId: string): string | undefined {
  const root = nextData as
    | { props?: { pageProps?: { serverState?: Record<string, { status?: unknown } | undefined> } } }
    | null
    | undefined;
  const status = root?.props?.pageProps?.serverState?.[`ItemDetail:${externalItemId}`]?.status;
  return typeof status === 'string' ? status : undefined;
}

/**
 * Maps one confirmed Mercari item-detail `status` string to the shared
 * ListingLiveStatus the scan service understands (see this file's header
 * comment for the confirmed value set and its sourcing). Throws
 * AppError(502) for any value outside that set rather than guessing.
 */
export function mapItemStatus(status: string, externalItemId: string): ListingLiveStatus {
  const liveStatus = LIVE_STATUS_BY_MERCARI_STATUS[status];
  if (liveStatus === undefined) {
    throw new AppError(`Mercari item ${externalItemId} has unrecognized status '${status}'`, 502);
  }
  return liveStatus;
}
