// Typed CRUD for the `sources` table (Req 1: create, edit, deactivate).
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { buildSetClause } from '../sqlHelpers.js';
import type { PlatformType, Source } from '../types.js';

/** Fields the caller supplies when creating a Source; id/timestamps are server-assigned. */
export interface CreateSourceInput {
  name: string;
  platformType: PlatformType;
  url: string | null;
  notes: string | null;
  /**
   * JSON-encoded EbayConnectorConfig (packages/shared/src/connectors.ts), or
   * null/omitted for no automated scan. Optional (rather than required)
   * so every pre-existing manual-Source-creation caller that predates this
   * field keeps working unchanged — createSource defaults a missing value
   * to null itself, the same defensive pattern createListing already uses
   * for externalSource/externalItemId.
   */
  connectorConfig?: string | null;
}

/** Fields that may be edited on an existing Source; omitted keys are left unchanged. */
export interface UpdateSourceInput {
  name?: string;
  platformType?: PlatformType;
  url?: string | null;
  notes?: string | null;
  active?: boolean;
  connectorConfig?: string | null;
}

// Converts one raw JSON row (snake_case columns, DECIMAL/UUID as strings) into
// the camelCase Source shape the rest of the app consumes.
function mapRow(row: Record<string, unknown>): Source {
  return {
    id: row.id as string,
    name: row.name as string,
    platformType: row.platform_type as PlatformType,
    url: row.url as string | null,
    notes: row.notes as string | null,
    active: row.active as boolean,
    connectorConfig: row.connector_config as string | null,
    lastScannedAt: row.last_scanned_at as string | null,
    lastScanFoundCount: row.last_scan_found_count as number | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts a new Source and returns the row as stored. */
export async function createSource(input: CreateSourceInput): Promise<Source> {
  const connection = await getConnection();
  const id = newId();
  const reader = await connection.runAndReadAll(
    `INSERT INTO sources (id, name, platform_type, url, notes, connector_config)
     VALUES ($id, $name, $platform_type, $url, $notes, $connector_config)
     RETURNING *`,
    {
      id,
      name: input.name,
      platform_type: input.platformType,
      url: input.url,
      notes: input.notes,
      // `?? null`: DuckDB's node-api driver can't infer a bind type for a
      // bare JS `undefined` ("Cannot create values of type ANY"), so a
      // caller that omits connectorConfig entirely must still bind an
      // explicit SQL NULL here, not undefined.
      connector_config: input.connectorConfig ?? null,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches one Source by id, or null if no such row exists. */
export async function getSourceById(id: string): Promise<Source | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(`SELECT * FROM sources WHERE id = $id`, { id });
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Lists Sources, optionally restricted to active ones, newest first. */
export async function listSources(options?: { activeOnly?: boolean }): Promise<Source[]> {
  const connection = await getConnection();
  const whereSql = options?.activeOnly ? 'WHERE active = true' : '';
  const reader = await connection.runAndReadAll(
    `SELECT * FROM sources ${whereSql} ORDER BY created_at DESC`,
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/**
 * Applies a partial edit to a Source (also used to deactivate: `{ active: false }`).
 * Runs the UPDATE without `RETURNING` and re-fetches by id instead: DuckDB
 * rejects `UPDATE ... RETURNING` on a row that another table's FOREIGN KEY
 * references (sources is referenced by listings.source_id), even when the
 * referencing column itself is untouched.
 */
export async function updateSource(id: string, patch: UpdateSourceInput): Promise<Source | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    name: patch.name,
    platform_type: patch.platformType,
    url: patch.url,
    notes: patch.notes,
    active: patch.active,
    connector_config: patch.connectorConfig,
  });
  await connection.run(`UPDATE sources SET ${setSql} WHERE id = $id`, { ...params, id });
  return getSourceById(id);
}

/**
 * Updates a Source's scan-recency fields after an automated scan run
 * (lastScannedAt/lastScanFoundCount). Kept separate from updateSource rather
 * than folded into UpdateSourceInput's general edit path because these two
 * fields are system-managed — written only by the scan service (T6/T9),
 * never by the Source edit form — so giving them their own narrow function
 * signature keeps that ownership boundary explicit at the call site.
 */
export async function updateSourceScanStats(
  id: string,
  stats: { lastScannedAt: string; lastScanFoundCount: number },
): Promise<Source | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    last_scanned_at: stats.lastScannedAt,
    last_scan_found_count: stats.lastScanFoundCount,
  });
  await connection.run(`UPDATE sources SET ${setSql} WHERE id = $id`, { ...params, id });
  return getSourceById(id);
}
