// Proof for the duckdb-shutdown-wal-corruption fix: index.ts's SIGTERM/
// SIGINT handlers plus client.ts's closeConnection() must checkpoint the
// DuckDB WAL before the process dies, so a real process-manager stop (which
// sends SIGTERM, not a request to some in-process shutdown function) never
// corrupts the database.
//
// Before the fix, src/index.ts registered no signal handlers at all, so
// SIGTERM's default action terminated the process immediately. Any write
// since the last checkpoint left in the .duckdb.wal file at that instant
// made the *next* server start's WAL replay throw ("Calling
// DatabaseManager::GetDefaultDatabase with no default database set"), after
// which every DB-touching request 500s until the stale .duckdb.wal file is
// deleted by hand (losing all data back to the last checkpoint).
//
// This suite boots the real server as a child process (src/index.ts has no
// exported build function — same constraint helpers.ts's startTestServer
// documents), makes a real write so the WAL is genuinely non-empty, sends a
// *real* OS SIGTERM to that child process (not an in-process call pretending
// to be one), waits for it to actually exit, then boots a fresh server
// instance against the SAME data directory and confirms it starts cleanly,
// the prior write survived, and a further write still succeeds. It does not
// use helpers.ts's startTestServer/stop() directly because stop() deletes
// its own freshly-minted temp data dir on teardown — this suite instead
// needs one shared data directory reused across multiple server instances,
// so it spawns the child process itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, postJson, type JsonResponse } from './helpers.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// apps/server/test -> apps/server, where src/index.ts and package.json live.
const serverRoot = path.resolve(testDir, '..');
const tsxCliPath = createRequire(import.meta.url).resolve('tsx/cli');

// Arbitrary high port distinct from the other suites' ports (34_591,
// 34_597, 34_601, ...) so this one can run standalone or alongside them
// without a conflict.
const TEST_PORT = 34_613;

// Shape returned by the real Source routes (see sources.test.ts).
interface SourceResponse {
  id: string;
  name: string;
}

// One running child-process server instance, plus its captured output and a
// way to send it a real signal and wait for it to actually exit.
interface ServerProcess {
  baseUrl: string;
  output(): string;
  waitForExit(): Promise<void>;
  sendSignal(signal: NodeJS.Signals): void;
}

