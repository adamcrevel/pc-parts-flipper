// HTTP-level proof for apps/server/src/routes/identifyPartsJobs.ts's two
// routes: GET /api/identify-parts-jobs/:jobId and
// POST /api/identify-parts-jobs/:jobId/ack. No existing test exercises
// either route over HTTP — identifyPartsJobs.test.ts (T1) calls the
// underlying db/queries functions directly, never the route's own 404
// branches, the 400 "nothing to acknowledge yet" guard on a non-terminal
// job, or that ack's response reflects the post-update row (delivered
// flipped true), not the pre-update one it looked up to check eligibility.
//
// insertQueuedJobIfNoneActive/completeJob are query functions, not HTTP
// endpoints, and the only route that can enqueue a job
// (POST /api/listings/:id/identify-parts) hands it straight to the
// background worker pool — so a `completed` fixture can't be produced by
// HTTP calls alone without actually running the real AI identification.
// Fixture jobs are therefore seeded directly through the db module before
// the server is spawned (following identifyPartsJobs.test.ts's in-process
// pattern), and the job this file deliberately leaves `queued` (for the 400
// case) is protected from ever being claimed by passing
// IDENTIFY_PARTS_POOL_SIZE=0 to the spawned server — so the real `omp`
// binary is never invoked (this project's standing rule that the suite
// stays network/credential-independent — see ompRunner.ts).
//
// Seeding and the spawned server share one DuckDB file, but never
// concurrently: this file's own connection (opened only to seed fixtures) is
// explicitly closed via closeConnection() — CHECKPOINT then disconnect —
// *before* startTestServer spawns the real server against that same
// directory, honoring the data-access module's single-writer assumption
// (client.ts's own module doc, "exactly one Fastify process opens this
// file").
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentifyPartsResponse } from '@pc-parts-flipper/shared';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { getJson, postJson, startTestServer, type TestServer } from './helpers.js';

// Arbitrary high port distinct from every other suite's TEST_PORT (see the
// roster in identifyPartsConcurrency.test.ts's comment: 34_591-34_633;
// identifyPartsRoute.test.ts's own rewrite takes 34_635).
const TEST_PORT = 34_634;

interface ErrorResponse {
  error: { message: string; statusCode: number };
}

interface JobResponseBody {
  id: string;
  listingId: string;
  stage: string;
  errorMessage: string | null;
  delivered: boolean;
}

const sampleResult: IdentifyPartsResponse = {
  parts: [
    {
      category: 'CPU',
      brand: 'Intel',
      partNumber: 'i7-9700k',
      description: 'Good condition',
      confidence: 'high',
      source: 'text',
      identityCandidates: [],
    },
  ],
  notes: 'Looks complete',
};

