// Proof for AI part identification's non-HTTP half (apps/server/src/ai/*):
// the prompt builder, the response parser, the omp runner's process handling,
// and the identifyListingParts orchestration that joins them.
//
// The real `omp` binary is NEVER invoked here. Two seams keep it out:
// setOmpRunnerOverride replaces the whole runner for the orchestration tests,
// and the runner's own `spawnFn` option replaces node:child_process.spawn for
// the process-handling tests — which spawn this same Node binary
// (process.execPath) with a tiny inline script instead, so timeout/kill,
// ENOENT and non-zero-exit behavior is exercised against a real child process
// with no model session, no network and no credentials. (The real end-to-end
// omp call is verified out of band, the same way the eBay connector's real
// network behavior is.)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComponentCategory, Listing } from '../src/db/types.js';
import type * as PromptModule from '../src/ai/identificationPrompt.js';
import type * as ParserModule from '../src/ai/identificationParser.js';
import type * as RunnerModule from '../src/ai/ompRunner.js';
import type * as IdentificationModule from '../src/ai/partIdentification.js';
import type * as ErrorModule from '../src/error-handler.js';
import type * as LoggerModule from '../src/logger.js';
import type * as DbModule from '../src/db/index.js';
import type * as ClientModule from '../src/db/client.js';
import type * as SourcingRunnerModule from '../src/ai/ompSourcingRunner.js';
import { runMigrations } from '../src/db/migrate.js';

let dataDir: string;
let photosDir: string;
let emptyBinDir: string;
let prompt: typeof PromptModule;
let parser: typeof ParserModule;
let runner: typeof RunnerModule;
let identification: typeof IdentificationModule;
let AppError: typeof ErrorModule.AppError;
let logger: typeof LoggerModule.logger;
let db: typeof DbModule;
let getConnection: typeof ClientModule.getConnection;
let sourcingRunner: typeof SourcingRunnerModule;

// Builds a Listing fixture; only the fields identification actually reads
// (title, description, photoPaths, id) matter, the rest are filler.
function listingFixture(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 'listing-1',
    sourceId: 'source-1',
    title: 'Gaming PC - Ryzen 5 5600X, RTX 3060',
    description: '16GB DDR4, 1TB NVMe, 650W PSU. Runs great.',
    listingUrl: null,
    askingPrice: 650,
    listingDate: '2026-09-01',
    status: 'open',
    acquisitionFees: 0,
    photoPaths: [],
    externalSource: null,
    externalItemId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// Builds a SpawnFn that runs this Node binary on `script` — a real child
// process that is not omp, used to exercise the runner's stdout/exit/timeout
// handling. The options are the ones production passed in, never a local
// copy, so every test built on this also proves the real spawn options
// (notably `detached: true`) still let stdout and exit codes through.
function nodeSpawn(script: string): RunnerModule.SpawnFn {
  return (_command, _args, options) => spawn(process.execPath, ['-e', script], options);
}

/**
 * Resolves true once `pid` no longer exists. Signal 0 performs the existence
 * check without delivering anything, and throws ESRCH when the process is
 * gone. Exception to the project's no-real-timers rule: the condition being
 * waited on is the OS reaping a process that is not this runner's child, so
 * there is no promise or event to await and no fake clock that can advance it.
 */
async function waitForProcessGone(pid: number, attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const tick = Promise.withResolvers<void>();
    setTimeout(() => tick.resolve(), 25);
    await tick.promise;
  }
  return false;
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

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'pc-parts-flipper-ai-test-'));
  process.env.DUCKDB_DATA_DIR = dataDir;
  photosDir = path.join(dataDir, 'photos');
  // An empty directory used as PATH, so `spawn('omp', ...)` fails ENOENT
  // without any chance of finding the real binary installed on this host.
  emptyBinDir = path.join(dataDir, 'empty-bin');
  await mkdir(emptyBinDir);
  // Dynamic import (same exception as db.test.ts/scan.test.ts): photoStorage's
  // PHOTOS_DIR is computed once at module-evaluation time from
  // DUCKDB_DATA_DIR, so a static import would capture the shared development
  // data directory before this beforeAll could redirect it.
  prompt = await import('../src/ai/identificationPrompt.js');
  parser = await import('../src/ai/identificationParser.js');
  runner = await import('../src/ai/ompRunner.js');
  identification = await import('../src/ai/partIdentification.js');
  ({ AppError } = await import('../src/error-handler.js'));
  ({ logger } = await import('../src/logger.js'));
  db = await import('../src/db/index.js');
  ({ getConnection } = await import('../src/db/client.js'));
  sourcingRunner = await import('../src/ai/ompSourcingRunner.js');
  await runMigrations(await getConnection());
  // Safety net, not an assertion target: identifyListingParts now attempts
  // reference-photo sourcing for an eligible part whose brand and partNumber
  // are both known, and the real runner would spawn the `omp` binary. Every
  // test here answers "not found" instead, so this suite still never makes a
  // real omp call and the behavior these tests assert is unchanged.
  installNoSourcingOverride();
});

// Reinstalled after each test, since afterEach clears the overrides.
function installNoSourcingOverride(): void {
  sourcingRunner.setOmpSourcingRunnerOverride(async () => '{"found":false,"url":null}');
}

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  runner.setOmpRunnerOverride(null);
  installNoSourcingOverride();
  delete process.env.AI_IDENTIFY_MODEL;
  delete process.env.AI_IDENTIFY_API_KEY;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('buildIdentificationPrompt', () => {
  it('enumerates every allowed category and forbids any other value', () => {
    const text = prompt.buildIdentificationPrompt(listingFixture());

    for (const category of ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'Cooler', 'Other']) {
      expect(text).toContain(category);
    }
    expect(text).toContain('MUST be exactly one of these values');
  });

  it('includes the listing title and description verbatim', () => {
    const listing = listingFixture({ title: 'Dell OptiPlex 7070 SFF', description: 'i7-9700, no GPU' });
    const text = prompt.buildIdentificationPrompt(listing);

    expect(text).toContain('Dell OptiPlex 7070 SFF');
    expect(text).toContain('i7-9700, no GPU');
  });

  it('marks an empty description explicitly rather than leaving a blank', () => {
    const text = prompt.buildIdentificationPrompt(listingFixture({ description: null }));

    expect(text).toContain('(none provided)');
  });

  it('instructs honest/conservative behavior, per-part basis, and raw-JSON-only output', () => {
    const text = prompt.buildIdentificationPrompt(listingFixture());

    // Honesty instruction — empirically what produces useful partial answers.
    expect(text).toContain('Be honest and conservative');
    expect(text).toContain('Do NOT guess');
    // Per-part basis.
    expect(text).toContain('"source"');
    expect(text).toContain('"text" if it came from the listing title/description only');
    // Output format.
    expect(text).toContain('RESPOND WITH ONLY RAW JSON');
    expect(text).toContain('No markdown, no code fences');
  });

  it('asks for brand and part number as separate fields and forbids guessing them', () => {
    const text = prompt.buildIdentificationPrompt(listingFixture());

    // The two fields must be requested by their exact JSON names — the parser
    // reads `brand`/`partNumber`, so a prompt asking for "model" instead would
    // silently produce nulls for every part.
    expect(text).toContain('"brand"');
    expect(text).toContain('"partNumber"');
    // Null-not-a-guess is the load-bearing half: these values become a sale
    // listing's title, so a hallucinated model number is worse than a blank.
    expect(text).toContain('Use JSON null for either one you cannot confidently support');
    expect(text).toContain('do NOT put a placeholder such as "Unknown" or "N/A"');
    // Description is narrowed rather than left as a prose restatement.
    expect(text).toContain('Do NOT restate the brand or model number there');
    // The response shape example must carry the fields too, including the
    // null case — the example is what the model actually copies.
    expect(text).toContain('"brand":"NVIDIA"');
    expect(text).toContain('"brand":null');
  });
});

