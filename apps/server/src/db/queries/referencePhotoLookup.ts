// Lead-ranked lookup for `part_reference_photos` (ai-visual-identification
// feature T1). Split into its own file, alongside referencePhotos.ts, rather
// than folded in there: that file was already at this project's ~200-line
// convention once this query and its mapRow usage were added, so
// findReferencePhotosForLeads moved here along with the mapRow helper it's
// the only remaining caller of.
import type { DuckDBValue } from '@duckdb/node-api';
import { getConnection } from '../client.js';
import type { ComponentCategory, ReferencePhoto } from '../types.js';

/** Converts one raw JSON row into the camelCase ReferencePhoto shape. */
function mapRow(row: Record<string, unknown>): ReferencePhoto {
  return {
    id: row.id as string,
    category: row.category as ComponentCategory,
    brand: row.brand as string,
    partNumber: (row.part_number as string | null) ?? null,
    photoPath: row.photo_path as string,
    source: row.source as 'seed' | 'confirmed_listing',
    listingId: (row.listing_id as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/** Lead object for findReferencePhotosForLeads, identifying a possible component by brand and part number. */
export interface Lead {
  brand: string | null;
  partNumber: string | null;
}

/**
 * Queries reference photos for a category, preferring rows matching one of the
 * provided leads' brand/partNumber pairs (partNumber match optional) when at
 * least one lead has a non-null brand; otherwise returns any rows in that
 * category. When filtered by leads, results honor the leads array's own
 * priority order (leads[0] — the part's own known brand — outranks leads[1],
 * leads[2], ... — identity candidates — regardless of alphabetical brand
 * order) when the `limit` cap forces a choice; within a brand+partNumber
 * group, results are most-recent-first. Results are de-duplicated to at most
 * one row per distinct brand+partNumber pair, and capped at `limit`.
 */
export async function findReferencePhotosForLeads(
  category: ComponentCategory,
  leads: Lead[],
  limit: number,
): Promise<ReferencePhoto[]> {
  const connection = await getConnection();

  const leadsWithBrand = leads.filter(lead => lead.brand !== null);

  if (leadsWithBrand.length === 0) {
    // No lead has a non-null brand: return any rows in category.
    const reader = await connection.runAndReadAll(
      `SELECT DISTINCT ON (brand, part_number) *
       FROM part_reference_photos
       WHERE category = $category
       ORDER BY brand, part_number, created_at DESC
       LIMIT $limit`,
      { category, limit },
    );
    return reader.getRowObjectsJson().map(mapRow);
  }

  // At least one lead has a non-null brand: filter to those brands using parameterized queries.
  const params: Record<string, DuckDBValue> = { category, limit };
  const brandPlaceholders = leadsWithBrand.map((lead, idx) => {
    params[`brand_${idx}`] = lead.brand;
    return `$brand_${idx}`;
  });
  // Priority follows the leads array's own order (leads[0] = own brand, outranks
  // leads[1], leads[2], ... = identityCandidates), not alphabetical brand order.
  const priorityCase = leadsWithBrand
    .map((_, idx) => `WHEN brand = $brand_${idx} THEN ${idx}`)
    .join(' ');

  const reader = await connection.runAndReadAll(
    `SELECT * FROM (
       SELECT DISTINCT ON (brand, part_number) *,
         CASE ${priorityCase} ELSE ${leadsWithBrand.length} END AS lead_priority
       FROM part_reference_photos
       WHERE category = $category AND brand IN (${brandPlaceholders.join(', ')})
       ORDER BY brand, part_number, created_at DESC
     )
     ORDER BY lead_priority ASC, created_at DESC
     LIMIT $limit`,
    params,
  );

  return reader.getRowObjectsJson().map(mapRow);
}
