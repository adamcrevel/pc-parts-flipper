# Feature: harden-ai-json-parsing

Status: done
Cycle: 0 / 3
FeatureStarted: 2026-10-09T15:55:00Z
BaselineTests: 775
BaselineSuite: pass

## Goal

Both AI parsing stages of the identify-parts pipeline — first-pass identification
(`parseIdentificationResponse`) and the second-pass visual comparison
(`parseVisualComparisonResponse`) — share one fragile helper, `stripCodeFence()`
(`apps/server/src/ai/identificationParser.ts`). It only strips a markdown code fence when
the model's *entire* trimmed response starts with and ends with a bare ` ``` ` fence, with
nothing else. If the model adds even one sentence of commentary before or after the JSON
(e.g. "I can't fully confirm this, but here's my comparison:\n```json\n[...]\n```"), despite
the prompt's explicit "no commentary before or after" instruction, `stripCodeFence` returns
the text unchanged, `JSON.parse` fails on the mixed prose+JSON, and the whole job fails —
surfacing as `AppError(502, 'The AI model did not return a JSON array for visual comparison')`
or the equivalent identification-stage message — **even when the model produced a genuinely
valid JSON payload**, just not perfectly isolated at the exact string boundaries.

This has been observed as a real, repeated failure during live identify-parts runs. Confirmed
via source read (the anchoring regexes require an exact whole-string match) and via the test
suite (neither parser's tests exercise a fenced response, or any leading/trailing-prose case,
at all).

The fix adds a tolerant fallback: when a direct parse (after the existing fence-strip, which
stays as the cheap first attempt) still fails, extract the outermost bracketed JSON payload —
the substring from the first `{`/`[` to the last matching `}`/`]` in the raw text — and retry
parsing that substring before giving up. This recovers the common "valid JSON surrounded by
incidental prose" case without weakening the existing contract that genuinely malformed output
(no JSON present at all) still fails loudly with the same `AppError(502)`.

## Requirements

