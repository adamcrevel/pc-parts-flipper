// Checks whether each AI-found price comp's `url` is still reachable
// (pricing-comps feature T7), so a comp pointing at a dead listing can be
// swapped for an archived snapshot — or, failing that, dropped — instead of
// sending the user to a 404. Pure: takes comps in, returns comps out, with
// no DB or job-pipeline awareness of its own (that wiring is T8's job).
import type { PriceComp } from '@pc-parts-flipper/shared';
import { logger } from '../logger.js';

// A realistic desktop browser UA — some marketplaces block or redirect
// requests carrying an obviously-automated UA (e.g. Node's default
// `undici`), which would misreport a perfectly live listing as blocked.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// A wedged comp URL (or a Wayback Machine lookup that never resolves) must
// not pin verification open indefinitely — 8s matches the task's spec and
// is generous for a single GET against a marketplace listing page.
const LINK_CHECK_TIMEOUT_MS = 8_000;

// A confirmed-dead response: the comp's own URL answered cleanly (not a
// timeout, not a network error) but with a status that means the listing is
// actually gone, not merely blocked or erroring. Only these two trigger a
// Wayback Machine lookup — anything else (a block, a server error, a
// timeout) is too ambiguous to conclude the link is dead.
const CONFIRMED_DEAD_STATUSES: readonly number[] = [404, 410];

// Test seam, mirroring ompSourcingRunner.ts's override/getter pair exactly:
// the automated suite must never make a real HTTP request (no network, no
// archive.org dependency), so it installs a fake fetch here instead. Used
// for every HTTP call this module makes — both the comp URL check and the
// Wayback Machine lookup.
let fetchOverride: typeof fetch | null = null;

/** Installs a fake `fetch` (or clears it, with null) for every HTTP call this module makes. Test-only. */
export function setLinkCheckFetchOverride(override: typeof fetch | null): void {
  fetchOverride = override;
}

/** The fetch implementation this module actually calls: the override when one is installed, otherwise the real global `fetch`. */
function getFetch(): typeof fetch {
  return fetchOverride ?? fetch;
}

// Shape of the one archive.org field this module reads. The real response
// carries more, but only `archived_snapshots.closest` (availability + URL)
// matters here.
interface WaybackAvailabilityResponse {
  archived_snapshots?: {
    closest?: {
      available?: boolean;
      url?: string;
    };
  };
}

// Looks up the closest archived snapshot of `url` via archive.org's
// Wayback Availability API. Returns the snapshot URL when one exists, or
// null when there isn't one (or the lookup itself failed/returned something
// unparseable) — the caller treats both the same way, by dropping the comp.
async function findWaybackSnapshot(url: string): Promise<string | null> {
  const lookupUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const response = await getFetch()(lookupUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as WaybackAvailabilityResponse;
  const closest = body.archived_snapshots?.closest;
  if (closest?.available === true && typeof closest.url === 'string' && closest.url !== '') {
    return closest.url;
  }
  return null;
}

// Checks one comp's `url` and resolves to its outcome: unchanged-and-live,
// swapped-for-an-archived-snapshot, dropped (confirmed dead with no
// snapshot available, whether that's because the Wayback lookup resolved
// with none or because it threw), or unchanged-and-inconclusive. Never
// throws itself — any failure before reaching the confirmed-dead branch
// propagates to verifyAndResolveComps' per-comp try/catch below, which is
// the second half of that guarantee.
async function checkComp(comp: PriceComp): Promise<PriceComp | null> {
  const response = await getFetch()(comp.url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(LINK_CHECK_TIMEOUT_MS),
  });

  if (response.ok || (response.status >= 300 && response.status < 400)) {
    return { ...comp, linkStatus: 'live' };
  }

  if (CONFIRMED_DEAD_STATUSES.includes(response.status)) {
    // A throw here (network error, DNS failure, etc. reaching archive.org)
    // means exactly the same thing as the lookup resolving with no
    // snapshot: there's no usable archived copy, so the comp is dropped —
    // not left inconclusive. Scoped locally so it doesn't fall through to
    // the outer per-comp catch below, which is for failures elsewhere.
    let snapshotUrl: string | null;
    try {
      snapshotUrl = await findWaybackSnapshot(comp.url);
    } catch {
      return null;
    }
    if (snapshotUrl === null) {
      return null;
    }
    return { ...comp, url: snapshotUrl, linkStatus: 'archived' };
  }

  // A blocking status (403/429/5xx) or any other non-2xx/3xx/404/410
  // response doesn't prove the listing is actually gone — leave it as-is.
  return { ...comp, linkStatus: null };
}

/**
 * Checks every comp's `url` for liveness in parallel and returns the
 * resolved list: a comp whose link still answers comes back marked 'live';
 * a confirmed-dead comp (404/410) with an available Wayback Machine
 * snapshot comes back with its `url` swapped for that snapshot and marked
 * 'archived'; a confirmed-dead comp with no snapshot available is dropped
 * from the result entirely; and anything inconclusive — a timeout, a
 * network error, a blocking status, or any other ambiguous response —
 * comes back completely unchanged except `linkStatus: null`. Each comp's
 * check runs in its own try/catch, so an unexpected failure for one comp
 * (anything before the Wayback lookup — a timeout, a network error, a
 * blocking status check) can never affect the Promise.all or any sibling
 * comp's own outcome; the Wayback lookup throwing during an already-
 * confirmed-dead check is handled locally inside checkComp instead, since
 * it means the same thing as the lookup finding no snapshot.
 */
export async function verifyAndResolveComps(comps: PriceComp[]): Promise<PriceComp[]> {
  const results = await Promise.all(
    comps.map(async (comp): Promise<PriceComp | null> => {
      try {
        return await checkComp(comp);
      } catch (error) {
        logger.warn({ url: comp.url, error }, 'Price comp link check failed unexpectedly; leaving it unverified');
        return { ...comp, linkStatus: null };
      }
    }),
  );
  return results.filter((comp): comp is PriceComp => comp !== null);
}