// Asserts the WAL file a just-exited instance left behind — DuckDB
// maintains it alongside the main database file at
// DATA_DIR/pc-parts-flipper.duckdb as DATA_DIR/pc-parts-flipper.duckdb.wal
// (see client.ts's closeConnection doc comment) — is absent or empty. This
// is a direct inspection of the on-disk artifact the checkpoint-before-
// close sequence is responsible for flushing, rather than only inferring
// it indirectly from data surviving a restart (assertion (b) in the test
// below), which is explained just as well by the main .duckdb file already
// holding the write pre-shutdown. Empirically verified (by temporarily
// stripping closeConnection() down to a bare disconnectSync()+closeSync(),
// no explicit CHECKPOINT, and re-running this suite) that this assertion's
// pass/fail boundary is "did closeConnection()'s close sequence run at all
// before the process exited" rather than "did the CHECKPOINT statement
// specifically run" — this DuckDB binding's own disconnectSync()+closeSync()
// already performs an equivalent implicit checkpoint on a clean, orderly
// close, so the explicit `CHECKPOINT` statement is redundant on that path
// and its removal alone does not leave a non-empty WAL file. What this
// assertion does catch — confirmed by removing closeConnection()'s call
// entirely so the process calls process.exit(0) without closing the DB —
// is the WAL being left dirty when the close sequence is skipped outright,
// which is the actual shape of the original corruption bug (SIGTERM's
// default action killing the process before any close logic runs).
async function expectWalFlushed(dataDir: string): Promise<void> {
  try {
    const walStat = await stat(path.join(dataDir, 'pc-parts-flipper.duckdb.wal'));
    expect(walStat.size).toBe(0);
  } catch (err) {
    // ENOENT means DuckDB removed the WAL file entirely on checkpoint/close
    // — also a clean flush, not a failure to assert on.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

// Polls GET /health until it responds 200 or `timeoutMs` elapses (same
// rationale as helpers.ts's private waitForHealth: migrations must finish
// before the server starts accepting other requests).
async function waitForHealth(baseUrl: string, timeoutMs: number, output: () => string): Promise<void> {
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
  throw new Error(
    `Server at ${baseUrl} never became healthy within ${timeoutMs}ms (last error: ${String(lastError)})\n--- server output ---\n${output()}`,
  );
}

// Spawns the real server (production entry point, src/index.ts) as a child
// process bound to `port`, pointed at `dataDir` via DUCKDB_DATA_DIR. Unlike
// helpers.ts's startTestServer, this never creates or deletes `dataDir`
// itself — the caller owns that directory's lifecycle across multiple
// spawned instances, which is the whole point of this suite.
async function spawnServer(dataDir: string, port: number): Promise<ServerProcess> {
  const output: string[] = [];
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [tsxCliPath, 'src/index.ts'], {
    cwd: serverRoot,
    env: { ...process.env, PORT: String(port), DUCKDB_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  // Same 90s default as helpers.ts's startTestServer: measured boot time
  // (DuckDB connect + migrations + Fastify listen) runs ~22-26s on
  // WSL/mounted-drive environments.
  const healthTimeoutMs = Number(process.env.TEST_SERVER_HEALTH_TIMEOUT_MS ?? 90_000);
  try {
    await waitForHealth(baseUrl, healthTimeoutMs, () => output.join(''));
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  return {
    baseUrl,
    output: () => output.join(''),
    waitForExit(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve();
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      child.once('exit', () => resolve());
      return promise;
    },
    sendSignal(signal: NodeJS.Signals): void {
      child.kill(signal);
    },
  };
}

describe('graceful shutdown preserves the DuckDB WAL across SIGTERM (duckdb-shutdown-fix)', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-shutdown-'));
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it(
    'checkpoints on SIGTERM so a restart against the same data dir never hits a WAL-replay error and never loses data, across two cycles',
    async () => {
      const writtenNames: string[] = [];

      // Two full write -> SIGTERM -> restart cycles in direct succession
      // against the same data directory, reusing the same port each time
      // (the prior instance has fully exited before the next one binds it).
      for (let cycle = 1; cycle <= 2; cycle++) {
        const instance = await spawnServer(dataDir, TEST_PORT);

        // (a) Starting cleanly: no WAL-replay error anywhere in this
        // instance's own output. On the corrupted-shutdown bug, this is
        // exactly where DuckDB's WAL-replay failure would have surfaced for
        // cycle 2+ (cycle 1 has no prior WAL to replay, so this assertion
        // is only meaningful from cycle 2 on, but checking every cycle
        // costs nothing and keeps the loop uniform).
        expect(instance.output()).not.toMatch(/failure while replaying wal|getdefaultdatabase/i);

        // (b) The previous cycle's write is still visible after the
        // restart — proves the prior shutdown actually checkpointed the
        // WAL into the main file rather than merely avoiding a crash.
        if (writtenNames.length > 0) {
          const listRes: JsonResponse<SourceResponse[]> = await getJson<SourceResponse[]>(
            `${instance.baseUrl}/api/sources`,
          );
          expect(listRes.status).toBe(200);
          const names = listRes.body.map((s) => s.name);
          for (const expectedName of writtenNames) {
            expect(names).toContain(expectedName);
          }
        }

        // (c) A new write against this (possibly freshly restarted)
        // instance succeeds, and leaves the WAL genuinely non-empty again
        // for the SIGTERM below to actually have something to checkpoint.
        const sourceName = `Shutdown Test Source ${cycle}`;
        const createRes: JsonResponse<SourceResponse> = await postJson<SourceResponse>(
          `${instance.baseUrl}/api/sources`,
          { name: sourceName, platformType: 'other', url: `https://example.com/cycle-${cycle}` },
        );
        expect(createRes.status).toBe(201);
        expect(createRes.body.name).toBe(sourceName);
        writtenNames.push(sourceName);

        // Send a real OS SIGTERM to the real running child process — the
        // same signal a graceful process-manager stop sends — and wait for
        // the process to actually exit before moving on, so the next
        // cycle's spawn never races this one's port/file handles.
        instance.sendSignal('SIGTERM');
        await instance.waitForExit();

        // The exiting instance's own log output must show the graceful
        // shutdown sequence actually ran (not just that the process died),
        // confirming the signal handler — not some other exit path — is
        // what closed things down.
        expect(instance.output()).toMatch(/graceful shutdown/i);

        // (d) The WAL file this cycle's write left non-empty (per (c)) is
        // absent or empty now that the instance has exited — direct
        // inspection of the flushed artifact itself (see expectWalFlushed),
        // not just an inference from data being visible after restart
        // (which (b) above already covers).
        await expectWalFlushed(dataDir);
      }
    },
    120_000,
  );

  it(
    'sends two back-to-back shutdown signals to one running instance and runs the shutdown sequence exactly once, exiting cleanly with data intact',
    async () => {
      // Own data dir and port, independent of the describe-level dataDir
      // used above, so this test's double-signal never races the other
      // test's sequential cycles.
      const idempotencyPort = TEST_PORT + 1;
      const idempotencyDataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-shutdown-idempotent-'));
      try {
        const instance = await spawnServer(idempotencyDataDir, idempotencyPort);

        const sourceName = 'Idempotent Shutdown Source';
        const createRes: JsonResponse<SourceResponse> = await postJson<SourceResponse>(
          `${instance.baseUrl}/api/sources`,
          { name: sourceName, platformType: 'other', url: 'https://example.com/idempotent' },
        );
        expect(createRes.status).toBe(201);

        // Two real OS signals sent back-to-back, before the first has
        // finished (the full close sequence below takes ~20ms; a 5ms gap
        // lands squarely inside that window) — the closest a test can get
        // to the re-entrancy a process manager's SIGTERM-then-SIGKILL-
        // adjacent-SIGTERM retry, or a user hitting Ctrl+C right after a
        // stop request, can trigger. Two empirically-confirmed reasons this
        // is SIGTERM-then-SIGINT with a tiny gap, not two bare SIGTERMs:
        // (1) two identical signals sent with zero gap between them (by
        // calling child.kill('SIGTERM') twice synchronously) get coalesced
        // into a single delivery by the OS/Node's signal handling before
        // gracefulShutdown() ever runs a second time, confirmed by removing
        // index.ts's shuttingDown guard and re-running this test with two
        // bare SIGTERMs: it still passed, since the guard was never
        // actually exercised. SIGTERM and SIGINT are distinct signal
        // numbers, are not coalesced the same way, and both route through
        // the same shuttingDown-guarded gracefulShutdown(), so this
        // reliably exercises the guard. (2) sending both signals with zero
        // gap between them (even as two distinct signal numbers) reliably
        // produced a child process that exited having written none of its
        // shutdown-related log lines at all — not even the first,
        // synchronous one — confirmed by capturing and inspecting the raw
        // output across several such runs. A small real gap avoids
        // whatever that zero-gap delivery edge case is while still landing
        // well inside the shutdown sequence's in-flight window; faking the
        // clock cannot substitute for it since what is being exercised is
        // the real OS's signal delivery timing to a real spawned process,
        // not application-level scheduling.
        instance.sendSignal('SIGTERM');
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        instance.sendSignal('SIGINT');
        await instance.waitForExit();

        // "Shutdown signal received" — gracefulShutdown()'s first log line,
        // written synchronously right after the shuttingDown guard check —
        // must appear exactly once: twice would mean the guard let the
        // second signal's gracefulShutdown() call proceed past the guard
        // instead of returning immediately. Deliberately not counting the
        // later "Graceful shutdown complete" line here: that one is written
        // immediately before process.exit(0) with no intervening await, so
        // on a piped child stdout (this test's stdio: 'pipe') it can race
        // process.exit()'s immediate termination and be dropped by Node's
        // asynchronous pipe write even on a correct single run. "Shutdown
        // signal received" has the `await server.close()` and `await
        // closeConnection()` calls between it and process.exit(), giving
        // Node's pipe write time to flush before the process can possibly
        // exit, so it reliably survives on every correct run.
        const startedMatches = instance.output().match(/shutdown signal received/gi) ?? [];
        expect(startedMatches).toHaveLength(1);

        // The single shutdown that did run still checkpointed cleanly.
        await expectWalFlushed(idempotencyDataDir);

        // The process exited intact (not mid-write): a fresh instance
        // against the same data dir starts cleanly and still has the data.
        const restarted = await spawnServer(idempotencyDataDir, idempotencyPort);
        try {
          expect(restarted.output()).not.toMatch(/failure while replaying wal|getdefaultdatabase/i);
          const listRes: JsonResponse<SourceResponse[]> = await getJson<SourceResponse[]>(
            `${restarted.baseUrl}/api/sources`,
          );
          expect(listRes.status).toBe(200);
          expect(listRes.body.map((s) => s.name)).toContain(sourceName);
        } finally {
          restarted.sendSignal('SIGTERM');
          await restarted.waitForExit();
        }
      } finally {
        await rm(idempotencyDataDir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  it(
    'reproduces the real npm-run-dev stop path: SIGTERM and SIGHUP arrive ~1ms apart on one running instance, and the WAL still flushes cleanly',
    async () => {
      // Own data dir and port, independent of the other two tests' dirs/
      // ports, so this test's two-signal delivery never races them.
      const sighupPort = TEST_PORT + 2;
      const sighupDataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-shutdown-sighup-'));
      try {
        const instance = await spawnServer(sighupDataDir, sighupPort);

        const sourceName = 'SIGHUP Race Source';
        const createRes: JsonResponse<SourceResponse> = await postJson<SourceResponse>(
          `${instance.baseUrl}/api/sources`,
          { name: sourceName, platformType: 'other', url: 'https://example.com/sighup-race' },
        );
        expect(createRes.status).toBe(201);

        // This instance's own startup log line ("Registering scheduled scan
        // job") carries pino's standard `pid` field — the *real* node
        // process running src/index.ts, not spawnServer's direct child.
        // Those differ here: `spawn(process.execPath, [tsxCliPath,
        // 'src/index.ts'])` runs tsx's CLI wrapper first, which re-execs a
        // second, genuine node process to actually run src/index.ts (an
        // esbuild-transform/loader-hook requirement, confirmed by capturing
        // both pids in a standalone repro and seeing the wrapper's `pid`
        // differ from every pino-logged `pid` in its output). This test
        // signals that real, inner process directly rather than through
        // ServerProcess.sendSignal (which targets the wrapper). That
        // distinction matters here specifically because tsx's own CLI
        // bundle only ever registers `process.on('SIGINT', ...)` and
        // `process.on('SIGTERM', ...)` on its wrapper to relay those two
        // signals to its inner child — it has no SIGHUP listener at all
        // (confirmed by grepping the installed tsx build for every `SIG*`
        // literal it references: only SIGTERM/SIGKILL/SIGINT appear, never
        // SIGHUP). Signaling the wrapper with SIGHUP therefore kills the
        // *wrapper* via Node's own default SIGHUP action — synchronously,
        // before its (also async) SIGTERM relay can forward anything to
        // the real process — which would exercise a bug in tsx's relay,
        // not the race this fix targets. Signaling the real inner process
        // PID directly instead matches how the diagnosed production race
        // actually reaches src/index.ts: a process-tree teardown delivers
        // SIGTERM and SIGHUP straight to that real process (e.g. via an OS
        // process-group signal broadcast), not through any single relay.
        const pidMatch = instance.output().match(/"pid":(\d+)/);
        if (!pidMatch) {
          throw new Error(`Could not find the real app process pid in server output:\n${instance.output()}`);
        }
        const realAppPid = Number(pidMatch[1]);

        // The precise failure mode this fix targets, reproduced directly
        // against the real process: SIGTERM and SIGHUP arrive ~1ms apart
        // (the empirically observed gap), not SIGTERM alone. Before
        // index.ts registered a SIGHUP handler, SIGHUP's default action
        // terminated the process synchronously, racing ahead of SIGTERM's
        // async gracefulShutdown() and killing the process before `await
        // server.close(); await closeConnection();` ever completed — the
        // exact WAL corruption this whole fix exists to prevent (confirmed
        // via a standalone repro: with the SIGHUP handler removed, this
        // exact sequence logs "Shutdown signal received" but never reaches
        // "Graceful shutdown complete", and the wrapper's own exit code
        // reports signal 1/SIGHUP). A 1ms setTimeout is the closest a test
        // can get to that observed gap; 0ms risks the same signal-
        // coalescing edge case the idempotency test above documents for
        // two identical signals.
        process.kill(realAppPid, 'SIGTERM');
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        process.kill(realAppPid, 'SIGHUP');
        await instance.waitForExit();

        expect(instance.output()).toMatch(/graceful shutdown/i);

        // The WAL this write left non-empty is flushed despite the SIGHUP
        // racing in right behind SIGTERM.
        await expectWalFlushed(sighupDataDir);

        // The process exited intact: a fresh instance against the same
        // data dir starts cleanly and still has the data.
        const restarted = await spawnServer(sighupDataDir, sighupPort);
        try {
          expect(restarted.output()).not.toMatch(/failure while replaying wal|getdefaultdatabase/i);
          const listRes: JsonResponse<SourceResponse[]> = await getJson<SourceResponse[]>(
            `${restarted.baseUrl}/api/sources`,
          );
          expect(listRes.status).toBe(200);
          expect(listRes.body.map((s) => s.name)).toContain(sourceName);
        } finally {
          restarted.sendSignal('SIGTERM');
          await restarted.waitForExit();
        }
      } finally {
        await rm(sighupDataDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
