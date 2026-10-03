// Primary-key generation for every table in this module.
import { randomUUID } from 'node:crypto';

/**
 * Generates a new primary-key value for any row in this schema. Every table
 * uses an application-generated UUID (v4, via Node's built-in crypto) rather
 * than a DB-side auto-increment sequence, so two concurrent requests can
 * never be assigned the same ID — a sequence's "read max, add one" step is
 * exactly the kind of race T14 later proves never happens here.
 */
export function newId(): string {
  return randomUUID();
}
