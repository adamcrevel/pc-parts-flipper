// Test-only infrastructure for T14's concurrency proof (concurrency.test.ts):
// boots a *real* Fastify server as a child process (the same `tsx src/
// index.ts` entry point `npm run dev` uses — src/index.ts has no exported
// build function, it listens as a side effect of being imported, so an
// in-process bootstrap isn't available without changing production code)
// against an isolated, per-run temp DuckDB file, and provides small fetch
// wrappers so the test file itself stays readable.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// apps/server/test -> apps/server, where src/index.ts and package.json live.
const serverRoot = path.resolve(testDir, '..');
// Resolved relative to this file (inside the npm workspace tree) so it finds
// the hoisted root node_modules/tsx the same way apps/server's own `npm run
// dev` script does via its local devDependency on tsx.
const tsxCliPath = createRequire(import.meta.url).resolve('tsx/cli');

/** A running test instance of the real server, plus its isolated data dir and a teardown hook. */
export interface TestServer {
  baseUrl: string;
  dataDir: string;
  /**
   * Combined stdout/stderr captured from the server process so far — this
   * backend's pino logger (logger.ts) writes structured JSON log lines to
   * stdout, so tests needing to confirm a value reached `logger.error`
   * (without it leaking into the HTTP response) can grep this instead of
   * instrumenting the logger itself.
   */
  output(): string;
  stop(): Promise<void>;
}

/** Generic `{ status, body }` pair every helper below returns, so assertions can inspect both. */
export interface JsonResponse<T> {
  status: number;
  body: T;
}

// Polls GET /health until it responds 200 or `timeoutMs` elapses, so the
// test doesn't start firing requests at a server that hasn't finished
// running migrations yet (client.ts's initializeConnection awaits
// runMigrations before the server starts listening, but the listen promise
// itself still needs a moment to bind the port).
async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    const { promise: waited, resolve: resolveWait } = Promise.withResolvers<void>();
    setTimeout(resolveWait, 150);
    await waited;
  }
  throw new Error(`Server at ${baseUrl} never became healthy within ${timeoutMs}ms (last error: ${String(lastError)})`);
}

/**
 * Spawns the real server (via its production entry point, src/index.ts) as
 * a child process bound to `port`, pointed at a freshly created temp
 * directory via DUCKDB_DATA_DIR (client.ts reads this env var, see T3's
 * assumption A4 comment there) so this test run never touches/pollutes the
 * shared dev data/ directory. Captures stdout/stderr so a startup failure
 * surfaces real server logs in the thrown error instead of just "timed out".
 *
 * `envOverrides` is merged in last, so a caller can both point the server at
 * its own pre-seeded DuckDB directory (overriding DUCKDB_DATA_DIR — used by
 * identifyPartsJobsRoute.test.ts to seed fixture rows before the server ever
 * opens the file) and/or tune a knob like IDENTIFY_PARTS_POOL_SIZE (used by
 * identifyPartsRoute.test.ts and identifyPartsJobsRoute.test.ts to disable
 * the background worker, so a job these tests leave `queued` is never
 * claimed and the real `omp` binary never invoked). When DUCKDB_DATA_DIR is
 * overridden this way, the override's owner is responsible for that
 * directory's cleanup — stop() below only removes the one it created itself.
 */
export async function startTestServer(port: number, envOverrides: Record<string, string> = {}): Promise<TestServer> {
  const ownsDataDir = envOverrides.DUCKDB_DATA_DIR === undefined;
  const dataDir = envOverrides.DUCKDB_DATA_DIR ?? (await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-concurrency-')));
  const output: string[] = [];
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [tsxCliPath, 'src/index.ts'], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(port), DUCKDB_DATA_DIR: dataDir, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  // Default 90s: measured server boot (DuckDB connect + migrations + Fastify
  // listen) takes ~22-26s in WSL/mounted-drive environments, well past the
  // previous 20s timeout, which made this flake on reasons unrelated to app
  // correctness. Overridable via env for CI boxes that need more headroom.
  const healthTimeoutMs = Number(process.env.TEST_SERVER_HEALTH_TIMEOUT_MS ?? 90_000);
  try {
    await waitForHealth(baseUrl, healthTimeoutMs);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(`${(err as Error).message}\n--- server output ---\n${output.join('')}`);
  }
  return {
    baseUrl,
    dataDir,
    output: () => output.join(''),
    async stop(): Promise<void> {
      const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
      child.once('exit', () => resolveExit());
      child.kill('SIGTERM');
      await exited;
      if (ownsDataDir) {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/** POSTs `body` as JSON to `url` and returns the parsed response status/body. */
export async function postJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** PATCHes `body` as JSON to `url` and returns the parsed response status/body. */
export async function patchJson<T>(url: string, body: unknown): Promise<JsonResponse<T>> {
  const res = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

/** GETs `url` and returns the parsed response status/body. */
export async function getJson<T>(url: string): Promise<JsonResponse<T>> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}
