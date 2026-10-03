// Typed CRUD for the `sales` table (Req 9-10).
import type { DuckDBValue } from '@duckdb/node-api';
import { listValue } from '@duckdb/node-api';
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { toNumber } from '../sqlHelpers.js';
import type { Sale } from '../types.js';

/** Fields supplied when recording the final sale outcome of a listed Part (Req 9). */
export interface CreateSaleInput {
  partId: string;
  soldPrice: number;
  soldDate: string;
  platformFee: number;
  shippingCost: number;
  buyerNote: string | null;
}

/**
 * Filter/pagination options for Sales reads. `partIds` (plural) is the
 * per-Purchase profit rollup join point (Req 10) and returns every matching
 * row unpaginated; `partId` (singular) is the GET /api/sales list filter
 * (Req 9, 15) and is paginated via `limit`/`offset`, defaulting to a single
 * page of 20 the same way listSaleListings does.
 */
export interface ListSalesOptions {
  partId?: string;
  partIds?: string[];
  limit?: number;
  offset?: number;
}

// Converts one raw JSON row into the camelCase Sale shape.
function mapRow(row: Record<string, unknown>): Sale {
  return {
    id: row.id as string,
    partId: row.part_id as string,
    soldPrice: toNumber(row.sold_price as string),
    soldDate: row.sold_date as string,
    platformFee: toNumber(row.platform_fee as string),
    shippingCost: toNumber(row.shipping_cost as string),
    buyerNote: row.buyer_note as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Inserts the Sale record for a Part and returns the row as stored. Does
 * NOT move the Part's status to 'sold' itself — matching this codebase's
 * existing multi-table write pattern (e.g. teardown.ts's createTeardownResult
 * + createPart), orchestration of the paired Part status transition is the
 * caller's job. routes/sales.ts's POST /api/parts/:partId/sale is the only
 * caller and always pairs this with an updatePart(... status: 'sold') call
 * in the same request; the `sales(part_id)` UNIQUE constraint still ensures
 * at most one Sale row per Part even if a caller forgets.
 */
export async function createSale(input: CreateSaleInput): Promise<Sale> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO sales (id, part_id, sold_price, sold_date, platform_fee, shipping_cost, buyer_note)
     VALUES ($id, $part_id, $sold_price, $sold_date, $platform_fee, $shipping_cost, $buyer_note)
     RETURNING *`,
    {
      id: newId(),
      part_id: input.partId,
      sold_price: input.soldPrice,
      sold_date: input.soldDate,
      platform_fee: input.platformFee,
      shipping_cost: input.shippingCost,
      buyer_note: input.buyerNote,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches the Sale recorded for a Part, or null if it hasn't sold yet. */
export async function getSaleByPartId(partId: string): Promise<Sale | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM sales WHERE part_id = $part_id`,
    { part_id: partId },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Lists Sales, optionally restricted to a set of Part ids (Req 10's
 * profit-rollup join point, returned unpaginated) or filtered to a single
 * `partId` and paginated (the GET /api/sales list, Req 9, 15).
 */
export async function listSales(options?: ListSalesOptions): Promise<Sale[]> {
  const connection = await getConnection();
  if (options?.partIds !== undefined) {
    if (options.partIds.length === 0) return [];
    const reader = await connection.runAndReadAll(
      `SELECT * FROM sales WHERE part_id IN (SELECT UNNEST($part_ids)) ORDER BY sold_date DESC`,
      { part_ids: listValue(options.partIds) },
    );
    return reader.getRowObjectsJson().map(mapRow);
  }
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.partId !== undefined) {
    conditions.push('part_id = $part_id');
    params.part_id = options.partId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(
    `SELECT * FROM sales ${whereSql} ORDER BY sold_date DESC, id ASC LIMIT $limit OFFSET $offset`,
    { ...params, limit: options?.limit ?? 20, offset: options?.offset ?? 0 },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/** Counts Sales matching the same partId filter as listSales, so the Sales list (Req 9, 15) can paginate against an accurate total. */
export async function countSales(options?: Pick<ListSalesOptions, 'partId'>): Promise<number> {
  const connection = await getConnection();
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.partId !== undefined) {
    conditions.push('part_id = $part_id');
    params.part_id = options.partId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(`SELECT count(*) AS total FROM sales ${whereSql}`, params);
  return Number(reader.getRowObjectsJson()[0].total);
}

/** Fetches one Sale by id, or null if no such row exists. */
export async function getSaleById(id: string): Promise<Sale | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM sales WHERE id = $id`, { id });
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}
