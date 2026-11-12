// Typed CRUD for the `listings` table (Req 2-5, 12, 15).
import type { DuckDBValue } from '@duckdb/node-api';
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { buildSetClause, toNumber } from '../sqlHelpers.js';
import type { Listing, ListingStatus, MarketplaceListingStatus } from '@pc-parts-flipper/shared';

/** Fields the caller supplies when creating a Listing; id/status/timestamps are server-assigned. */
export interface CreateListingInput {
  sourceId: string;
  title: string;
  description: string | null;
  listingUrl: string | null;
  askingPrice: number;
  listingDate: string;
  acquisitionFees: number;
  photoPaths: string[];
  /** Marketplace this Listing was auto-imported from by an eBay scan (Req 3); omitted/undefined defaults to null for manually-entered Listings. */
  externalSource?: string | null;
  /** The marketplace's own item id for this Listing (Req 3); omitted/undefined defaults to null for manually-entered Listings. */
  externalItemId?: string | null;
  /** Whether this listing's computer cannot be powered on or has non-functional components; omitted/undefined defaults to false. */
  nonWorking?: boolean;
}

/** Fields that may be edited on an existing Listing; omitted keys are left unchanged. */
export interface UpdateListingInput {
  title?: string;
  description?: string | null;
  listingUrl?: string | null;
  askingPrice?: number;
  listingDate?: string;
  status?: ListingStatus;
  acquisitionFees?: number;
  photoPaths?: string[];
  /** Why a `'removed'`-status Listing is gone, or null to clear it (Req 1). Only ever written by the scan pipeline's guarded transitions below, never by the public request body (listingValidation.ts has no field for this). */
  marketplaceStatus?: MarketplaceListingStatus | null;
  /** When `marketplaceStatus` was last set, or null to clear it (Req 1). Only ever written by the scan pipeline's guarded transitions below. */
  marketplaceStatusDetectedAt?: string | null;
}

/** Filter/pagination options for the Listings queue screen (Req 12, 15). */
export interface ListListingsOptions {
  status?: ListingStatus;
  sourceId?: string;
  limit?: number;
  offset?: number;
}

// Converts one raw JSON row into the camelCase Listing shape, parsing the
// JSON-encoded photo_paths column back into a string array and the DECIMAL
// string columns back into numbers.
function mapRow(row: Record<string, unknown>): Listing {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    title: row.title as string,
    description: row.description as string | null,
    listingUrl: row.listing_url as string | null,
    askingPrice: toNumber(row.asking_price as string),
    listingDate: row.listing_date as string,
    status: row.status as ListingStatus,
    acquisitionFees: toNumber(row.acquisition_fees as string),
    photoPaths: JSON.parse(row.photo_paths as string) as string[],
    externalSource: row.external_source as string | null,
    externalItemId: row.external_item_id as string | null,
    nonWorking: row.non_working as boolean,
    marketplaceStatus: row.marketplace_status as MarketplaceListingStatus | null,
    marketplaceStatusDetectedAt: row.marketplace_status_detected_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts a new Listing in status `open` and returns the row as stored. */
export async function createListing(input: CreateListingInput): Promise<Listing> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO listings
       (id, source_id, title, description, listing_url, asking_price, listing_date,
        acquisition_fees, photo_paths, external_source, external_item_id, non_working)
     VALUES
       ($id, $source_id, $title, $description, $listing_url, $asking_price, $listing_date,
        $acquisition_fees, $photo_paths, $external_source, $external_item_id, $non_working)
     RETURNING *`,
    {
      id: newId(),
      source_id: input.sourceId,
      title: input.title,
      description: input.description,
      listing_url: input.listingUrl,
      asking_price: input.askingPrice,
      listing_date: input.listingDate,
      acquisition_fees: input.acquisitionFees,
      photo_paths: JSON.stringify(input.photoPaths),
      external_source: input.externalSource ?? null,
      external_item_id: input.externalItemId ?? null,
      non_working: input.nonWorking ?? false,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches one Listing by id, or null if no such row exists. */
export async function getListingById(id: string): Promise<Listing | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM listings WHERE id = $id`, { id });
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Fetches the Listing already imported from a given Source for a given
 * external marketplace item id, or null if none exists yet. Used by the
 * eBay scan service (Req 3) to skip candidates it has already imported as
 * Listings on a prior scan of the same Source, so re-running a scan never
 * creates duplicate Listings for the same eBay item.
 */