describe('parseIdentificationResponse', () => {
  it('parses a well-formed raw JSON response', () => {
    const raw = JSON.stringify({
      parts: [{ category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3060', description: '12GB, tested working', confidence: 'high', source: 'both' }],
      notes: 'Photos look like stock images.',
    });

    expect(parser.parseIdentificationResponse(raw)).toEqual({
      parts: [{ category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3060', description: '12GB, tested working', confidence: 'high', source: 'both', identityCandidates: [] }],
      notes: 'Photos look like stock images.',
    });
  });

  it('passes an explicitly-null brand/partNumber through as null, with no warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Null here is the model correctly answering "I could not identify this",
    // which is the documented happy path — it must not be logged as a surprise.
    const raw = JSON.stringify({
      parts: [{ category: 'RAM', brand: null, partNumber: null, description: '2 DDR4 DIMMs, capacity not legible', confidence: 'low', source: 'image' }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].brand).toBeNull();
    expect(result.parts[0].partNumber).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('coerces a malformed brand/partNumber to null, logs it, and keeps the rest of the part', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // A number for brand and an object for partNumber: shapes the model was
    // never asked for. Dropping the `typeof === 'string'` guard would let the
    // number 42 reach the database as a brand; dropping the whole part would
    // throw away an otherwise usable suggestion.
    const raw = '{"parts":[{"category":"GPU","brand":42,"partNumber":{"x":1},"description":"12GB card","confidence":"high","source":"image"}],"notes":""}';

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].brand).toBeNull();
    expect(result.parts[0].partNumber).toBeNull();
    // The rest of the part survives the coercion.
    expect(result.parts[0].description).toBe('12GB card');
    expect(result.parts[0].category).toBe('GPU');
    // Accounted for, not silently dropped — and the log names which field.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'brand', value: 42 }),
      expect.stringContaining('non-string part identity field'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'partNumber' }),
      expect.stringContaining('non-string part identity field'),
    );
  });

  it('treats a blank brand/partNumber string as not-identified rather than empty text', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // An empty brand reaching the database would render as a leading space in
    // the default sale listing title, so blank must normalize to null.
    const raw = JSON.stringify({
      parts: [{ category: 'PSU', brand: '   ', partNumber: '', description: '650W', confidence: 'medium', source: 'text' }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].brand).toBeNull();
    expect(result.parts[0].partNumber).toBeNull();
  });

  it('strips a markdown code fence the model added despite being told not to', () => {
    const raw = '```json\n{"parts":[{"category":"CPU","description":"Ryzen 5 5600X","confidence":"medium","source":"text"}],"notes":""}\n```';

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].category).toBe('CPU');
    expect(result.notes).toBe('');
  });

  it('coerces an unrecognized category to Other and logs a warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      parts: [{ category: 'Graphics Card', description: 'RTX 3060', confidence: 'high', source: 'image' }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].category).toBe('Other');
    // The description must survive the coercion — it carries what the model
    // actually identified, which is the whole value of keeping the row.
    expect(result.parts[0].description).toBe('RTX 3060');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Graphics Card' }),
      expect.stringContaining('unrecognized component category'),
    );
  });

  it('keeps a recognized category untouched and logs no warning', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ parts: [{ category: 'PSU', description: '650W', confidence: 'low', source: 'text' }], notes: '' });

    expect(parser.parseIdentificationResponse(raw).parts[0].category).toBe('PSU');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('defaults an unrecognized confidence and source to the least assertive values', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({ parts: [{ category: 'RAM', description: '2x8GB', confidence: 'pretty sure', source: 'vibes' }] });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].confidence).toBe('low');
    expect(result.parts[0].source).toBe('text');
    // A missing `notes` key is normalized to an empty string, never undefined.
    expect(result.notes).toBe('');
  });

  it('drops non-object part entries and coerces a non-string description to an empty string', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Three entries, two of them shapes normalizePart cannot read: a bare
    // string and a null. Both guards are deliberate defence against model
    // output, and neither had a test that would notice its removal — dropping
    // the filter would yield three parts here, and dropping the `typeof
    // description === 'string'` check would leave description as the number 42.
    const raw = '{"parts":["RTX 3060", null, {"category":"GPU","description":42,"confidence":"high","source":"image"}],"notes":""}';

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts).toEqual([{ category: 'GPU', brand: null, partNumber: null, description: '', confidence: 'high', source: 'image', identityCandidates: [] }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entry: 'RTX 3060' }),
      expect.stringContaining('non-object part entry'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ entry: null }),
      expect.stringContaining('non-object part entry'),
    );
  });

  it('throws AppError(502) for output that is not JSON at all', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(() => parser.parseIdentificationResponse("I'm sorry, I can't help with that.")).toThrow(
      expect.objectContaining({ statusCode: 502, message: expect.stringContaining('did not return valid JSON') }),
    );
  });

  it('throws AppError(502) for JSON with no parts array rather than returning an empty result', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    // Message-specific, not just type-specific: the "no parts array" guard and
    // the "not JSON" guard above both throw AppError(502), so asserting on the
    // type alone would stay green if this guard were deleted.
    expect(() => parser.parseIdentificationResponse('{"notes":"nothing found"}')).toThrow(
      expect.objectContaining({ statusCode: 502, message: expect.stringContaining('missing a "parts" array') }),
    );
  });
});

