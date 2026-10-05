// Typed CRUD for the `parts` table (Req 6-7, 10).
import type { DuckDBValue } from '@duckdb/node-api';
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { buildSetClause } from '../sqlHelpers.js';
import type { ComponentCategory, Part, PartStatus } from '../types.js';

/**
 * Fields supplied when the teardown workflow generates a Part (Req 6).
 * `brand`/`partNumber` carry over from the Expected Part being reconciled,
 * or from the Additional Part row the user filled in; null when unidentified.
 */
export interface CreatePartInput {
  purchaseId: string;
  category: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
}

/** Fields that may be edited on an existing Part; omitted keys are left unchanged. */
export interface UpdatePartInput {
  status?: PartStatus;
  /** Required by the caller whenever `status` transitions to `unsellable` (Req 7). */
  unsellableReason?: string | null;
}

/** Filter/pagination options for the Parts screen (Req 7, 10, 15). */
export interface ListPartsOptions {
  status?: PartStatus;
  purchaseId?: string;
  limit?: number;
  offset?: number;
}

// Converts one raw JSON row into the camelCase Part shape.
function mapRow(row: Record<string, unknown>): Part {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    category: row.category as ComponentCategory,
    brand: (row.brand as string | null) ?? null,
    partNumber: (row.part_number as string | null) ?? null,
    description: row.description as string,
    status: row.status as PartStatus,
    unsellableReason: row.unsellable_reason as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts a new Part in status `ready_to_list` and returns the row as stored. */
export async function createPart(input: CreatePartInput): Promise<Part> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO parts (id, purchase_id, category, brand, part_number, description)
     VALUES ($id, $purchase_id, $category, $brand, $part_number, $description)
     RETURNING *`,
    {
      id: newId(),
      purchase_id: input.purchaseId,
      category: input.category,
      brand: input.brand,
      part_number: input.partNumber,
      description: input.description,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches one Part by id, or null if no such row exists. */
export async function getPartById(id: string): Promise<Part | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM parts WHERE id = $id`, { id });
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Lists Parts filtered by status and/or Purchase (Req 10). */
export async function listParts(options?: ListPartsOptions): Promise<Part[]> {
  const connection = await getConnection();
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.status !== undefined) {
    conditions.push('status = $status');
    params.status = options.status;
  }
  if (options?.purchaseId !== undefined) {
    conditions.push('purchase_id = $purchase_id');
    params.purchase_id = options.purchaseId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(
    `SELECT * FROM parts ${whereSql} ORDER BY created_at DESC`,
    params,
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/**
 * A Part row annotated with its owning Purchase id and the originating
 * Listing's title — the embedded context the Parts list/detail screens need
 * (Req 7, 10) without a second round-trip per row. Joins through
 * purchases to listings (parts has no direct listing_id column).
 */
export type PartWithPurchaseSummary = Part & { purchaseListingTitle: string };

/**
 * Lists Parts filtered/paginated the same way as listParts, joined against
 * their owning Purchase's originating Listing title. One SQL statement, not
 * a query-per-row — see db/queries/purchases.ts's
 * listPurchasesWithListingSummary doc comment for why fanning out a query
 * per row proved unreliable on DuckDB's single shared connection.
 */
export async function listPartsWithContext(options?: ListPartsOptions): Promise<PartWithPurchaseSummary[]> {
  const connection = await getConnection();
  const conditions: string[] = [];
  // Columns are qualified throughout: both `parts` and `purchases` have
  // their own `status` column, so an unqualified WHERE/SELECT would be
  // ambiguous or silently pick the wrong one.
  const params: Record<string, DuckDBValue> = {};
  if (options?.status !== undefined) {
    conditions.push('pt.status = $status');
    params.status = options.status;
  }
  if (options?.purchaseId !== undefined) {
    conditions.push('pt.purchase_id = $purchase_id');
    params.purchase_id = options.purchaseId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(
    `SELECT pt.id, pt.purchase_id, pt.category, pt.brand, pt.part_number, pt.description, pt.status, pt.unsellable_reason, pt.created_at, pt.updated_at,
            l.title AS purchase_listing_title
     FROM parts pt
     JOIN purchases p ON p.id = pt.purchase_id
     JOIN listings l ON l.id = p.listing_id
     ${whereSql}
     ORDER BY pt.created_at DESC, pt.id ASC
     LIMIT $limit OFFSET $offset`,
    {
      ...params,
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
    },
  );
  return reader.getRowObjectsJson().map((row) => ({
    ...mapRow(row),
    purchaseListingTitle: row.purchase_listing_title as string,
  }));
}

/** Counts Parts matching the same status/Purchase filter as listPartsWithContext, so the Parts list (Req 7, 15) can paginate against an accurate total. */
export async function countParts(options?: Pick<ListPartsOptions, 'status' | 'purchaseId'>): Promise<number> {
  const connection = await getConnection();
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.status !== undefined) {
    conditions.push('status = $status');
    params.status = options.status;
  }
  if (options?.purchaseId !== undefined) {
    conditions.push('purchase_id = $purchase_id');
    params.purchase_id = options.purchaseId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(`SELECT count(*) AS total FROM parts ${whereSql}`, params);
  return Number(reader.getRowObjectsJson()[0].total);
}

/**
 * Applies a partial edit to a Part, including status transitions (Req 7).
 * Runs the UPDATE without `RETURNING` and re-fetches by id instead: DuckDB
 * rejects `UPDATE ... RETURNING` on a row another table's FOREIGN KEY
 * references (parts is referenced by sale_listings/sales).
 */
export async function updatePart(id: string, patch: UpdatePartInput): Promise<Part | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    status: patch.status,
    unsellable_reason: patch.unsellableReason,
  });
  await connection.run(`UPDATE parts SET ${setSql} WHERE id = $id`, { ...params, id });
  return getPartById(id);
}

/**
 * Fetches one Part by id joined against its owning Purchase's originating
 * Listing title, or null if no such Part exists — the single-row version
 * of listPartsWithContext's join, used by the detail GET and by the status
 * PATCH's response (Req 7).
 */
export async function getPartWithContextById(id: string): Promise<PartWithPurchaseSummary | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT pt.id, pt.purchase_id, pt.category, pt.brand, pt.part_number, pt.description, pt.status, pt.unsellable_reason, pt.created_at, pt.updated_at,
            l.title AS purchase_listing_title
     FROM parts pt
     JOIN purchases p ON p.id = pt.purchase_id
     JOIN listings l ON l.id = p.listing_id
     WHERE pt.id = $id`,
    { id },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? { ...mapRow(rows[0]), purchaseListingTitle: rows[0].purchase_listing_title as string } : null;
}
