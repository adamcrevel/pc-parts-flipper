// Typed CRUD for the `expected_parts` table (Req 2-3, 6).
import type { AiPartConfidence, AiPartSource, IdentityCandidate } from '@pc-parts-flipper/shared';
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import { buildSetClause, toNullableNumber } from '../sqlHelpers.js';
import type { ComponentCategory, ExpectedPart } from '../types.js';

/**
 * Fields the caller supplies when adding an Expected Part to a Listing.
 * `brand`/`partNumber` are nullable on purpose: a component the user (or the
 * AI identifier) could not pin down is stored blank, never guessed.
 * `aiConfidence`/`aiSource` are likewise required-but-nullable: both null
 * for a manual row, both set for one identify-parts just added (see
 * ExpectedPart's doc comment in packages/shared/src/listings.ts).
 */
export interface CreateExpectedPartInput {
  listingId: string;
  componentCategory: ComponentCategory;
  brand: string | null;
  partNumber: string | null;
  description: string;
  estimatedResaleValue: number | null;
  identityCandidates: IdentityCandidate[];
  aiConfidence: AiPartConfidence | null;
  aiSource: AiPartSource | null;
}

/** Fields that may be edited on an existing Expected Part; omitted keys are left unchanged. */
export interface UpdateExpectedPartInput {
  componentCategory?: ComponentCategory;
  brand?: string | null;
  partNumber?: string | null;
  description?: string;
  estimatedResaleValue?: number | null;
  identityCandidates?: IdentityCandidate[];
  aiConfidence?: AiPartConfidence | null;
  aiSource?: AiPartSource | null;
}

// Converts one raw JSON row into the camelCase ExpectedPart shape.
function mapRow(row: Record<string, unknown>): ExpectedPart {
  return {
    id: row.id as string,
    listingId: row.listing_id as string,
    componentCategory: row.component_category as ComponentCategory,
    brand: (row.brand as string | null) ?? null,
    partNumber: (row.part_number as string | null) ?? null,
    description: row.description as string,
    estimatedResaleValue: toNullableNumber(row.estimated_resale_value as string | null),
    identityCandidates: JSON.parse(row.identity_candidates as string) as IdentityCandidate[],
    aiConfidence: (row.ai_confidence as AiPartConfidence | null) ?? null,
    aiSource: (row.ai_source as AiPartSource | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts a new Expected Part on a Listing and returns the row as stored. */
export async function createExpectedPart(input: CreateExpectedPartInput): Promise<ExpectedPart> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO expected_parts (id, listing_id, component_category, brand, part_number, description, estimated_resale_value, identity_candidates, ai_confidence, ai_source)
     VALUES ($id, $listing_id, $component_category, $brand, $part_number, $description, $estimated_resale_value, $identity_candidates, $ai_confidence, $ai_source)
     RETURNING *`,
    {
      id: newId(),
      listing_id: input.listingId,
      component_category: input.componentCategory,
      brand: input.brand,
      part_number: input.partNumber,
      description: input.description,
      estimated_resale_value: input.estimatedResaleValue,
      identity_candidates: JSON.stringify(input.identityCandidates),
      ai_confidence: input.aiConfidence,
      ai_source: input.aiSource,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Fetches one Expected Part by id, or null if no such row exists. */
export async function getExpectedPartById(id: string): Promise<ExpectedPart | null> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM expected_parts WHERE id = $id`,
    { id },
  );
  const rows = reader.getRowObjectsJson();
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

/** Lists every Expected Part on a Listing — feeds the comparison calculation (Req 3). */
export async function listExpectedPartsByListing(listingId: string): Promise<ExpectedPart[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM expected_parts WHERE listing_id = $listing_id ORDER BY created_at ASC`,
    { listing_id: listingId },
  );
  return reader.getRowObjectsJson().map(mapRow);
}

/**
 * Applies a partial edit to an Expected Part. Runs the UPDATE without
 * `RETURNING` and re-fetches by id instead: DuckDB rejects
 * `UPDATE ... RETURNING` on a row another table's FOREIGN KEY references
 * (expected_parts is referenced by teardown_results.expected_part_id).
 */
export async function updateExpectedPart(
  id: string,
  patch: UpdateExpectedPartInput,
): Promise<ExpectedPart | null> {
  const connection = await getConnection();
  const { setSql, params } = buildSetClause({
    component_category: patch.componentCategory,
    brand: patch.brand,
    part_number: patch.partNumber,
    description: patch.description,
    estimated_resale_value: patch.estimatedResaleValue,
    identity_candidates: patch.identityCandidates !== undefined ? JSON.stringify(patch.identityCandidates) : undefined,
  });
  await connection.run(`UPDATE expected_parts SET ${setSql} WHERE id = $id`, { ...params, id });
  return getExpectedPartById(id);
}

/** Removes an Expected Part (e.g. while still editing an open Listing). */
export async function deleteExpectedPart(id: string): Promise<void> {
  const connection = await getConnection();
  await connection.run(`DELETE FROM expected_parts WHERE id = $id`, { id });
}