export async function findListingByExternalId(sourceId: string, externalItemId: string): Promise<Listing | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM listings WHERE source_id = $source_id AND external_item_id = $external_item_id`,
    { source_id: sourceId, external_item_id: externalItemId },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Lists every Listing auto-imported from `externalSource` that still has no
 * photos stored locally, oldest first. Backs the one-time photo backfill
 * (apps/server/src/photos/photoBackfill.ts) for Listings imported before
 * scans downloaded marketplace images.
 *
 * Compares photo_paths against the literal `'[]'` rather than using a JSON
 * function: the column is a VARCHAR holding a JSON array (see schema.ts),
 * and both writers — createListing and updateListing — produce it with
 * JSON.stringify, whose output for an empty array is exactly `[]`, the same
 * value as the column's own DEFAULT.
 */
export async function listListingsMissingPhotos(externalSource: string): Promise<Listing[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM listings
     WHERE external_source = $external_source
       AND external_item_id IS NOT NULL
       AND photo_paths = '[]'
     ORDER BY created_at ASC, id ASC`,
    { external_source: externalSource },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/**
 * Lists every Listing auto-imported from `externalSource` that still has no
 * description stored locally, oldest first. Backs the one-time description
 * backfill (apps/server/src/scan/descriptionBackfill.ts) for Listings
 * imported before scans fetched eBay's description and item specifics.
 */
