// Typed CRUD for the `sale_listings` table (Req 8).
import type { DuckDBValue } from '@duckdb/node-api';
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { buildSetClause, toNumber } from '../sqlHelpers.js';
import type { PlatformType, SaleListing } from '../types.js';

/** Fields supplied when drafting a Sale Listing for a ready_to_list Part (Req 8). */
export interface CreateSaleListingInput {
  partId: string;
  platform: PlatformType;
  title: string;
  description: string | null;
  askingPrice: number;
}

/** Fields that may be edited on an existing Sale Listing; omitted keys are left unchanged. */
export interface UpdateSaleListingInput {
  platform?: PlatformType;
  title?: string;
  description?: string | null;
  askingPrice?: number;
  /** Set to mark the draft as posted (moves the owning Part to `listed`); Req 8. */
  listedAt?: string;
}

/** Filter/pagination options for the Sale Listings screen (Req 8, 15). */
export interface ListSaleListingsOptions {
  partId?: string;
  limit?: number;
  offset?: number;
}

// Converts one raw JSON row into the camelCase SaleListing shape.
function mapRow(row: Record<string, unknown>): SaleListing {
  return {
    id: row.id as string,
    partId: row.part_id as string,
    platform: row.platform as PlatformType,
    title: row.title as string,
    description: row.description as string | null,
    askingPrice: toNumber(row.asking_price as string),
    listedAt: row.listed_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts a new draft Sale Listing (unposted: `listedAt` is null) and returns the row as stored. */
export async function createSaleListing(input: CreateSaleListingInput): Promise<SaleListing> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO sale_listings (id, part_id, platform, title, description, asking_price)
     VALUES ($id, $part_id, $platform, $title, $description, $asking_price)
     RETURNING *`,
    {
      id: newId(),
      part_id: input.partId,
      platform: input.platform,
      title: input.title,
      description: input.description,
      asking_price: input.askingPrice,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches one Sale Listing by id, or null if no such row exists. */
export async function getSaleListingById(id: string): Promise<SaleListing | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM sale_listings WHERE id = $id`,
    { id },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Lists every Sale Listing drafted for a Part (usually one, but history is preserved). */
export async function listSaleListingsByPart(partId: string): Promise<SaleListing[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM sale_listings WHERE part_id = $part_id ORDER BY created_at DESC`,
    { part_id: partId },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/** Lists Sale Listings across every Part, optionally filtered by partId, paginated (Req 8, 15). */
export async function listSaleListings(options?: ListSaleListingsOptions): Promise<SaleListing[]> {
  const connection = await getConnection();
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.partId !== undefined) {
    conditions.push('part_id = $part_id');
    params.part_id = options.partId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(
    `SELECT * FROM sale_listings ${whereSql} ORDER BY created_at DESC, id ASC LIMIT $limit OFFSET $offset`,
    { ...params, limit: options?.limit ?? 20, offset: options?.offset ?? 0 },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/** Counts Sale Listings matching the same partId filter as listSaleListings, so the Sale Listings list (Req 8, 15) can paginate against an accurate total. */
export async function countSaleListings(options?: Pick<ListSaleListingsOptions, 'partId'>): Promise<number> {
  const connection = await getConnection();
  const conditions: string[] = [];
  const params: Record<string, DuckDBValue> = {};
  if (options?.partId !== undefined) {
    conditions.push('part_id = $part_id');
    params.part_id = options.partId;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const reader = await connection.runAndReadAll(`SELECT count(*) AS total FROM sale_listings ${whereSql}`, params);
  return Number(reader.getRowObjectsJson()[0].total);
}

/**
 * Applies a partial edit to a Sale Listing, including marking it listed
 * (Req 8). Runs the UPDATE without `RETURNING` and re-fetches by id, for
 * consistency with the other tables' update functions (see their docs for
 * why `UPDATE ... RETURNING` is unsafe once a row has FK children).
 */
export async function updateSaleListing(
  id: string,
  patch: UpdateSaleListingInput,
): Promise<SaleListing | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    platform: patch.platform,
    title: patch.title,
    description: patch.description,
    asking_price: patch.askingPrice,
    listed_at: patch.listedAt,
  });
  await connection.run(`UPDATE sale_listings SET ${setSql} WHERE id = $id`, { ...params, id });
  return getSaleListingById(id);
}
