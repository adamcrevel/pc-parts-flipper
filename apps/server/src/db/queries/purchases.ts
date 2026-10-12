// Typed CRUD for the `purchases` table (Req 4-5, 10-11, 15).
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { buildSetClause, toNumber } from '../sqlHelpers.js';
import type { Purchase, PurchaseStatus } from '@pc-parts-flipper/shared';

/** Fields supplied when a Purchase is created (typically pre-filled from accepting a Listing, Req 4). */
export interface CreatePurchaseInput {
  listingId: string;
  pricePaid: number;
  purchaseDate: string;
}

/** Fields that may be edited on an existing Purchase; omitted keys are left unchanged. */
export interface UpdatePurchaseInput {
  status?: PurchaseStatus;
  pricePaid?: number;
  purchaseDate?: string;
}

/** Filter/pagination options for the Purchases dashboard (Req 11, 15). */
export interface ListPurchasesOptions {
  status?: PurchaseStatus;
  limit?: number;
  offset?: number;
}

// Converts one raw JSON row into the camelCase Purchase shape.
function mapRow(row: Record<string, unknown>): Purchase {
  return {
    id: row.id as string,
    listingId: row.listing_id as string,
    status: row.status as PurchaseStatus,
    pricePaid: toNumber(row.price_paid as string),
    purchaseDate: row.purchase_date as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts a new Purchase in status `ordered` and returns the row as stored. */
export async function createPurchase(input: CreatePurchaseInput): Promise<Purchase> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO purchases (id, listing_id, price_paid, purchase_date)
     VALUES ($id, $listing_id, $price_paid, $purchase_date)
     RETURNING *`,
    {
      id: newId(),
      listing_id: input.listingId,
      price_paid: input.pricePaid,
      purchase_date: input.purchaseDate,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches one Purchase by id, or null if no such row exists. */
export async function getPurchaseById(id: string): Promise<Purchase | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM purchases WHERE id = $id`, { id });
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Lists Purchases filtered by status and paginated, newest first (Req 11, 15). */
export async function listPurchases(options?: ListPurchasesOptions): Promise<Purchase[]> {
  const connection = await getConnection();
  const whereSql = options?.status !== undefined ? 'WHERE status = $status' : '';
  const reader = await connection.runAndReadAll(
    `SELECT * FROM purchases ${whereSql} ORDER BY purchase_date DESC, id ASC LIMIT $limit OFFSET $offset`,
    {
      ...(options?.status !== undefined ? { status: options.status } : {}),
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/** Counts Purchases matching the same status filter as listPurchases, so the Purchases list (Req 5) can paginate (Req 15) against an accurate total. */
export async function countPurchases(options?: Pick<ListPurchasesOptions, 'status'>): Promise<number> {
  const connection = await getConnection();
  const whereSql = options?.status !== undefined ? 'WHERE status = $status' : '';
  const reader = await connection.runAndReadAll(
    `SELECT count(*) AS total FROM purchases ${whereSql}`,
    options?.status !== undefined ? { status: options.status } : {},
  );
  return Number(reader.getRowObjectsJson()[0].total);
}

/**
 * A Purchase row annotated with its originating Listing's title and
 * Expected Parts count — the embedded context the Purchases list screen (and
 * T9/T13) need without a second round-trip per row (Req 5).
 */
export type PurchaseWithListingSummary = Purchase & { listingTitle: string; expectedPartsCount: number };

/**
 * Lists Purchases joined against their Listing's title and Expected Parts
 * count in one query, filtered by status and paginated, newest first (Req
 * 5, 15). Deliberately a single JOIN rather than one extra query per row:
 * DuckDB's single shared connection (see db/client.ts) does not safely
 * execute many concurrent statements, so fanning out N per-row lookups via
 * `Promise.all` over a page of Purchases intermittently threw "Failed to
 * execute prepared statement" once there were more than a couple of rows.
 */
export async function listPurchasesWithListingSummary(options?: ListPurchasesOptions): Promise<PurchaseWithListingSummary[]> {
  const connection = await getConnection();
  // Columns are qualified throughout: both `purchases` and `listings` have
  // their own `status` column, so an unqualified WHERE/SELECT would be
  // ambiguous or silently pick the wrong one.
  const whereSql = options?.status !== undefined ? 'WHERE p.status = $status' : '';
  const reader = await connection.runAndReadAll(
    `SELECT p.id, p.listing_id, p.status, p.price_paid, p.purchase_date, p.created_at, p.updated_at,
            l.title AS listing_title,
            (SELECT count(*) FROM expected_parts ep WHERE ep.listing_id = l.id) AS expected_parts_count
     FROM purchases p
     JOIN listings l ON l.id = p.listing_id
     ${whereSql}
     ORDER BY p.purchase_date DESC, p.id ASC
     LIMIT $limit OFFSET $offset`,
    {
      ...(options?.status !== undefined ? { status: options.status } : {}),
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    },
  );
  return reader.getRowObjectsJson().map((row) => ({
    ...mapRow(row),
    listingTitle: row.listing_title as string,
    expectedPartsCount: Number(row.expected_parts_count),
  }));
}

/**
 * Applies a partial edit to a Purchase, including lifecycle status
 * transitions (Req 5). Runs the UPDATE without `RETURNING` and re-fetches by
 * id instead: DuckDB rejects `UPDATE ... RETURNING` on a row another
 * table's FOREIGN KEY references (purchases is referenced by
 * teardown_results/parts).
 */
export async function updatePurchase(
  id: string,
  patch: UpdatePurchaseInput,
): Promise<Purchase | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    status: patch.status,
    price_paid: patch.pricePaid,
    purchase_date: patch.purchaseDate,
  });
  await connection.run(`UPDATE purchases SET ${setSql} WHERE id = $id`, { ...params, id });
  return getPurchaseById(id);
}