export async function listListingsMissingDescription(externalSource: string): Promise<Listing[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM listings
     WHERE external_source = $external_source
       AND external_item_id IS NOT NULL
       AND description IS NULL
     ORDER BY created_at ASC, id ASC`,
    { external_source: externalSource },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

// Shared WHERE-clause builder for listListings/countListings, so the
// pagination total always reflects the same status/Source filters as the
// page of rows it corresponds to (Req 12, 15).
function buildListingsWhere(options?: Pick<ListListingsOptions, 'status' | 'sourceId'>): {
  whereSql: string;
  params: Record<string, DuckDBValue>;
} {
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.status !== undefined) {
    conditions.push('status = $status');
    params.status = options.status;
  }
  if (options?.sourceId !== undefined) {
    conditions.push('source_id = $source_id');
    params.source_id = options.sourceId;
  }
  return { whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** Lists Listings filtered by status/Source and paginated, newest first (Req 12, 15). */
export async function listListings(options?: ListListingsOptions): Promise<Listing[]> {
  const connection = await getConnection();
  const { whereSql, params } = buildListingsWhere(options);
  const reader = await connection.runAndReadAll(
    `SELECT * FROM listings ${whereSql} ORDER BY listing_date DESC, id ASC LIMIT $limit OFFSET $offset`,
    { ...params, limit: options?.limit ?? 50, offset: options?.offset ?? 0 },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/** Counts Listings matching the same status/Source filters as listListings, so the Listings queue (Req 12) can paginate (Req 15) against an accurate total. */
export async function countListings(options?: Pick<ListListingsOptions, 'status' | 'sourceId'>): Promise<number> {
  const connection = await getConnection();
  const { whereSql, params } = buildListingsWhere(options);
  const reader = await connection.runAndReadAll(`SELECT count(*) AS total FROM listings ${whereSql}`, params);
  return Number(reader.getRowObjectsJson()[0].total);
}

/** Lists every Listing id, across all rows (not paginated), newest first — the no-filter fast path of GET /api/listings/ids for bulk identify-parts enqueueing; column-filtered id sets are built in memory by that route instead. */
export async function listListingIds(): Promise<string[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll('SELECT id FROM listings ORDER BY listing_date DESC, id ASC');
  return reader.getRowObjectsJson().map((row) => row.id as string);
}

/**
 * Atomically transitions a Listing from `open` to `status`, guarding the
 * UPDATE's WHERE clause on `status = 'open'` so that two genuinely
 * concurrent accept/reject requests against the same Listing can never both
 * win (Req 4): DuckDB reports the UPDATE's affected-row count back as a
 * `Count` column, so whichever request's UPDATE actually flips a row (Count
 * > 0) is the sole winner — the loser sees Count = 0 and must not proceed
 * (e.g. must not create a Purchase on accept). Read-then-write without this
 * guard raced two parallel accepts into creating two Purchases for one
 * Listing.
 */
export async function transitionOpenListing(id: string, status: ListingStatus): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `UPDATE listings SET status = $status WHERE id = $id AND status = 'open'`,
    { status, id },
  );
  const [{ Count: rowsAffected }] = reader.getRowObjectsJson() as Array<{ Count: string }>;
  return Number(rowsAffected) > 0;
}

/**
 * Atomically transitions a Listing from `fromStatus` to `toStatus`, setting
 * `marketplaceStatus`/`marketplaceStatusDetectedAt` in that same guarded
 * write (Req 3, 4) — the scan pipeline's per-item recheck calls this in
 * both directions: `open` -> `removed` once a direct recheck confirms a
 * Listing is genuinely gone (`marketplaceStatus` set to the recheck's
 * result, `marketplaceStatusDetectedAt` to the detection time), and
 * `removed` -> `open` when a later scan finds the same `externalItemId`
 * again (`marketplaceStatus`/`marketplaceStatusDetectedAt` both passed as
 * `null` to clear them). Uses the exact same CAS guard as
 * `transitionOpenListing` above — the UPDATE's WHERE clause is guarded on
 * `status = $fromStatus`, so a concurrent user Accept/Reject request and
 * this scan-driven transition can never both win: whichever write actually
 * flips the row (DuckDB's reported `Count` > 0) is the sole winner, the
 * loser sees `Count = 0` and must not proceed.
 */
export async function transitionListingMarketplaceStatus(
  id: string,
  fromStatus: ListingStatus,
  toStatus: ListingStatus,
  marketplaceStatus: MarketplaceListingStatus | null,
  marketplaceStatusDetectedAt: string | null,
): Promise<boolean> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `UPDATE listings SET status = $toStatus, marketplace_status = $marketplaceStatus, marketplace_status_detected_at = $marketplaceStatusDetectedAt WHERE id = $id AND status = $fromStatus`,
    { toStatus, marketplaceStatus, marketplaceStatusDetectedAt, id, fromStatus },
  );
  const [{ Count: rowsAffected }] = reader.getRowObjectsJson() as Array<{ Count: string }>;
  return Number(rowsAffected) > 0;
}

/**
 * Applies a partial edit to a Listing, including status transitions (Req 4).
 * Runs the UPDATE without `RETURNING` and re-fetches by id instead: DuckDB
 * rejects `UPDATE ... RETURNING` on a row another table's FOREIGN KEY
 * references (listings is referenced by expected_parts/purchases), even
 * when the referencing column itself is untouched.
 */
export async function updateListing(
  id: string,
  patch: UpdateListingInput,
): Promise<Listing | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    title: patch.title,
    description: patch.description,
    listing_url: patch.listingUrl,
    asking_price: patch.askingPrice,
    listing_date: patch.listingDate,
    status: patch.status,
    acquisition_fees: patch.acquisitionFees,
    photo_paths: patch.photoPaths !== undefined ? JSON.stringify(patch.photoPaths) : undefined,
    marketplace_status: patch.marketplaceStatus,
    marketplace_status_detected_at: patch.marketplaceStatusDetectedAt,
  });
  await connection.run(`UPDATE listings SET ${setSql} WHERE id = $id`, { ...params, id });
  return getListingById(id);
}
