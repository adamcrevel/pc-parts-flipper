# Retrospective

Feature `ai-reference-autosourcing`. `FeatureStarted` 2026-10-06T04:03:28Z → `FeatureCompletedAt`
2026-10-06T06:24:39Z = **2h21m wall**, 1 cycle (0, one in-place retry), 5 build tasks (T1-T5), 1 UAT
pass. Written directly by the orchestrator, not `feature-retrospective-medium` — see "What happened"
below for why.

## What happened

- **Cycle 0 shipped 5 tasks; 4 passed their first review clean, 1 had a single genuine gap.** T4
  (download-and-verify logic) built `isDecodableImage()` to detect four image formats (JPEG/PNG/GIF/
  WebP) correctly, but the automated suite only exercised the JPEG branch — the other three had zero
  coverage, a real gap with a concrete failure case (a typo'd signature check would silently break
  with `npm test` staying green). T1's own tester closed a smaller gap in-cycle (a concurrency proof
  that used two sequential calls instead of a real `Promise.all` race) without needing a retry.
- **This feature's own plan proactively applied the prior feature's (`ai-visual-identification`)
  retrospective lesson, and it worked.** That retrospective's #1 proposal was "pre-split a file in the
  plan before review catches a line-cap violation, not after." This plan's Standing Checks named
  `partIdentification.ts` (225 lines) and `ompRunner.ts` (193 lines) as already at/over the ~200-line
  convention *in the draft itself*, and T2/T5's task descriptions explicitly routed all new logic into
  new sibling files from the start. Result: **zero line-cap must_fix items this cycle** — the one place
  a reviewer did flag `ompRunner.ts` growing to 204 lines, it was a trivial, already-justified
  overage (a thin-wrapper refactor the task itself asked for), not a retry.
- **T4's gap is the same *class* of issue as two of the prior feature's bugs** (an untested branch in
  byte-level format-detection logic, the same shape as that feature's own NULL-distinctness and
  lead-ordering gaps) — "every branch of a signature/format check needs its own positive+negative
  test" is a pattern worth a standing checklist line, not just a one-off fix.
- **A significant, persistent sub-agent-dispatch infrastructure outage hit partway through this
  feature**, confirmed across 6 separate attempts spanning T4's retry-validation, the UAT dispatch, and
  the final dashboard/retrospective dispatch: `feature-pm`, `feature-validate-lead`, every
  `feature-reviewer-*`/`feature-tester-*`/`feature-uat-tester-*`/`feature-retrospective-*` agent — every
  agent definition whose `model:` field names a role alias other than literally `@medium` — failed
  immediately with "No model selected," while `scout`, `sonic`, and `feature-build-lead` (`@medium`)
  kept working throughout. Confirmed genuinely persistent, not transient: the identical failure
  recurred after restarting this host's `__omp_worker_daemon_broker` processes and after the user
  restarted their own `omp` instance. The user confirmed this traces to a recent agent-role rename the
  local role-alias resolution hadn't caught up with yet.
- **The fallback — doing the specialized work directly, with the same rigor, rather than skipping
  verification or blocking indefinitely — held up.** T4's review/test and the whole UAT pass were
  performed directly: real mutation-proofs (breaking one byte of the GIF signature check in production
  code, confirming the matching test failed for the right reason, restoring byte-for-byte, confirming
  green again — not just trusting the builder's own fixtures), real `npm run test`/`npm run lint` runs
  with real figures, and for UAT, a real unstubbed `omp` call.
- **UAT's hardest design problem was Requirement 1's actual trigger shape, and the direct-function
  approach solved it cleanly.** The requirement only fires when a part's first pass names a confident
  primary brand+model *and* still carries alternate `identityCandidates` — not simply "brand unknown."
  Coaxing a real, non-deterministic `omp` call into that exact shape via a crafted listing title would
  have been unreliable and slow to iterate on. Calling the real exported `createReferenceSourcer()`
  directly, with a hand-chosen genuinely-unseeded identity (`Seasonic FOCUS GX-750`), exercised the
  actual new capability — the real tools-enabled `omp` call, real download, real verify, real insert,
  real cache check — without needing pass 1's own judgment to cooperate. It found the real
  `seasonic.com` domain (the manufacturer's own site, not a reseller) and produced a real, decodable
  WebP image, in 87.9s; a second call for the identical identity took 94ms and inserted no duplicate —
  both Requirement 6's cache and the sourcing mechanism itself proven live, not only in unit tests. A
  separate real end-to-end `identify-parts` HTTP call then confirmed the whole pipeline (pass 1 →
  orchestrator check → pass 2) runs cleanly even when sourcing's narrow trigger doesn't fire — the
  common case.
- **Cost shape.** All `actual_tokens` are `null` — `measure-child-cost.py` does not exist anywhere in
  this repo/environment (reconfirmed by this feature's own builders and, before the outage, its
  reviewers/testers), the same unmeasurable-cost precedent `ai-visual-identification` already
  documented. `OrchestrationTokensActual`/`Breakdown` were never populated for the same reason.

## Proposals

- **Add "every format/signature branch needs its own positive and negative test" as a standing
  checklist item for any task that writes byte-level format detection.** This is the second feature in
  a row where a multi-branch, low-level check (NULL-distinctness in a unique index before; magic-byte
  format sniffing now) shipped with only its first/most obvious branch tested. A one-line Standing
  Check — "a function with N format/case branches has at least N positive and N negative test cases" —
  would have caught T4's gap in the original build pass, not the retry.
- **Keep doing exactly what this feature did with the prior retrospective's line-cap proposal: read the
  last feature's retrospective before drafting the next plan's Standing Checks, and bake its lessons in
  as upfront constraints, not just hope reviewers catch the same class of issue again.** It worked —
  zero line-cap must_fix items this cycle, against two in the previous one.
- **When a hard-to-force-deterministically trigger condition makes end-to-end UAT unreliable, test the
  real exported function directly instead of fighting the non-determinism of an upstream pass.** This
  feature's Requirement 1 trigger (confident identity *plus* candidates) would have been slow and
  unreliable to hit via crafted listing text and a real `omp` call's own judgment; calling
  `createReferenceSourcer()` directly with a hand-chosen identity proved the real new capability (real
  network call, real download, real verify, real insert) in one deterministic, fast-to-set-up attempt,
  with a full HTTP-level pipeline check as a separate, simpler proof alongside it.
- **This feature's own infrastructure outage is not something a future plan can route around in
  advance** — but the fallback behavior worth preserving as a named practice: when a specialized
  review/test/UAT agent is unavailable, the orchestrator doing the same work directly (real mutation-
  proofs, real suite runs, real UAT calls) is a legitimate substitute that keeps the verification bar
  identical, not a shortcut. Record *why* a review/test/UAT row was performed directly (as this
  feature's T4-review/T4-test/U1 rows and Assumption A22 do) so a reader of `plan.md` later can't
  mistake it for a skipped step.

---
This report was written directly by the orchestrator (not `feature-retrospective-medium`) because that
agent, like every other role-aliased specialist this feature needed past Cycle 0's initial build, was
unavailable to dispatch for the reason documented in Assumption A22 — a persistent, confirmed
infrastructure issue outside this feature's or this repo's control, not a shortcut taken by choice.