describe('parseIdentificationResponse identityCandidates', () => {
  it('coerces a non-array or absent identityCandidates to an empty list', () => {
    const absent = JSON.stringify({
      parts: [{ category: 'GPU', description: 'RTX 3060', confidence: 'high', source: 'image' }],
      notes: '',
    });
    expect(parser.parseIdentificationResponse(absent).parts[0].identityCandidates).toEqual([]);

    // A non-array value (string) rather than an array — the same "not the
    // shape asked for" defence as the field-level coercions above.
    const wrongShape = JSON.stringify({
      parts: [{ category: 'GPU', description: 'RTX 3060', confidence: 'high', source: 'image', identityCandidates: 'not an array' }],
      notes: '',
    });
    expect(parser.parseIdentificationResponse(wrongShape).parts[0].identityCandidates).toEqual([]);
  });

  it('drops a candidate entry whose brand and partNumber both coerce to null', () => {
    // One real candidate alongside one that carries no information at all —
    // only the real one may survive into the result.
    const raw = JSON.stringify({
      parts: [{
        category: 'GPU', description: 'RTX 3060', confidence: 'medium', source: 'text',
        identityCandidates: [{ brand: 'NVIDIA', partNumber: 'RTX 3060' }, { brand: null, partNumber: null }],
      }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].identityCandidates).toEqual([{ brand: 'NVIDIA', partNumber: 'RTX 3060' }]);
  });

  it('coerces a malformed brand/partNumber inside one candidate entry to null and logs it, same as the primary field', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const raw = JSON.stringify({
      parts: [{
        category: 'GPU', description: 'RTX 3060', confidence: 'medium', source: 'text',
        identityCandidates: [{ brand: 42, partNumber: 'RTX 3060' }],
      }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].identityCandidates).toEqual([{ brand: null, partNumber: 'RTX 3060' }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ field: 'brand', value: 42 }),
      expect.stringContaining('non-string part identity field'),
    );
  });

  it('dedupes exact-duplicate {brand,partNumber} candidate pairs, keeping the first occurrence', () => {
    const raw = JSON.stringify({
      parts: [{
        category: 'GPU', description: 'RTX 3060', confidence: 'medium', source: 'text',
        identityCandidates: [
          { brand: 'NVIDIA', partNumber: 'RTX 3060' },
          { brand: 'NVIDIA', partNumber: 'RTX 3060' },
          { brand: 'EVGA', partNumber: 'RTX 3060' },
        ],
      }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    // Three entries in, one exact duplicate collapsed — the first
    // occurrence (highest-ranked) is the one kept.
    expect(result.parts[0].identityCandidates).toEqual([
      { brand: 'NVIDIA', partNumber: 'RTX 3060' },
      { brand: 'EVGA', partNumber: 'RTX 3060' },
    ]);
  });

  it('truncates more than MAX_IDENTITY_CANDIDATES entries to the cap and logs a Warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Five distinct candidates — one more than the cap of four.
    const identityCandidates = ['A', 'B', 'C', 'D', 'E'].map((brand) => ({ brand, partNumber: null }));
    const raw = JSON.stringify({
      parts: [{ category: 'GPU', description: 'RTX 3060', confidence: 'low', source: 'text', identityCandidates }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].identityCandidates).toHaveLength(prompt.MAX_IDENTITY_CANDIDATES);
    expect(result.parts[0].identityCandidates).toEqual([
      { brand: 'A', partNumber: null },
      { brand: 'B', partNumber: null },
      { brand: 'C', partNumber: null },
      { brand: 'D', partNumber: null },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ count: 5, max: prompt.MAX_IDENTITY_CANDIDATES }),
      expect.stringContaining('more identityCandidates than allowed'),
    );
  });

  it('keeps exactly MAX_IDENTITY_CANDIDATES entries untruncated with no Warn', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const identityCandidates = ['A', 'B', 'C', 'D'].map((brand) => ({ brand, partNumber: null }));
    const raw = JSON.stringify({
      parts: [{ category: 'GPU', description: 'RTX 3060', confidence: 'low', source: 'text', identityCandidates }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].identityCandidates).toHaveLength(4);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not exclude a candidate matching the part\'s own primary brand/partNumber — that exclusion is display-side, not the parser\'s', () => {
    // normalizePart coerces `brand`/`partNumber` and `identityCandidates`
    // independently with no cross-check between them; the primary-pair
    // exclusion named in Requirement 5 is applied later, at display time, by
    // formatIdentityCandidates (packages/shared/src/partIdentity.ts) — not
    // here. Proven directly: a candidate identical to the part's own primary
    // identity survives untouched into the parsed result.
    const raw = JSON.stringify({
      parts: [{
        category: 'GPU', brand: 'NVIDIA', partNumber: 'RTX 3060', description: '12GB', confidence: 'high', source: 'both',
        identityCandidates: [{ brand: 'NVIDIA', partNumber: 'RTX 3060' }, { brand: 'EVGA', partNumber: 'RTX 3060' }],
      }],
      notes: '',
    });

    const result = parser.parseIdentificationResponse(raw);

    expect(result.parts[0].brand).toBe('NVIDIA');
    expect(result.parts[0].partNumber).toBe('RTX 3060');
    expect(result.parts[0].identityCandidates).toEqual([
      { brand: 'NVIDIA', partNumber: 'RTX 3060' },
      { brand: 'EVGA', partNumber: 'RTX 3060' },
    ]);
  });
});

describe('buildOmpArgs', () => {
  it('builds the verified argv shape with one @path per image', () => {
    const args = runner.buildOmpArgs('PROMPT TEXT', ['/abs/a.jpg', '/abs/b.jpg']);

    expect(args).toEqual(['-p', '--no-tools', 'PROMPT TEXT', '@/abs/a.jpg', '@/abs/b.jpg']);
  });

  it('prepends --model/--api-key only when the env vars are set, read at call time', () => {
    expect(runner.buildOmpArgs('P', [])).toEqual(['-p', '--no-tools', 'P']);

    process.env.AI_IDENTIFY_MODEL = 'some-model';
    process.env.AI_IDENTIFY_API_KEY = 'secret-key';

    expect(runner.buildOmpArgs('P', [])).toEqual(['--model=some-model', '--api-key=secret-key', '-p', '--no-tools', 'P']);
  });
});

describe('runOmpIdentification process handling', () => {
  it('resolves with the child process stdout and ignores stderr', async () => {
    const script = 'process.stderr.write("progress noise");process.stdout.write(JSON.stringify({parts:[],notes:"ok"}))';

    const stdout = await runner.runOmpIdentification('P', [], { timeoutMs: 10_000, spawnFn: nodeSpawn(script) });

    expect(stdout).toBe('{"parts":[],"notes":"ok"}');
  });

  it('passes the exact command, argv and spawn options — and nothing else — to spawn', async () => {
    const spawnFn = vi.fn(nodeSpawn('process.stdout.write("{}")'));

    await runner.runOmpIdentification('PROMPT', ['/abs/a.jpg'], { timeoutMs: 10_000, spawnFn });

    // Deliberately an exact match rather than expect.anything() for the
    // options: the prompt text is built from attacker-controlled listing
    // title/description (populated by eBay scans), so adding `shell: true`
    // here would turn a title containing `; rm -rf ...` into a live command
    // injection. A loose matcher would stay green through exactly that
    // change; this one fails if `shell`, `env`, `cwd` or any other key is
    // added, and fails if `detached` (the process-group kill below depends
    // on it) is dropped.
    expect(spawnFn).toHaveBeenCalledWith('omp', ['-p', '--no-tools', 'PROMPT', '@/abs/a.jpg'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
  });

  it('rejects with a clear AppError when the binary is not found (ENOENT)', async () => {
    const spawnFn = () => spawn('definitely-not-a-real-binary-xyz', [], { stdio: ['ignore', 'pipe', 'ignore'] });

    await expect(runner.runOmpIdentification('P', [], { timeoutMs: 10_000, spawnFn })).rejects.toThrow(
      expect.objectContaining({ statusCode: 502, message: expect.stringContaining('not found') }),
    );
  });

  it('rejects with the exit code when the CLI exits non-zero', async () => {
    const spawnFn = nodeSpawn('process.exit(3)');

    await expect(runner.runOmpIdentification('P', [], { timeoutMs: 10_000, spawnFn })).rejects.toThrow(
      expect.objectContaining({ statusCode: 502, message: expect.stringContaining('exited with code 3') }),
    );
  });

  it('kills the timed-out child and the grandchild it spawned, then rejects 504', async () => {
    // Deliberately real OS processes and a real (short) timer rather than fake
    // timers: what is under test is that the timeout SIGKILLs a whole process
    // *tree*, which no faked clock can observe. The child spawns a grandchild,
    // reports its pid on stdout and then wedges; neither process ever exits on
    // its own, so the timeout path is the only way this call can settle.
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'grandchild.unref();',
      'process.stdout.write(String(grandchild.pid));',
      'setInterval(() => {}, 1000);',
    ].join('\n');

    let grandchildPid = 0;
    const childExit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    // The spawn options are passed straight through from production instead of
    // being hardcoded here, which is what makes this a test of production's
    // `detached: true`: without it the child leads no process group, the
    // negated-pid kill finds no such group, and the grandchild survives.
    const spawnFn: RunnerModule.SpawnFn = (_command, _args, options) => {
      const child = spawn(process.execPath, ['-e', childScript], options);
      child.on('exit', (code, signal) => childExit.resolve({ code, signal }));
      child.stdout?.on('data', (chunk: Buffer) => {
        grandchildPid = Number(String(chunk));
      });
      return child;
    };

    const started = Date.now();
    await expect(runner.runOmpIdentification('P', [], { timeoutMs: 1_000, spawnFn })).rejects.toThrow(
      expect.objectContaining({ statusCode: 504, message: expect.stringContaining('timed out after 1000ms') }),
    );
    // Bounded: proves the rejection came from the 1s timer, not from the
    // process eventually ending by itself (it never would).
    expect(Date.now() - started).toBeLessThan(10_000);
    // The direct child died by signal, not by exiting on its own.
    expect(await childExit.promise).toEqual({ code: null, signal: 'SIGKILL' });
    // Guards the rest of the assertion: a zero pid would mean the child never
    // got as far as spawning a grandchild, making its "death" meaningless.
    expect(grandchildPid).toBeGreaterThan(0);
    expect(await waitForProcessGone(grandchildPid)).toBe(true);
  }, 30_000);

  it('applies the 240-second default timeout when no timeoutMs is given', async () => {
    // Every other runner test passes an explicit short timeoutMs, so without
    // this one the production default is never executed and could be lowered,
    // raised or deleted with the suite still green. Fake timers plus a child
    // that never settles make the default's exact length observable.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const fakePid = 4242424;
    const child = neverSettlingFakeChild(fakePid);

    let state: 'pending' | 'resolved' | 'rejected' = 'pending';
    const promise = runner.runOmpIdentification('P', [], { spawnFn: () => child });
    promise.then(
      () => { state = 'resolved'; },
      () => { state = 'rejected'; },
    );

    // One millisecond short of the default: still waiting. Fails if the
    // constant is ever lowered.
    await vi.advanceTimersByTimeAsync(runner.DEFAULT_OMP_TIMEOUT_MS - 1);
    expect(state).toBe('pending');
    expect(killSpy).not.toHaveBeenCalled();

    // One millisecond more: timed out. Fails if the constant is raised or the
    // default removed.
    await vi.advanceTimersByTimeAsync(1);
    expect(state).toBe('rejected');
    await expect(promise).rejects.toThrow(
      expect.objectContaining({ statusCode: 504, message: expect.stringContaining('timed out after 240000ms') }),
    );
    // The group kill, not the direct kill: a negated pid signals the whole group.
    expect(killSpy).toHaveBeenCalledWith(-fakePid, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('pins the default timeout to the documented 240 seconds', () => {
    expect(runner.DEFAULT_OMP_TIMEOUT_MS).toBe(240_000);
  });

  it('falls back to node:child_process.spawn when no spawnFn is injected', async () => {
    // The `?? spawn` default branch, exercised without ever running the real
    // omp binary: with PATH pointing at an empty directory the lookup fails
    // with ENOENT before any process starts, which can only happen if the real
    // spawn was reached. Deleting the `?? spawn` fallback makes this a
    // TypeError instead, and the assertion fails.
    const realPath = process.env.PATH;
    process.env.PATH = emptyBinDir;
    try {
      await expect(runner.runOmpIdentification('P', [], { timeoutMs: 10_000 })).rejects.toThrow(
        expect.objectContaining({ statusCode: 502, message: expect.stringContaining("requires the 'omp' CLI on PATH") }),
      );
    } finally {
      process.env.PATH = realPath;
    }
  }, 15_000);

  it('does not time out a call that finishes inside the window', async () => {
    // The other direction of the timeout: a fast child under the same short
    // timeout must resolve normally, proving the timer only fires on a genuine
    // overrun rather than rejecting every call.
    const stdout = await runner.runOmpIdentification('P', [], {
      timeoutMs: 5_000,
      spawnFn: nodeSpawn('process.stdout.write("fast")'),
    });

    expect(stdout).toBe('fast');
  });
});

describe('identifyListingParts', () => {
  // Seeds one reference photo row for category/brand/partNumber via a
  // throwaway Source+Listing (satisfies the FK promoteReferencePhotos needs),
  // the minimal real-DB setup the second-pass tests below need since
  // findReferencePhotosForLeads hits the real DuckDB connection, not a mock.
  let seedCounter = 0;
  // Returns the generated photoPath so callers that need to trace which
  // specific reference photo a seed call produced (e.g. to confirm a
  // round-robin trim's per-part survivors) can do so without guessing at
  // the shared counter's current value.
  async function seedReferencePhoto(category: ComponentCategory, brand: string, partNumber: string): Promise<string> {
    seedCounter += 1;
    const photoPath = `/photos/seed-ref-${seedCounter}.jpg`;
    const source = await db.createSource({ name: `ref-source-${seedCounter}`, platformType: 'other', url: null, notes: null });
    const refListing = await db.createListing({
      sourceId: source.id,
      title: `ref-listing-${seedCounter}`,
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [photoPath],
    });
    await db.promoteReferencePhotos(refListing.id, [photoPath], category, brand, partNumber);
    return photoPath;
  }

  it('resolves photoPaths to absolute PHOTOS_DIR paths and parses the runner output', async () => {
    const calls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      calls.push({ prompt: promptText, images: imagePaths });
      return JSON.stringify({
        parts: [{ category: 'Storage', brand: 'Samsung', partNumber: '980 PRO', description: '1TB, serial not visible', confidence: 'medium', source: 'text' }],
        notes: 'Serial not visible.',
      });
    });

    const listing = listingFixture({ photoPaths: ['photos/listing-1-aaa.jpg', 'photos/listing-1-bbb.png'] });
    const result = await identification.identifyListingParts(listing);

    expect(result).toEqual({
      parts: [{ category: 'Storage', brand: 'Samsung', partNumber: '980 PRO', description: '1TB, serial not visible', confidence: 'medium', source: 'text', identityCandidates: [] }],
      notes: 'Serial not visible.',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].images).toEqual([
      path.join(photosDir, 'listing-1-aaa.jpg'),
      path.join(photosDir, 'listing-1-bbb.png'),
    ]);
    // The prompt the runner receives is the real built prompt, not a stub.
    expect(calls[0].prompt).toContain(listing.title);
  });

  it('calls the model with no images for a listing that has no photos', async () => {
    const seen: Array<readonly string[]> = [];
    runner.setOmpRunnerOverride(async (_promptText, imagePaths) => {
      seen.push(imagePaths);
      return '{"parts":[],"notes":""}';
    });

    const result = await identification.identifyListingParts(listingFixture({ photoPaths: [] }));

    expect(seen[0]).toEqual([]);
    expect(result.parts).toEqual([]);
  });

  it('propagates a runner failure as an error rather than an empty result', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    runner.setOmpRunnerOverride(async () => {
      throw new AppError("AI part identification requires the 'omp' CLI on PATH, but it was not found", 502);
    });

    await expect(identification.identifyListingParts(listingFixture())).rejects.toThrow(
      expect.objectContaining({ statusCode: 502, message: expect.stringContaining('not found') }),
    );
  });
  it('skips second pass when all parts are fully settled (non-null brand+partNumber, empty candidates)', async () => {
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      return JSON.stringify({
        parts: [
          {
            category: 'Storage',
            brand: 'Samsung',
            partNumber: '980 PRO',
            description: '1TB',
            confidence: 'high',
            source: 'text',
            identityCandidates: [],
          },
        ],
        notes: '',
      });
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(1);
    expect(result.parts[0].brand).toBe('Samsung');
    expect(result.parts[0].partNumber).toBe('980 PRO');
  });

  it('skips second pass when no eligible parts have references available', async () => {
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'Graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      throw new Error('Should not reach second pass');
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(1);
    expect(result.parts[0].brand).toBeNull();
    expect(result.parts[0].partNumber).toBeNull();
  });

  it('performs second pass when an eligible part exists and references are available', async () => {
    await seedReferencePhoto('GPU', 'NVIDIA', 'RTX 3060');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'NVIDIA graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        {
          partIndex: 0,
          brand: 'NVIDIA',
          partNumber: 'RTX 3060',
          identityCandidates: [],
        },
      ]);
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    expect(result.parts[0].brand).toBe('NVIDIA');
    expect(result.parts[0].partNumber).toBe('RTX 3060');
  });

  it('never calls onStage when every part is fully settled (no eligible parts, no second pass)', async () => {
    runner.setOmpRunnerOverride(async () => JSON.stringify({
      parts: [
        {
          category: 'Storage',
          brand: 'Samsung',
          partNumber: '980 PRO',
          description: '1TB',
          confidence: 'high',
          source: 'text',
          identityCandidates: [],
        },
      ],
      notes: '',
    }));

    const stages: string[] = [];
    await identification.identifyListingParts(listingFixture(), undefined, (stage) => stages.push(stage));

    expect(stages).toEqual([]);
  });

  it("calls onStage('sourcing_references') once, and never 'comparing', when an eligible part exists but no references are found", async () => {
    // Category 'Other' is deliberately never seeded by any other test in
    // this file/DB (unlike 'GPU' etc., which several tests seed): a
    // null-brand lead matches ANY row in its category
    // (findReferencePhotosForLeads), so a shared category here would pick
    // up an unrelated test's seeded reference and spuriously trigger the
    // second pass this test asserts never runs.
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      return JSON.stringify({
        parts: [
          {
            category: 'Other',
            brand: null,
            partNumber: null,
            description: 'Unidentifiable component',
            confidence: 'low',
            source: 'image',
            identityCandidates: [],
          },
        ],
        notes: '',
      });
    });

    const stages: string[] = [];
    await identification.identifyListingParts(listingFixture(), undefined, (stage) => stages.push(stage));

    expect(ompCalls).toHaveLength(1);
    expect(stages).toEqual(['sourcing_references']);
  });

  it("calls onStage with 'sourcing_references' then 'comparing', in that order and exactly once each, when the second pass actually runs", async () => {
    await seedReferencePhoto('GPU', 'NVIDIA', 'RTX 3060');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'NVIDIA graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        { partIndex: 0, brand: 'NVIDIA', partNumber: 'RTX 3060', identityCandidates: [] },
      ]);
    });

    const stages: string[] = [];
    await identification.identifyListingParts(listingFixture(), undefined, (stage) => stages.push(stage));

    expect(ompCalls).toHaveLength(2);
    expect(stages).toEqual(['sourcing_references', 'comparing']);
  });

  it('applies per-part reference photo cap (MAX_REFERENCE_PHOTOS_PER_PART)', async () => {
    // Seed 4 distinct CPU references — one more than the per-part cap of 3 —
    // so the cap, not just "some references exist", is what's under test.
    await seedReferencePhoto('CPU', 'Intel', 'i5-10400');
    await seedReferencePhoto('CPU', 'Intel', 'i7-10700');
    await seedReferencePhoto('CPU', 'AMD', 'Ryzen 5 3600');
    await seedReferencePhoto('CPU', 'AMD', 'Ryzen 7 3700X');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'CPU',
              brand: null,
              partNumber: null,
              description: 'Processor',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([]);
    });

    const listing = listingFixture({ photoPaths: ['photos/test1.jpg'] });
    await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    // 1 listing photo + at most MAX_REFERENCE_PHOTOS_PER_PART (3) reference
    // photos, never all 4 seeded references.
    expect(ompCalls[1].images).toHaveLength(4);
  });

  it('merges candidates from first pass and uses them as leads for reference lookup', async () => {
    // Seeded under the identityCandidate's brand/partNumber (not the part's
    // own null partNumber), proving the candidate is actually used as a lead.
    await seedReferencePhoto('GPU', 'NVIDIA', 'RTX 3080');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: 'NVIDIA',
              partNumber: null,
              description: 'High-end GPU',
              confidence: 'medium',
              source: 'both',
              identityCandidates: [
                { brand: 'NVIDIA', partNumber: 'RTX 3080' },
                { brand: 'NVIDIA', partNumber: 'RTX 3090' },
              ],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        {
          partIndex: 0,
          brand: 'NVIDIA',
          partNumber: 'RTX 3080',
          identityCandidates: [],
        },
      ]);
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    expect(result.parts[0].partNumber).toBe('RTX 3080');
    expect(result.parts[0].identityCandidates).toEqual([]);
  });

  it('seeds reference photos and triggers second pass when references are available', async () => {
    // Set up database: create source, listing, and seed reference photos.
    const source = await db.createSource({
      name: 'Test reference source',
      platformType: 'other',
      url: null,
      notes: null,
    });
    const refListing = await db.createListing({
      sourceId: source.id,
      title: 'Reference GPU listing',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: ['/photos/ref-gpu.jpg'],
    });
    await db.promoteReferencePhotos(
      refListing.id,
      ['/photos/ref-gpu.jpg'],
      'GPU',
      'NVIDIA',
      'RTX 3060',
    );

    // Mock the OMP runner to return an unsettled part on first pass
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'Graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: 'Found graphics card.',
        });
      }
      return JSON.stringify([
        {
          partIndex: 0,
          brand: 'NVIDIA',
          partNumber: 'RTX 3060',
          identityCandidates: [],
        },
      ]);
    });

    const testListing = listingFixture();
    const result = await identification.identifyListingParts(testListing);

    expect(ompCalls).toHaveLength(2);
    expect(result.parts[0].brand).toBe('NVIDIA');
    expect(result.parts[0].partNumber).toBe('RTX 3060');
    // Notes from first pass are preserved in final response
    expect(result.notes).toBe('Found graphics card.');
  });

  it('resolves a seed-sourced reference photo (reference-photos/seed/<file>, not photos/<file>) to a path that actually exists on disk', async () => {
    // Regression test for the bug where the second pass resolved every
    // reference photo via resolvePhotoPaths — which strips to basename and
    // re-homes under PHOTOS_DIR — so a seed-sourced reference photo stored
    // at reference-photos/seed/<file> (not photos/<file>) resolved to a
    // nonexistent path under PHOTOS_DIR and the real omp CLI exited 1. A
    // prior version of this suite only ever asserted the resolved path
    // *string*, which stayed green even though the path pointed nowhere;
    // this test writes a real file to disk and checks with fs.existsSync
    // that the path identifyListingParts actually hands the runner resolves
    // to it.
    const seedPhotoRelativePath = 'reference-photos/seed/regression-seed-photo.jpg';
    const seedPhotoAbsolutePath = path.join(dataDir, seedPhotoRelativePath);
    await mkdir(path.dirname(seedPhotoAbsolutePath), { recursive: true });
    await writeFile(seedPhotoAbsolutePath, Buffer.from('fake-jpeg-bytes'));

    const source = await db.createSource({
      name: 'Seed-sourced reference source',
      platformType: 'other',
      url: null,
      notes: null,
    });
    const refListing = await db.createListing({
      sourceId: source.id,
      title: 'Seed reference listing',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: [seedPhotoRelativePath],
    });
    await db.promoteReferencePhotos(
      refListing.id,
      [seedPhotoRelativePath],
      'GPU',
      'TestSeedPathRegression-Brand',
      'TestSeedPathRegression-Model',
    );

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              // Non-null, unique-to-this-test brand with a null partNumber:
              // makes the part eligible while restricting the reference
              // lookup to exactly this test's seeded row, so cross-test
              // GPU/NVIDIA reference photos seeded elsewhere in this shared
              // DB can't crowd this one out of the (limit=3) result set.
              brand: 'TestSeedPathRegression-Brand',
              partNumber: null,
              description: 'Graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        { partIndex: 0, brand: 'TestSeedPathRegression-Brand', partNumber: 'TestSeedPathRegression-Model', identityCandidates: [] },
      ]);
    });

    const listing = listingFixture({ photoPaths: ['photos/test1.jpg'] });
    await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    // Second-pass image list is [listing photo, reference photo]; the
    // reference photo entry is the one under test.
    const resolvedReferencePath = ompCalls[1].images[1];
    expect(existsSync(resolvedReferencePath)).toBe(true);
  });

  it('trims references per-part when total exceeds MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL using round-robin', async () => {
    // 5 eligible categories x 3 references each (the per-part cap) = 15
    // available references, one more than MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL
    // (12) can take by 3 — exercising the trim path, not just "some
    // references exist". Round-robin removal (one per part per pass) means
    // no single category's list is ever fully exhausted in favor of another.
    const categories: ComponentCategory[] = ['CPU', 'GPU', 'RAM', 'Storage', 'PSU'];
    for (const category of categories) {
      await seedReferencePhoto(category, 'BrandA', `${category}-model-1`);
      await seedReferencePhoto(category, 'BrandB', `${category}-model-2`);
      await seedReferencePhoto(category, 'BrandC', `${category}-model-3`);
    }

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: categories.map((category) => ({
            category,
            brand: null,
            partNumber: null,
            description: `${category} component`,
            confidence: 'low',
            source: 'image',
            identityCandidates: [],
          })),
          notes: '',
        });
      }
      // Confirms every one of the 5 categories still contributed at least
      // one reference to the prompt/second call — none was starved to zero
      // by the trim — by accepting an update for every partIndex.
      return JSON.stringify(
        categories.map((category, partIndex) => ({
          partIndex,
          brand: 'BrandA',
          partNumber: `${category}-model-1`,
          identityCandidates: [],
        })),
      );
    });

    const testListing = listingFixture({ photoPaths: ['photos/test1.jpg'] });
    const result = await identification.identifyListingParts(testListing);

    expect(ompCalls).toHaveLength(2);
    // 1 listing photo + exactly 12 (trimmed) reference photos, never the full 15.
    expect(ompCalls[1].images).toHaveLength(13);
    for (let i = 0; i < categories.length; i += 1) {
      expect(result.parts[i].brand).toBe('BrandA');
      expect(result.parts[i].partNumber).toBe(`${categories[i]}-model-1`);
    }
  });

  it('leaves eligible part with zero references untouched when other parts have references', async () => {
    // Set up database: create reference photos for only GPU, not CPU.
    const source = await db.createSource({
      name: 'Test source 2',
      platformType: 'other',
      url: null,
      notes: null,
    });
    const refListing = await db.createListing({
      sourceId: source.id,
      title: 'Reference GPU',
      description: null,
      listingUrl: null,
      askingPrice: 100,
      listingDate: '2024-05-01',
      acquisitionFees: 0,
      photoPaths: ['/photos/ref-gpu-2.jpg'],
    });
    await db.promoteReferencePhotos(
      refListing.id,
      ['/photos/ref-gpu-2.jpg'],
      'GPU',
      'NVIDIA',
      'RTX 3070',
    );

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'CPU',
              brand: null,
              partNumber: null,
              description: 'Processor',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'Graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        {
          partIndex: 1,
          brand: 'NVIDIA',
          partNumber: 'RTX 3070',
          identityCandidates: [],
        },
      ]);
    });

    const testListing = listingFixture();
    const result = await identification.identifyListingParts(testListing);

    // Second pass runs because GPU is eligible and has references.
    expect(ompCalls).toHaveLength(2);
    // CPU (partIndex 0) is left unchanged since it got no references.
    expect(result.parts[0].brand).toBeNull();
    expect(result.parts[0].partNumber).toBeNull();
    // GPU (partIndex 1) is updated by the second pass.
    expect(result.parts[1].brand).toBe('NVIDIA');
    expect(result.parts[1].partNumber).toBe('RTX 3070');
  });

  it('never sends a fully-settled part through the second pass, leaving it byte-for-byte unchanged, while an eligible sibling is still compared', async () => {
    // Storage is fully settled (non-null brand+partNumber, empty
    // identityCandidates) so Requirement 5 says it must never be looked up
    // or sent through the second pass. Seeding a reference that exactly
    // matches its own brand/partNumber means that if eligibility were ever
    // (wrongly) computed as "always eligible", this reference would surface
    // in the second call's prompt/images below - making the exclusion
    // observable, not just assumed.
    await seedReferencePhoto('Storage', 'Samsung', '980 PRO');
    // GPU is the genuinely eligible sibling; its lead is a non-null-brand
    // identityCandidate (not the null top-level brand) so the lookup hits
    // the brand-filtered query branch and can't pick up any other GPU
    // reference seeded by other tests in this same file/DB.
    await seedReferencePhoto('GPU', 'TestA-GPU-RefBrand', 'TestA-GPU-RefModel');

    const settledStoragePart = {
      category: 'Storage',
      brand: 'Samsung',
      partNumber: '980 PRO',
      description: '1TB NVMe drive',
      confidence: 'high',
      source: 'text',
      identityCandidates: [],
    };

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            settledStoragePart,
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'NVIDIA graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [{ brand: 'TestA-GPU-RefBrand', partNumber: 'TestA-GPU-RefModel' }],
            },
          ],
          notes: 'two parts found',
        });
      }
      return JSON.stringify([
        { partIndex: 1, brand: 'TestA-GPU-RefBrand', partNumber: 'TestA-GPU-RefModel', identityCandidates: [] },
      ]);
    });

    const listing = listingFixture({ photoPaths: ['photos/test1.jpg'] });
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    // The settled Storage part's category never appears in the comparison
    // prompt's "Part N: category" sections.
    expect(ompCalls[1].prompt).not.toContain('Storage');
    // Exactly 1 listing photo + GPU's 1 reference - Storage's (findable,
    // matching) reference never joined the image list.
    expect(ompCalls[1].images).toHaveLength(2);
    // Byte-for-byte unchanged from what the first pass reported.
    expect(result.parts[0]).toEqual(settledStoragePart);
    expect(result.parts[1].brand).toBe('TestA-GPU-RefBrand');
    expect(result.parts[1].partNumber).toBe('TestA-GPU-RefModel');
  });

  it('treats a part with only a null brand (non-null partNumber, no candidates) as eligible', async () => {
    await seedReferencePhoto('Motherboard', 'ASUS', 'Z790-UNIQUE');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'Motherboard',
              brand: null,
              partNumber: 'Z790-UNIQUE',
              description: 'ATX motherboard',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        { partIndex: 0, brand: 'ASUS', partNumber: 'Z790-UNIQUE', identityCandidates: [] },
      ]);
    });

    const result = await identification.identifyListingParts(listingFixture());

    expect(ompCalls).toHaveLength(2);
    expect(result.parts[0].brand).toBe('ASUS');
  });

  it('treats a part with only a null partNumber (non-null brand, no candidates) as eligible', async () => {
    await seedReferencePhoto('Cooler', 'Noctua', 'NH-D15-UNIQUE');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'Cooler',
              brand: 'Noctua',
              partNumber: null,
              description: 'Tower air cooler',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        { partIndex: 0, brand: 'Noctua', partNumber: 'NH-D15-UNIQUE', identityCandidates: [] },
      ]);
    });

    const result = await identification.identifyListingParts(listingFixture());

    expect(ompCalls).toHaveLength(2);
    expect(result.parts[0].partNumber).toBe('NH-D15-UNIQUE');
  });

  it('treats a part with non-empty identityCandidates (non-null brand and partNumber) as eligible', async () => {
    await seedReferencePhoto('Case', 'Corsair', '4000D-UNIQUE');
    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'Case',
              brand: 'Corsair',
              partNumber: '4000D-UNIQUE',
              description: 'Mid tower case',
              confidence: 'medium',
              source: 'both',
              identityCandidates: [{ brand: 'Corsair', partNumber: '4000D-Airflow-UNIQUE' }],
            },
          ],
          notes: '',
        });
      }
      return JSON.stringify([
        { partIndex: 0, brand: 'Corsair', partNumber: '4000D-UNIQUE', identityCandidates: [] },
      ]);
    });

    const result = await identification.identifyListingParts(listingFixture());

    expect(ompCalls).toHaveLength(2);
    // Narrowed from the first pass's 1-candidate list down to none, proving
    // this part was genuinely processed by the second pass (not merely
    // called).
    expect(result.parts[0].identityCandidates).toEqual([]);
  });

  it('trims references via genuine round-robin, not by draining one part to zero before touching others', async () => {
    // Each category's 3 reference leads use brand names scoped to this test
    // (category name baked in), so the brand-filtered query branch can never
    // pick up any other test's seeded rows for the same category - the
    // per-category count below is only ever counting this test's own data.
    const categories: ComponentCategory[] = ['CPU', 'GPU', 'RAM', 'Storage', 'PSU'];
    const pathsByCategory: string[][] = [];
    for (const category of categories) {
      pathsByCategory.push([
        await seedReferencePhoto(category, `${category}-A`, `${category}-A-pn`),
        await seedReferencePhoto(category, `${category}-B`, `${category}-B-pn`),
        await seedReferencePhoto(category, `${category}-C`, `${category}-C-pn`),
      ]);
    }

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: categories.map((category) => ({
            category,
            brand: null,
            partNumber: null,
            description: `${category} component`,
            confidence: 'low',
            source: 'image',
            // Non-null-brand candidates drive the lookup into the
            // brand-filtered query branch (see comment above).
            identityCandidates: [
              { brand: `${category}-A`, partNumber: null },
              { brand: `${category}-B`, partNumber: null },
              { brand: `${category}-C`, partNumber: null },
            ],
          })),
          notes: '',
        });
      }
      return JSON.stringify([]);
    });

    const testListing = listingFixture({ photoPaths: ['photos/test1.jpg'] });
    await identification.identifyListingParts(testListing);

    expect(ompCalls).toHaveLength(2);
    const imageBasenames = new Set(ompCalls[1].images.map((p) => path.basename(p)));
    const perCategoryCount = categories.map(
      (_category, index) => pathsByCategory[index].filter((p) => imageBasenames.has(path.basename(p))).length,
    );

    // 15 available references (5 categories x 3) capped to 12: exactly 3
    // must be dropped. A genuinely round-robin trim drops at most one
    // reference per category on this pass - the bug this guards against is
    // a sequential drain that empties one category entirely (0 kept) while
    // leaving the others fully untouched (3 kept each).
    for (const count of perCategoryCount) {
      expect(count).toBeGreaterThanOrEqual(2);
    }
    expect(perCategoryCount.reduce((a, b) => a + b, 0)).toBe(12);
    expect(perCategoryCount.filter((c) => c === 2)).toHaveLength(3);
    expect(perCategoryCount.filter((c) => c === 3)).toHaveLength(2);
  });

  it("merges a second-pass entry only onto the partIndex it names, leaving a sibling eligible part - that also had references attached but received no entry back - byte-for-byte unchanged", async () => {
    await seedReferencePhoto('Motherboard', 'TestE-MB-Brand', 'TestE-MB-Model');
    await seedReferencePhoto('Cooler', 'TestE-Cooler-Brand', 'TestE-Cooler-Model');

    const unsettledCoolerPart = {
      category: 'Cooler',
      brand: null,
      partNumber: null,
      description: 'Stock cooler',
      confidence: 'low',
      source: 'image',
      identityCandidates: [{ brand: 'TestE-Cooler-Brand', partNumber: null }],
    };

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'Motherboard',
              brand: null,
              partNumber: null,
              description: 'ATX motherboard',
              confidence: 'low',
              source: 'image',
              identityCandidates: [{ brand: 'TestE-MB-Brand', partNumber: null }],
            },
            unsettledCoolerPart,
          ],
          notes: '',
        });
      }
      // partIndex 0 gets a real update; partIndex 1 gets an explicit
      // noChange - parseVisualComparisonResponse filters noChange entries
      // out entirely, so the merge loop never sees partIndex 1 at all.
      return JSON.stringify([
        { partIndex: 0, brand: 'TestE-MB-Brand', partNumber: 'TestE-MB-Model', identityCandidates: [] },
        { partIndex: 1, noChange: true },
      ]);
    });

    const result = await identification.identifyListingParts(listingFixture({ photoPaths: ['photos/test1.jpg'] }));

    expect(ompCalls).toHaveLength(2);
    // Both parts had a reference attached and were sent through: 1 listing
    // photo + 1 Motherboard reference + 1 Cooler reference.
    expect(ompCalls[1].images).toHaveLength(3);
    expect(result.parts[0].brand).toBe('TestE-MB-Brand');
    expect(result.parts[0].partNumber).toBe('TestE-MB-Model');
    // Cooler was eligible, got a reference, was sent through the second
    // pass, and still came back byte-for-byte identical to the first pass's
    // own report - because no entry named partIndex 1 survived parsing.
    expect(result.parts[1]).toEqual(unsettledCoolerPart);
  });

  it('silently drops out-of-range partIndex from second-pass response without throwing', async () => {
    await seedReferencePhoto('GPU', 'TestOOR-Brand', 'TestOOR-Model');

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: null,
              partNumber: null,
              description: 'Graphics card',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      // Return an update with a valid partIndex (0) and one with an
      // out-of-range partIndex (999) that points past the end of the parts array.
      return JSON.stringify([
        {
          partIndex: 0,
          brand: 'TestOOR-Brand',
          partNumber: 'TestOOR-Model',
          identityCandidates: [],
        },
        {
          partIndex: 999,
          brand: 'HallucinatedBrand',
          partNumber: 'HallucinatedModel',
          identityCandidates: [],
        },
      ]);
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    // Both OMP calls should succeed (no throw)
    expect(ompCalls).toHaveLength(2);
    // Part 0 should be updated (it was in referencesByPart)
    expect(result.parts[0].brand).toBe('TestOOR-Brand');
    expect(result.parts[0].partNumber).toBe('TestOOR-Model');
    // No new parts added; array stays length 1
    expect(result.parts).toHaveLength(1);
  });

  it('silently drops updates targeting parts not in the eligible set (already fully settled)', async () => {
    // Set up two parts: one fully settled (will not be eligible), one unsettled (eligible)
    await seedReferencePhoto('Motherboard', 'TestNEligible-MB-Brand', 'TestNEligible-MB-Model');

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'RAM',
              brand: 'Corsair',
              partNumber: 'CMK16GX4M2B3200C16',
              description: 'RAM stick',
              confidence: 'high',
              source: 'text',
              identityCandidates: [],
            },
            {
              category: 'Motherboard',
              brand: null,
              partNumber: null,
              description: 'ATX motherboard',
              confidence: 'low',
              source: 'image',
              identityCandidates: [],
            },
          ],
          notes: '',
        });
      }
      // Try to update partIndex 0 (RAM - fully settled, never sent through second pass)
      // and partIndex 1 (Motherboard - eligible, sent through)
      return JSON.stringify([
        {
          partIndex: 0,
          brand: 'HallucinatedRAMBrand',
          partNumber: 'HallucinatedRAMModel',
          identityCandidates: [],
        },
        {
          partIndex: 1,
          brand: 'TestNEligible-MB-Brand',
          partNumber: 'TestNEligible-MB-Model',
          identityCandidates: [],
        },
      ]);
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    // Part 0 (RAM) must remain exactly as first pass reported (not mutated)
    expect(result.parts[0].brand).toBe('Corsair');
    expect(result.parts[0].partNumber).toBe('CMK16GX4M2B3200C16');
    // Part 1 (Motherboard) should be updated
    expect(result.parts[1].brand).toBe('TestNEligible-MB-Brand');
    expect(result.parts[1].partNumber).toBe('TestNEligible-MB-Model');
  });

  it('drops a second-pass update targeting a partIndex that was eligible overall but trimmed to zero references by round-robin, even though referencesByPart still holds that key', async () => {
    // GPU seeded with exactly 1 reference; the other four categories seeded
    // with exactly MAX_REFERENCE_PHOTOS_PER_PART (3) each - 13 references
    // total, one over MAX_TOTAL_REFERENCE_PHOTOS_PER_CALL (12). Round-robin
    // visits partIndex 0 (GPU, sorted first) before any other part, so the
    // single trim this overage requires drains GPU to exactly zero
    // references while every other category keeps all 3 of its own. GPU's
    // key still exists in referencesByPart afterward (mapped to an empty
    // array), but GPU is excluded from the final eligibleParts array
    // actually sent to the model - exactly the case the partIndex-validation
    // fix had to distinguish: filtering on referencesByPart.has(partIndex)
    // would wrongly accept an update for GPU here; filtering on
    // eligibleParts' own partIndex list correctly rejects it. Every lead
    // below uses a brand unique to this test so prior tests' leaked
    // same-category rows in the shared DB can never pad any of these counts.
    const categories: ComponentCategory[] = ['GPU', 'CPU', 'RAM', 'Storage', 'PSU'];
    const gpuRefPath = await seedReferencePhoto('GPU', 'TestTrim0-GPU', 'TestTrim0-GPU-pn');
    for (const category of categories.slice(1)) {
      await seedReferencePhoto(category, `TestTrim0-${category}-A`, `TestTrim0-${category}-A-pn`);
      await seedReferencePhoto(category, `TestTrim0-${category}-B`, `TestTrim0-${category}-B-pn`);
      await seedReferencePhoto(category, `TestTrim0-${category}-C`, `TestTrim0-${category}-C-pn`);
    }

    const originalGpuPart = {
      category: 'GPU',
      brand: null,
      partNumber: null,
      description: 'Graphics card',
      confidence: 'low',
      source: 'image',
      identityCandidates: [{ brand: 'TestTrim0-GPU', partNumber: null }],
    };

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            originalGpuPart,
            ...categories.slice(1).map((category) => ({
              category,
              brand: null,
              partNumber: null,
              description: `${category} component`,
              confidence: 'low',
              source: 'image',
              identityCandidates: [
                { brand: `TestTrim0-${category}-A`, partNumber: null },
                { brand: `TestTrim0-${category}-B`, partNumber: null },
                { brand: `TestTrim0-${category}-C`, partNumber: null },
              ],
            })),
          ],
          notes: '',
        });
      }
      // partIndex 0 (GPU, trimmed to zero) is a hallucinated update that must
      // be dropped; partIndex 1 (CPU, genuinely sent through with its 3
      // references intact) is a real update, proving the second pass itself
      // still ran normally and the drop is targeted, not a blanket no-op.
      return JSON.stringify([
        { partIndex: 0, brand: 'HallucinatedGPUBrand', partNumber: 'HallucinatedGPUModel', identityCandidates: [] },
        { partIndex: 1, brand: 'TestTrim0-CPU-A', partNumber: 'TestTrim0-CPU-A-pn', identityCandidates: [] },
      ]);
    });

    const listing = listingFixture({ photoPaths: ['photos/test1.jpg'] });
    const result = await identification.identifyListingParts(listing);

    expect(ompCalls).toHaveLength(2);
    // Exactly 12 reference photos (13 seeded minus the 1 round-robin trimmed) + 1 listing photo.
    expect(ompCalls[1].images).toHaveLength(13);
    // GPU's own (drained) reference photo never made it into the second call.
    expect(ompCalls[1].images.map((p) => path.basename(p))).not.toContain(path.basename(gpuRefPath));
    // The hallucinated update targeting the trimmed-to-zero GPU was dropped: byte-for-byte unchanged.
    expect(result.parts[0]).toEqual(originalGpuPart);
    // CPU's real update was applied normally, proving the second pass itself still ran correctly.
    expect(result.parts[1].brand).toBe('TestTrim0-CPU-A');
    expect(result.parts[1].partNumber).toBe('TestTrim0-CPU-A-pn');
  });

  it('treats a part with non-empty identityCandidates and non-null brand+partNumber as eligible for second pass', async () => {
    // Seed reference photo for the identityCandidates brand/partNumber
    await seedReferencePhoto('GPU', 'AlternativeGPU-Brand', 'AlternativeGPU-Model');

    const ompCalls: Array<{ prompt: string; images: readonly string[] }> = [];
    runner.setOmpRunnerOverride(async (promptText, imagePaths) => {
      ompCalls.push({ prompt: promptText, images: imagePaths });
      if (ompCalls.length === 1) {
        return JSON.stringify({
          parts: [
            {
              category: 'GPU',
              brand: 'PrimaryGPU-Brand',
              partNumber: 'PrimaryGPU-Model',
              description: 'Graphics card',
              confidence: 'medium',
              source: 'both',
              identityCandidates: [
                { brand: 'AlternativeGPU-Brand', partNumber: 'AlternativeGPU-Model' },
              ],
            },
          ],
          notes: '',
        });
      }
      // The second pass refines the identification using the alternative candidate
      return JSON.stringify([
        {
          partIndex: 0,
          brand: 'AlternativeGPU-Brand',
          partNumber: 'AlternativeGPU-Model',
          identityCandidates: [],
        },
      ]);
    });

    const listing = listingFixture();
    const result = await identification.identifyListingParts(listing);

    // The part was eligible (non-empty identityCandidates) and sent through second pass
    expect(ompCalls).toHaveLength(2);
    // The second pass updated it to the alternative brand/model
    expect(result.parts[0].brand).toBe('AlternativeGPU-Brand');
    expect(result.parts[0].partNumber).toBe('AlternativeGPU-Model');
    expect(result.parts[0].identityCandidates).toEqual([]);
  });

});
