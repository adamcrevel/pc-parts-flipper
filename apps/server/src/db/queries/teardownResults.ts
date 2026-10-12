// Typed CRUD for the `teardown_results` table (Req 6).
import { getConnection } from '../client.js';
import { newId } from '../id.js';
import type { TeardownResult, TeardownResultType } from '@pc-parts-flipper/shared';

/** Fields supplied for one reconciled line of a teardown submission. */
export interface CreateTeardownResultInput {
  purchaseId: string;
  /** Null for an Additional Part not on the originating Listing. */
  expectedPartId: string | null;
  result: TeardownResultType;
  note: string | null;
}

// Converts one raw JSON row into the camelCase TeardownResult shape.
function mapRow(row: Record<string, unknown>): TeardownResult {
  return {
    id: row.id as string,
    purchaseId: row.purchase_id as string,
    expectedPartId: row.expected_part_id as string | null,
    result: row.result as TeardownResultType,
    note: row.note as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Inserts one reconciled teardown line. Called once per Expected Part (plus any Additional Parts). */
export async function createTeardownResult(
  input: CreateTeardownResultInput,
): Promise<TeardownResult> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `INSERT INTO teardown_results (id, purchase_id, expected_part_id, result, note)
     VALUES ($id, $purchase_id, $expected_part_id, $result, $note)
     RETURNING *`,
    {
      id: newId(),
      purchase_id: input.purchaseId,
      expected_part_id: input.expectedPartId,
      result: input.result,
      note: input.note,
    },
  );
  return mapRow(reader.getRowObjectsJson()[0]);
}

/** Lists every teardown reconciliation line recorded for a Purchase. */
export async function listTeardownResultsByPurchase(
  purchaseId: string,
): Promise<TeardownResult[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM teardown_results WHERE purchase_id = $purchase_id ORDER BY created_at ASC`,
    { purchase_id: purchaseId },
  );
  return reader.getRowObjectsJson().map(mapRow);
}