1. A model response that is a bare, well-formed JSON payload (today's only fully-working case)
   continues to parse exactly as it does today — this fix changes nothing about the
   already-succeeding path, confirmed by the existing test suite passing unchanged.
2. A model response that is a pure code-fence-wrapped JSON payload with nothing else
   (` ```json\n[...]\n``` `) continues to parse correctly via the existing `stripCodeFence`
   direct-parse path, unaffected by this fix — confirmed already covered by one pre-existing
   test per parser (found during implementation; the plan's original premise that this case had
   zero coverage was wrong, corrected in Assumption A6 rather than left standing).
3. A model response that includes incidental prose *before* a code-fenced or bare JSON payload
   (e.g. a caveat sentence) is successfully parsed by extracting the JSON payload rather than
   failing outright, in both the identification and visual-comparison parsers.
4. A model response that includes incidental prose *after* a code-fenced or bare JSON payload
   is successfully parsed the same way, in both parsers.
5. A model response containing no JSON payload at all (e.g. a plain-language refusal) still
   fails with the same `AppError(502)` it does today, with the same log line at Error level —
   this fix narrows false failures, it does not loosen the "structural failure is fatal"
   contract for genuinely unparseable output.
6. The new fallback extraction is only ever attempted after a direct parse has already failed
   — a response that already parses cleanly never pays its cost, and its own behavior is
   covered by a dedicated unit test independent of either parser (so a future change to one
   parser's call site can't silently stop exercising it).

## Standing Checks

- The whole test suite passes, and the test count stays at or above `BaselineTests` (775).
- `npm run lint` runs clean with no new violation.
- Any new public function or component this feature adds carries the same kind of header/block
  comment documentation already used elsewhere in the codebase, explaining its purpose and flow,
  not just a one-line label.
- No new code in `apps/web` imports directly from `apps/server` — the existing
  `import/no-restricted-paths` boundary (`eslint.config.mjs`), checked by
  `apps/web/test/eslint-import-boundary.test.ts`, holds for every file this feature adds or
  touches (not expected to be touched at all — this feature is apps/server only).

## Tasks

| id | description | role | depends_on | status | cycle | model | started_at | completed_at | expected_minutes | estimated_start | estimated_tokens | actual_tokens | ui | files_touched |
|----|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| T1 | Add a tolerant JSON-extraction fallback to `apps/server/src/ai/identificationParser.ts` (Req 1-6). New exported function `extractBracketedJson(text: string, kind: 'object' \| 'array'): string \| undefined` — finds the first occurrence of the opening bracket matching `kind` (`{` for `'object'`, `[` for `'array'`) and the LAST occurrence of its matching closing bracket in `text`, returning the substring between them inclusive, or `undefined` if either bracket is absent or the close precedes the open. Pure string search, no JSON validation of its own — the caller still runs the result through the existing `parseJson`/`JSON.parse` to confirm it is actually valid. Update the local `parseJson`-calling sites in both `parseIdentificationResponse` (this file, `kind: 'object'`) and `parseVisualComparisonResponse` (`visualComparisonParser.ts`, `kind: 'array'`) so that when the existing `stripCodeFence` + direct-parse attempt returns `undefined`, a second attempt runs `extractBracketedJson` against the ORIGINAL raw (unstripped) text and re-parses that substring before falling through to the existing `AppError(502)` — change nothing else about either function's existing structural-failure/field-coercion logic. Add unit tests: a standalone `describe('extractBracketedJson')` block (object and array kind, present/absent bracket cases, extra brackets inside the payload) independent of either parser; extend `partIdentification.test.ts`'s `parseIdentificationResponse` describe block with a pure-fence case, a leading-prose+fence case, a leading-prose+bare-object case, and a trailing-prose case; extend `visualComparison.test.ts`'s `parseVisualComparisonResponse` describe block with the equivalent four cases for the array shape. Confirm by reverting the fallback call (not the extraction function itself) that each new prose/fence test case genuinely fails without it — a real regression-catching addition, not a vacuous assertion. | builder | none | complete | 0 | | 2026-10-09T15:58:00Z | 2026-10-09T16:12:00Z | 30 | | 15000 | | no | apps/server/src/ai/identificationParser.ts, apps/server/src/ai/visualComparisonParser.ts, apps/server/test/partIdentification.test.ts, apps/server/test/visualComparison.test.ts |
| R1 | Review T1 against Req 1-6: confirm the fallback only runs after direct parse fails, operates on the original raw text (A5), genuinely malformed input still throws the unchanged AppError(502) (Req 5), the six new fallback-dependent tests and the standalone extractBracketedJson unit block are non-vacuous, and A6's correction is accurate by reading both pre-existing fence tests directly. | reviewer | T1 | complete | 0 | ImmenseBandicoot | 2026-10-09T16:20:00Z | 2026-10-09T16:27:22Z | 10 | 2026-10-09T16:20:00Z | 12000 | null | no | |
| TE1 | Test T1: run partIdentification.test.ts and visualComparison.test.ts in full; independently falsify (revert only the fallback trigger, confirm the six new tests fail, restore, confirm green) to prove they are genuine regression guards. Report real pass/fail output. | tester | T1 | complete | 0 | TameTahr | 2026-10-09T16:20:00Z | 2026-10-09T16:23:00Z | 10 | 2026-10-09T16:20:00Z | 8000 | null | no | |
| U1 | Operational verification (no UI, no browser UAT needed for a pure backend parsing fix): construct one real end-to-end throwaway script calling `parseIdentificationResponse` and `parseVisualComparisonResponse` directly with a handcrafted "prose + fenced JSON" string matching the exact shape of the real observed failure (`"I can't fully confirm this, but here's my comparison:\n```json\n[...]\n```"`), confirm both now parse successfully where they would have thrown before this fix (verified by running the same string against the pre-fix version via `git show` of the old file content), and confirm a genuinely contentless response (e.g. `"I'm sorry, I can't help with that."`) still throws the same `AppError(502)` unchanged. Report the real output. | uat | T1 | complete | 0 | orchestrator | 2026-10-09T16:29:00Z | 2026-10-09T16:31:00Z | 15 | 2026-10-09T16:29:00Z | null | null | no | |

## Assumptions

- A1 (cycle 0): `BaselineTests` is 775 (550 server + 215 web + 10 shared), `BaselineSuite: pass`,
  measured fresh in this worktree (`.worktrees/harden-ai-json-parsing`) after a plain `npm ci` at
  its root. Five flaky failures occurred on this baseline run under genuinely heavy concurrent
  load (a live 185-listing bulk identify-parts run was actively churning real `omp` AI calls on
  the same machine at measurement time) — all five (`identifyPartsRoute.test.ts`,
  `parts.test.ts`, `photoServing.test.ts`, `profit.test.ts`, `gracefulShutdown.test.ts`)
  independently re-ran clean in isolation immediately after, confirming environmental
  contention, not a real failure; not treated as a baseline defect.
- A2 (cycle 0): This is a pure `apps/server`-only backend fix (shared AI-response-parsing
  helper). No `apps/web` file is touched, no new API surface, no DB schema change, no shared
  package type change.
- A3 (cycle 0): No prototype task — this feature has no UI component at all (ui: no on its only
  task). No live-browser UAT either, for the same reason; U1 is a direct-call verification
  script instead, matching the convention used for this project's other backend-only parsing
  fixes.
- A4 (cycle 0): The fallback is scoped to "find outermost matching brackets in the raw text" —
  deliberately not a more elaborate recovery (e.g. attempting partial/truncated-JSON repair for
  a response cut off mid-generation by a token or time limit). A truncated response still fails
  loudly after this fix, which is correct: a *genuinely* incomplete JSON payload is not
  something this fix claims to recover, only a *complete* payload that is merely not perfectly
  isolated from surrounding prose.
- A5 (cycle 0): `extractBracketedJson` takes the raw, pre-`stripCodeFence` text as its input
  (not the already-fence-stripped text) when used as the fallback — searching for brackets
  directly is immune to whether a fence is present, wraps the payload, or not, so there is no
  need to run `stripCodeFence` before this fallback; it is independent of fence-handling
  entirely, which is also why it is tested as its own standalone unit rather than only through
  the two parsers that happen to call it.
- A6 (cycle 0) — corrects Requirement 2/the Goal's "never actually tested" premise: T1's
  implementation found one pre-existing test per parser already exercising a pure
  code-fence-wrapped response (`partIdentification.test.ts`'s "strips a markdown code fence the
  model added despite being told not to", `visualComparison.test.ts`'s "handles markdown-fenced
  JSON output") — both already passed before this fix and are unaffected by it, since
  `stripCodeFence`'s existing direct-parse path already handles a *pure* fence with nothing else
  around it. T1 therefore added only the three genuinely fallback-dependent cases per parser
  (leading-prose-plus-fence, leading-prose-plus-bare-payload, trailing-prose) rather than a
  fourth, redundant pure-fence case that would pass whether or not the new fallback exists — a
  correct engineering call, not a shortfall against the plan.
- A7 (cycle 0): Independently re-verified by the orchestrator (not solely on the builder's own
  report): the actual diff to both parser source files matches the plan's exact design (a
  `let parsed = parseJson(text)` followed by an `if (parsed === undefined)` fallback calling the
  new `extractBracketedJson(rawStdout, kind)` against the *original* raw text, re-parsing the
  result); the six new fallback-dependent tests plus a standalone six-case
  `extractBracketedJson` unit block (object/array extraction, missing-open, missing-close,
  wrong-kind-precedes, and "spans past extra same-kind brackets inside the payload" — this last
  one confirming `lastIndexOf` is genuinely used, not a naive first-close match) were all
  independently confirmed present via `git diff`. Main checkout confirmed to carry no stray
  writes from this dispatch (the builder's own self-caught-and-corrected worktree-placement
  mistake left main clean, verified directly). Full suite independently re-run: 562 server + 215
  web + 10 shared = 787, up from `BaselineTests` 775 by exactly +12 (the new tests, no drop
  elsewhere); three further flaky failures on this full run
  (`identifyPartsConcurrency.test.ts`, `purchases.test.ts`, `sales.test.ts`), all under the same
  genuine heavy concurrent load (`identify_parts` bulk run still active throughout), all
  independently re-confirmed passing in isolation. `npm run lint`: clean.

## Cycle Log

### Cycle 0
Trigger: initial

Results: T1 PASS (R1 PASS, TE1 PASS, mutation-proven). Standing gate PASS (787/787 total,
562 server + 215 web + 10 shared, +12 over BaselineTests 775; `npm run lint` clean; several
flaky failures throughout this cycle, all under genuine heavy concurrent CPU load from a live
185-listing bulk identify-parts run active the entire time, all independently re-confirmed
passing in isolation, never the same file twice).

UAT: passed. Ran the plan's exact U1 verification directly (no sub-agent dispatch needed for a
three-line throwaway script): constructed the real observed failure shape (leading-prose +
fenced JSON, matching "I can't fully confirm this, but here's my comparison:\n```json\n[...]\n```")
and ran it through both `parseIdentificationResponse` and `parseVisualComparisonResponse` —
both now succeed with the fix in this worktree. Ran the IDENTICAL string against the real,
unmodified files on `main` (the pre-fix version) and confirmed both genuinely throw there today
(`"The AI model did not return valid JSON for part identification"` /
`"The AI model did not return a JSON array for visual comparison"`) — real before/after proof,
not an inference. Confirmed a genuinely contentless response
(`"I'm sorry, I can't help with that."`) still throws the unchanged `AppError(502)` after the
fix. Overall cycle verdict: PASS. Proceeding to merge.