let dataDir: string;
let server: TestServer;
let terminalJobId: string;
let terminalListingId: string;
let nonTerminalJobId: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-identify-parts-jobs-route-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  // Dynamic import (ts-no-dynamic-import exception, same as
  // identifyPartsJobs.test.ts): client.ts's DATA_DIR is computed once, at
  // module-evaluation time, from DUCKDB_DATA_DIR — a static top-of-file
  // import would evaluate before the env var above is set and would open the
  // shared dev database instead of this isolated temp dir.
  const db = (await import('../src/db/index.js')) as typeof DbModule;
  const { getConnection, closeConnection } = (await import('../src/db/client.js')) as typeof ClientModule;
  await runMigrations(await getConnection());

  // Terminal (completed) fixture job: backs the GET-200 and ack-200 cases.
  const terminalSource = await db.createSource({ name: 'Identify Parts Jobs Route Terminal Source', platformType: 'other', url: null, notes: null });
  const terminalListing = await db.createListing({
    sourceId: terminalSource.id,
    title: 'Terminal Fixture Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    photoPaths: [],
  });
  terminalListingId = terminalListing.id;
  const terminalJob = await db.insertQueuedJobIfNoneActive(terminalListing.id);
  if (terminalJob === null) {
    throw new Error('fixture setup: expected a fresh job for the terminal listing');
  }
  await db.completeJob(terminalJob.id, sampleResult);
  terminalJobId = terminalJob.id;

  // Non-terminal (queued) fixture job: backs the ack-400 case. Left in a
  // second, separate Listing because insertQueuedJobIfNoneActive refuses a
  // second active job for the same one.
  const nonTerminalSource = await db.createSource({ name: 'Identify Parts Jobs Route NonTerminal Source', platformType: 'other', url: null, notes: null });
  const nonTerminalListing = await db.createListing({
    sourceId: nonTerminalSource.id,
    title: 'NonTerminal Fixture Listing',
    description: null,
    listingUrl: null,
    askingPrice: 100,
    listingDate: '2026-01-01',
    acquisitionFees: 0,
    photoPaths: [],
  });
  const nonTerminalJob = await db.insertQueuedJobIfNoneActive(nonTerminalListing.id);
  if (nonTerminalJob === null) {
    throw new Error('fixture setup: expected a fresh job for the non-terminal listing');
  }
  nonTerminalJobId = nonTerminalJob.id;

  await closeConnection();

  server = await startTestServer(TEST_PORT, { DUCKDB_DATA_DIR: dataDir, IDENTIFY_PARTS_POOL_SIZE: '0' });
  // 95s, matching sources.test.ts's own precedent for this exact box:
  // measured server boot alone runs ~22-26s in WSL/mounted-drive
  // environments, and this beforeAll does a full migrate-and-seed pass
  // *before* that boot even starts, so the default 30s hook timeout and
  // heavy full-suite CPU contention (every other spawn-based suite's own
  // child process competing at once) can push this hook past 30s even
  // though it finishes well inside that in isolation.
}, 95_000);

afterAll(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
}, 30_000);

describe('GET /api/identify-parts-jobs/:jobId', () => {
  it('returns 200 with the job for an existing id, not yet delivered', async () => {
    const res = await getJson<JobResponseBody>(`${server.baseUrl}/api/identify-parts-jobs/${terminalJobId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(terminalJobId);
    expect(res.body.listingId).toBe(terminalListingId);
    expect(res.body.stage).toBe('completed');
    expect(res.body.delivered).toBe(false);
  });

  it('returns 404 for a job id that does not exist', async () => {
    const res = await getJson<ErrorResponse>(`${server.baseUrl}/api/identify-parts-jobs/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('not found');
  });
});

describe('POST /api/identify-parts-jobs/:jobId/ack', () => {
  it('returns 400 for a non-terminal (queued) job, without marking it delivered', async () => {
    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/identify-parts-jobs/${nonTerminalJobId}/ack`, {});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('nothing to acknowledge yet');

    // Confirms the 400 guard never reached markDelivered: a second GET still
    // reports the job as not delivered, not a side-effect-then-reject.
    const stillRes = await getJson<JobResponseBody>(`${server.baseUrl}/api/identify-parts-jobs/${nonTerminalJobId}`);
    expect(stillRes.body.delivered).toBe(false);
  });

  it('returns 404 for a job id that does not exist', async () => {
    const res = await postJson<ErrorResponse>(`${server.baseUrl}/api/identify-parts-jobs/00000000-0000-0000-0000-000000000000/ack`, {});

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('not found');
  });

  it('returns 200 with delivered:true reflecting the post-update row for a terminal job', async () => {
    const res = await postJson<JobResponseBody>(`${server.baseUrl}/api/identify-parts-jobs/${terminalJobId}/ack`, {});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(terminalJobId);
    expect(res.body.stage).toBe('completed');
    expect(res.body.delivered).toBe(true);

    // A second GET shows the flip is persisted, not just echoed in the ack
    // response body.
    const afterRes = await getJson<JobResponseBody>(`${server.baseUrl}/api/identify-parts-jobs/${terminalJobId}`);
    expect(afterRes.body.delivered).toBe(true);
  });
});
