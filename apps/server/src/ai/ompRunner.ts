// Runs one AI identification call by shelling out to the `omp` CLI, which is
// already installed and authenticated on the host. Split out of
// partIdentification.ts so the child-process machinery (argument assembly,
// timeout, kill, exit-code handling) is isolated behind one small async
// function the rest of the feature — and the test suite — can replace.
//
// Invocation shape was verified live against the real binary:
//   omp -p --no-tools "<prompt text>" @/abs/photo1.jpg @/abs/photo2.jpg
// With `--no-tools` and no `--mode=json`, stdout carries ONLY the model's
// final text response; the progress indicator goes to stderr, which is why
// stderr is discarded outright below rather than captured and parsed.
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { AppError } from '../error-handler.js';
import { logger } from '../logger.js';

// The CLI is expected on PATH (verified at ~/.local/bin/omp on this host). A
// missing binary surfaces as an ENOENT spawn error, handled explicitly below.
const OMP_BINARY = 'omp';

/**
 * Hard ceiling on one identification/comparison call. This call now runs
 * inside an asynchronous background job bounded by a worker-pool slot,
 * rather than behind an open HTTP request — the original 120-second value
 * was sized for a synchronous request waiting on a client connection, a
 * constraint that no longer applies. The new value is double the original:
 * generous for a slow-but-working call, while staying strictly below
 * DEFAULT_OMP_SOURCING_TIMEOUT_MS (300_000, ompSourcingRunner.ts) so that
 * file's own existing test asserting its timeout is strictly greater than
 * this one keeps passing.
 */
export const DEFAULT_OMP_TIMEOUT_MS = 240_000;

/** Narrow slice of node:child_process.spawn this module actually uses, so tests can substitute a fake. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Knobs the orchestrator never sets but tests do: a short timeout, and a fake spawn. */
export interface OmpRunOptions {
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

/** Contract of "run the model and give me its raw stdout", the seam identifyListingParts depends on. */
export type OmpRunner = (promptText: string, imagePaths: readonly string[], options?: OmpRunOptions) => Promise<string>;

/**
 * Assembles the full argv. Built as an array (never a shell string) so prompt
 * text containing quotes, newlines or backticks needs no escaping and can
 * never be reinterpreted as shell syntax.
 *
 * AI_IDENTIFY_MODEL / AI_IDENTIFY_API_KEY are read lazily, at call time — the
 * same convention ebayConnector.ts uses for EBAY_CLIENT_ID/EBAY_ENV — so the
 * automated test suite never needs either variable set, and a production
 * deployment can switch from the host's logged-in session to a real API key
 * with no code change. Unset means "let omp use its own default", which during
 * development is the host's logged-in subscription session.
 */
export function buildOmpArgs(promptText: string, imagePaths: readonly string[]): string[] {
  const args: string[] = [];

  const model = process.env.AI_IDENTIFY_MODEL ?? '';
  if (model) {
    args.push(`--model=${model}`);
  }

  const apiKey = process.env.AI_IDENTIFY_API_KEY ?? '';
  if (apiKey) {
    args.push(`--api-key=${apiKey}`);
  }

  // `-p` = non-interactive print mode, `--no-tools` = final text answer only.
  // Each photo is attached as a separate `@<absolute path>` argument.
  args.push('-p', '--no-tools', promptText);
  for (const imagePath of imagePaths) {
    args.push(`@${imagePath}`);
  }

  return args;
}

// SIGKILLs the timed-out child *and* anything it spawned. The child is started
// `detached`, which makes it the leader of a new process group whose id equals
// its pid, so a kill aimed at the negated pid reaches every descendant still in
// that group. Killing the child alone would leave a grandchild running,
// reparented to init (confirmed by experiment). `omp --no-tools` spawns no
// descendants today, so this is defence against a future change in the CLI
// rather than a live leak.
function killProcessGroup(child: ChildProcess): void {
  // No pid means the spawn itself failed; there is no group to signal.
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    // The group can legitimately be gone already (the child exited between the
    // timer firing and this call). Recoverable: fall back to the direct kill so
    // a surviving child is still stopped, and warn rather than error.
    logger.warn({ pid: child.pid, err }, 'Could not signal the omp process group; falling back to killing the child directly');
    child.kill('SIGKILL');
  }
}

