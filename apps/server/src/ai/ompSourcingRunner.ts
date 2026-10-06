// Runs one AI reference-image-sourcing call by shelling out to the same
// `omp` CLI ompRunner.ts uses, but with tools ENABLED (no `--no-tools`) and
// no photo attached: the model is expected to browse the manufacturer's own
// site and report back a verified product photo URL, not just read an image
// handed to it. Reuses ompRunner.ts's spawn/timeout/kill machinery via
// runOmpProcess rather than reimplementing it.
import type { OmpRunOptions } from './ompRunner.js';
import { runOmpProcess } from './ompRunner.js';

/**
 * Hard ceiling on one sourcing call. A tools-enabled call has to browse the
 * web (search, open pages, inspect images) rather than just read an attached
 * photo, which is a fundamentally slower operation than plain identification
 * — set to 5 minutes (2.5x ompRunner.ts's 120s identification timeout) to
 * give real browsing round-trips room without letting a wedged call pin a
 * request open indefinitely.
 */
export const DEFAULT_OMP_SOURCING_TIMEOUT_MS = 300_000;

// Sourcing never attaches a photo (unlike identification's OmpRunner, which
// takes imagePaths), so it gets its own narrower runner contract rather than
// reusing ompRunner.ts's OmpRunner type.
export type OmpSourcingRunner = (promptText: string, options?: OmpRunOptions) => Promise<string>;

/**
 * Assembles the full argv for a sourcing call. Same env-based
 * `--model=`/`--api-key=` prefix as ompRunner.ts's buildOmpArgs, then `-p`
 * and the prompt — but, unlike identification, no `--no-tools` flag (tools
 * must stay enabled so the model can browse) and no `@<path>` image
 * arguments at all, since this call never attaches a photo.
 */
export function buildOmpSourcingArgs(promptText: string): string[] {
  const args: string[] = [];

  // Read lazily at call time, same convention as buildOmpArgs, so the
  // automated test suite never needs either variable set.
  const model = process.env.AI_IDENTIFY_MODEL ?? '';
  if (model) {
    args.push(`--model=${model}`);
  }

  const apiKey = process.env.AI_IDENTIFY_API_KEY ?? '';
  if (apiKey) {
    args.push(`--api-key=${apiKey}`);
  }

  // `-p` = non-interactive print mode. No `--no-tools`: this call needs the
  // model's browsing tool to actually reach the manufacturer's site.
  args.push('-p', promptText);

  return args;
}

/**
 * Spawns `omp` with tools enabled and no attached photo, collects its
 * stdout, and resolves with it. Shares runOmpProcess's spawn/timeout/kill
 * machinery with runOmpIdentification; only the argv shape, the (longer)
 * default timeout and the error-message context differ.
 */
export async function runOmpImageSourcing(promptText: string, options: OmpRunOptions = {}): Promise<string> {
  const args = buildOmpSourcingArgs(promptText);
  // Sourcing calls default to the longer, browsing-aware timeout rather than
  // ompRunner.ts's identification default.
  const resolvedOptions: OmpRunOptions = { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_OMP_SOURCING_TIMEOUT_MS };
  return runOmpProcess(args, resolvedOptions, 'AI reference image sourcing');
}

// Test seam, mirroring ompRunner.ts's pair exactly: the automated suite must
// never invoke the real omp binary (no live model session, no network), so
// it installs a fake runner here instead.
let runnerOverride: OmpSourcingRunner | null = null;

/** Installs a fake sourcing runner (or clears it, with null). Test-only. */
export function setOmpSourcingRunnerOverride(override: OmpSourcingRunner | null): void {
  runnerOverride = override;
}

/** The runner the sourcing feature actually calls: the override when one is installed, otherwise the real one. */
export function getOmpSourcingRunner(): OmpSourcingRunner {
  return runnerOverride ?? runOmpImageSourcing;
}
