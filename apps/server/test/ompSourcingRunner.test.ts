// Proof for the AI reference-image-sourcing runner
// (apps/server/src/ai/ompSourcingRunner.ts): argv assembly and the shared
// child-process machinery it reuses from ompRunner.ts.
//
// The real `omp` binary is NEVER invoked here, same two seams
// partIdentification.test.ts uses for runOmpIdentification: setOmpSourcing-
// RunnerOverride replaces the whole runner, and the runner's own `spawnFn`
// option replaces node:child_process.spawn — spawning this same Node binary
// (process.execPath) with a tiny inline script instead, so timeout/kill,
// ENOENT and non-zero-exit behavior is exercised against a real child
// process with no model session, no network and no credentials.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runner from '../src/ai/ompSourcingRunner.js';
import { DEFAULT_OMP_TIMEOUT_MS } from '../src/ai/ompRunner.js';
import type { SpawnFn } from '../src/ai/ompRunner.js';

// Builds a SpawnFn that runs this Node binary on `script` — a real child
// process that is not omp, used to exercise the runner's stdout/exit/timeout
// handling. The options are the ones production passed in, never a local
// copy, so every test built on this also proves the real spawn options
// (notably `detached: true`) still let stdout and exit codes through.
function nodeSpawn(script: string): SpawnFn {
  return (_command, _args, options) => spawn(process.execPath, ['-e', script], options);
}

/**
 * A ChildProcess stand-in that emits nothing at all — no stdout, no 'close',
 * no 'error' — so a run against it can only ever settle via the timeout. It
 * carries a pid so the production kill path (a signal to the *negated* pid,
 * i.e. the whole process group) is observable on a spied process.kill.
 */
function neverSettlingFakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

afterEach(() => {
  runner.setOmpSourcingRunnerOverride(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.AI_IDENTIFY_MODEL;
  delete process.env.AI_IDENTIFY_API_KEY;
});

describe('buildOmpSourcingArgs', () => {
  it('includes the prompt, print mode, and no --no-tools or @image args', () => {
    const args = runner.buildOmpSourcingArgs('FIND THE PHOTO');

    expect(args).toEqual(['-p', 'FIND THE PHOTO']);
    expect(args).not.toContain('--no-tools');
    expect(args.some((arg) => arg.startsWith('@'))).toBe(false);
  });

  it('prepends --model/--api-key only when the env vars are set, read at call time', () => {
    expect(runner.buildOmpSourcingArgs('P')).toEqual(['-p', 'P']);

    process.env.AI_IDENTIFY_MODEL = 'some-model';
    process.env.AI_IDENTIFY_API_KEY = 'secret-key';

    expect(runner.buildOmpSourcingArgs('P')).toEqual(['--model=some-model', '--api-key=secret-key', '-p', 'P']);
  });
});

describe('runOmpImageSourcing process handling', () => {
  it('resolves with the child process stdout and ignores stderr', async () => {
    const script = 'process.stderr.write("progress noise");process.stdout.write("https://vendor.example/photo.jpg")';

    const stdout = await runner.runOmpImageSourcing('P', { timeoutMs: 10_000, spawnFn: nodeSpawn(script) });

    expect(stdout).toBe('https://vendor.example/photo.jpg');
  });

  it('passes the exact argv (no --no-tools, no @image) and spawn options to spawn', async () => {
    const spawnFn = vi.fn(nodeSpawn('process.stdout.write("ok")'));

    await runner.runOmpImageSourcing('PROMPT', { timeoutMs: 10_000, spawnFn });

    expect(spawnFn).toHaveBeenCalledWith('omp', ['-p', 'PROMPT'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
  });

  it('rejects with a sourcing-specific message when the binary is not found (ENOENT)', async () => {
    const spawnFn: SpawnFn = () => spawn('definitely-not-a-real-binary-xyz', [], { stdio: ['ignore', 'pipe', 'ignore'] });

    await expect(runner.runOmpImageSourcing('P', { timeoutMs: 10_000, spawnFn })).rejects.toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining("AI reference image sourcing requires the 'omp' CLI on PATH"),
      }),
    );
  });

  it('rejects with the exit code when the CLI exits non-zero', async () => {
    const spawnFn = nodeSpawn('process.exit(3)');

    await expect(runner.runOmpImageSourcing('P', { timeoutMs: 10_000, spawnFn })).rejects.toThrow(
      expect.objectContaining({
        statusCode: 502,
        message: expect.stringContaining('exited with code 3 during AI reference image sourcing'),
      }),
    );
  });

  it('kills the timed-out child on the default (longer-than-identification) timeout', async () => {
    // Fake timers plus a child that never settles make the default's exact
    // length observable, same technique as ompRunner.ts's own default-timeout
    // test — proving this runner really does use its own, longer default
    // rather than silently inheriting ompRunner.ts's 120s one.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fakePid = 5252525;
    const child = neverSettlingFakeChild(fakePid);

    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    const promise = runner.runOmpImageSourcing('P', { spawnFn: () => child });
    promise.then(
      () => { state = 'resolved'; },
      () => { state = 'rejected'; },
    );

    await vi.advanceTimersByTimeAsync(runner.DEFAULT_OMP_SOURCING_TIMEOUT_MS - 1);
    expect(state).toBe('pending');
    expect(killSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe('rejected');
    await expect(promise).rejects.toThrow(
      expect.objectContaining({
        statusCode: 504,
        message: expect.stringContaining(`AI reference image sourcing timed out after ${runner.DEFAULT_OMP_SOURCING_TIMEOUT_MS}ms`),
      }),
    );
    expect(killSpy).toHaveBeenCalledWith(-fakePid, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('defines a sourcing timeout longer than ompRunner.ts identification default', () => {
    expect(runner.DEFAULT_OMP_SOURCING_TIMEOUT_MS).toBeGreaterThan(DEFAULT_OMP_TIMEOUT_MS);
  });

  it('does not time out a call that finishes inside the window', async () => {
    const stdout = await runner.runOmpImageSourcing('P', {
      timeoutMs: 5_000,
      spawnFn: nodeSpawn('process.stdout.write("fast")'),
    });

    expect(stdout).toBe('fast');
  });
});

describe('setOmpSourcingRunnerOverride / getOmpSourcingRunner', () => {
  it('falls back to the real runner when no override is installed', () => {
    expect(runner.getOmpSourcingRunner()).toBe(runner.runOmpImageSourcing);
  });

  it('returns the installed override instead of the real runner', () => {
    const fake: runner.OmpSourcingRunner = async () => 'fake-stdout';

    runner.setOmpSourcingRunnerOverride(fake);

    expect(runner.getOmpSourcingRunner()).toBe(fake);
  });

  it('reverts to the real runner once the override is cleared', () => {
    const fake: runner.OmpSourcingRunner = async () => 'fake-stdout';
    runner.setOmpSourcingRunnerOverride(fake);

    runner.setOmpSourcingRunnerOverride(null);

    expect(runner.getOmpSourcingRunner()).toBe(runner.runOmpImageSourcing);
  });
});
