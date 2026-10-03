import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/web/test -> apps/web -> repo root, where eslint.config.mjs and the
// hoisted node_modules/.bin/eslint binary live. ESLint's flat config
// resolves file-pattern globs (e.g. 'apps/web/**/*.{ts,tsx}') relative to
// the process cwd, so eslint must be invoked from repoRoot for the
// apps/web-scoped import/no-restricted-paths rule to apply at all.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(webRoot, '../..');
const eslintBin = path.join(repoRoot, 'node_modules', '.bin', 'eslint');

// Fixture lives under apps/web/src so it matches the rule's own
// files: ['apps/web/**/*.{ts,tsx}'] glob; it is written immediately before
// each run and removed in afterEach so no fixture ever ships in the repo or
// trips `tsc -b`/`vite build` on apps/web's real source tree.
const fixtureDir = path.join(webRoot, 'src', '__eslint-fixtures__');
const fixturePath = path.join(fixtureDir, 'import-boundary-violation.ts');

/** One ESLint diagnostic as reported by `--format json`. */
interface EslintMessage {
  ruleId: string | null;
  message: string;
}

/** One file's worth of ESLint's `--format json` output. */
interface EslintFileReport {
  messages: EslintMessage[];
}

/**
 * Runs the repo's hoisted ESLint binary against a single file from
 * repoRoot (so the flat config's apps/web-scoped zone applies) and parses
 * its structured JSON report. Using --format json instead of grepping raw
 * stdout text means the assertions below key off ESLint's own ruleId/
 * message fields rather than incidental text formatting.
 */
function runEslintJson(targetFile: string): EslintFileReport[] {
  const relativeTarget = path.relative(repoRoot, targetFile);
  const result = spawnSync(eslintBin, ['--format', 'json', relativeTarget], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return JSON.parse(result.stdout) as EslintFileReport[];
}

// Proves T1's eslint.config.mjs import-boundary standing check: apps/web
// must never import apps/server modules directly. A file under apps/web
// that imports a real apps/server module (apps/server/src/logger.ts) must
// be flagged specifically by import/no-restricted-paths, not merely fail
// for some unrelated reason (e.g. a parse error), which is why this checks
// the exact ruleId and message rather than just a nonzero exit code.
describe('apps/web -> apps/server import boundary (T1 eslint.config.mjs)', () => {
  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it(
    'flags a relative import from apps/server with import/no-restricted-paths',
    async () => {
      await mkdir(fixtureDir, { recursive: true });
      await writeFile(
        fixturePath,
        "import { logger } from '../../../server/src/logger';\n\nexport const probe = logger;\n",
      );

      const [report] = runEslintJson(fixturePath);
      const boundaryMessages = report.messages.filter(
        (m) => m.ruleId === 'import/no-restricted-paths',
      );

      expect(boundaryMessages).toHaveLength(1);
      expect(boundaryMessages[0].message).toContain(
        'apps/web must never import apps/server modules directly',
      );
    },
    // Spawning a real ESLint process on a monorepo-wide flat config is
    // meaningfully slower than vitest's 5s default per-test timeout.
    90_000,
  );
});