/**
 * Spawns `omp` with the given argv, collects its stdout, and resolves with it.
 * Rejects with an AppError for every failure mode: binary missing / not on
 * PATH (ENOENT), non-zero exit, or exceeding the timeout (child killed
 * first). `errorContext` (e.g. "AI part identification", "AI reference
 * image sourcing") is interpolated into rejection messages, letting
 * runOmpIdentification and ompSourcingRunner.ts's runOmpImageSourcing share
 * this machinery without duplicating it.
 */
export async function runOmpProcess(args: string[], options: OmpRunOptions, errorContext: string): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OMP_TIMEOUT_MS;
  const spawnFn = options.spawnFn ?? spawn;
  logger.debug({ timeoutMs, argCount: args.length, errorContext }, 'Spawning omp');

  return new Promise<string>((resolve, reject) => {
    // stdin is not used; stderr is discarded at the OS level (it carries only
    // a progress indicator) so it can never fill a pipe buffer and stall the
    // child when output is long. `detached` puts the child in its own process
    // group so a timeout can take down any descendants with it (see
    // killProcessGroup); argv stays an array and `shell` is never set, so a
    // prompt built from attacker-controlled listing text can never be parsed
    // as a shell command.
    const child = spawnFn(OMP_BINARY, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true });

    let stdout = '';
    // Guards against double-settling: a timeout kill fires 'close' right
    // after the timeout rejection, and a spawn 'error' is also followed by
    // 'close' on some platforms.
    let settled = false;

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      settle();
    };

    const timer = setTimeout(() => {
      finish(() => {
        // SIGKILL rather than SIGTERM: a wedged model call is exactly the
        // case where a polite signal may be ignored, and nothing downstream
        // needs the child to shut down cleanly. Group-wide, so a descendant
        // cannot outlive the call that started it.
        killProcessGroup(child);
        reject(new AppError(`${errorContext} timed out after ${timeoutMs}ms`, 504));
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() => {
        const message =
          err.code === 'ENOENT'
            ? `${errorContext} requires the '${OMP_BINARY}' CLI on PATH, but it was not found`
            : `Failed to run '${OMP_BINARY}' for ${errorContext}: ${err.message}`;
        reject(new AppError(message, 502));
      });
    });

    child.on('close', (code: number | null) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new AppError(`'${OMP_BINARY}' exited with code ${String(code)} during ${errorContext} (is it installed and logged in?)`, 502));
      });
    });
  });
}

/**
 * Thin wrapper: builds the identification argv (prompt plus `@<path>` per
 * photo, `--no-tools`) and runs it via runOmpProcess. The seam
 * identifyListingParts' getOmpRunner() falls back to.
 */
export async function runOmpIdentification(
  promptText: string,
  imagePaths: readonly string[],
  options: OmpRunOptions = {},
): Promise<string> {
  const args = buildOmpArgs(promptText, imagePaths);
  return runOmpProcess(args, options, 'AI part identification');
}

// Test seam. The automated suite must never invoke the real omp binary (it
// would need a live model session, breaking this project's standing rule that
// the suite stays network/credential-independent), so it installs a fake
// runner here instead; the real integration is verified out of band, the same
// way the eBay connector's real-network behavior is.
let runnerOverride: OmpRunner | null = null;

/** Installs a fake runner (or clears it, with null). Test-only. */
export function setOmpRunnerOverride(override: OmpRunner | null): void {
  runnerOverride = override;
}

/** The runner identifyListingParts actually calls: the override when one is installed, otherwise the real one. */
export function getOmpRunner(): OmpRunner {
  return runnerOverride ?? runOmpIdentification;
}
