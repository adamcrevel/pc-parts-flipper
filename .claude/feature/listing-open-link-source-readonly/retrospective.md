# Retrospective

## What happened
- This feature ran clean: a single cycle (Cycle 0 of a 3-cycle budget), no retries, no additional
  tasks added mid-flight, UAT passed on the first attempt. The worktree's own commit log (6 commits:
  plan+prototype, status flip, T1+R1+TE1 landing, U0 UAT task, done) shows no fixup/rework commits —
  every stage landed once.
- R1 (review) did raise a `FAIL` — flagging `ListingForm`'s pre-existing cyclomatic complexity (13
  against an eslint `complexity` threshold of 10) as a `must_fix`, because T1's one added line
  happened to fall inside that already-over-threshold function. `validate-lead` overruled it (debt
  confirmed pre-existing, unchanged by T1's diff, not a correctness/safety issue) without spawning a
  new cycle or extra tasks — so this cost time and tokens inside Cycle 0 rather than triggering
  Cycle 1.
- That overrule is visible in the cost data: R1 took 40m12s of real time against an `expected_minutes`
  of 15 (2.7x) and burned 183,347 `actual_tokens` against an `estimated_tokens` of 31,000 (~5.9x) —
  the single largest overrun of any task in this plan, both in absolute tokens and in ratio over
  estimate. TE1, which ran in the same parallel window (03:40:30–04:20:42), also overran its token
  estimate (116,358 actual vs 32,500 estimated, ~3.6x), though by a smaller ratio than R1.
- T1 (the builder task) itself finished under its time budget (17m vs 25m expected) but still used
  ~3.9x its token estimate (24,605 actual vs 6,300 estimated) — a smaller but same-direction miss as
  R1/TE1, suggesting the per-task token estimates for this plan were systematically too low across
  the board, not just for the one task that hit the complexity debate.
- Orchestration overhead between tasks was sizeable relative to the work itself: the gap between T1
  completing (03:29:00) and R1/TE1 starting (03:40:30) was ~11.5 minutes, and the gap between
  R1/TE1 completing (04:20:42) and U0 starting (04:43:45) was ~23 minutes. Summed `expected_minutes`
  across all five tasks is 90 minutes; the feature's actual wall-clock span was ~152 minutes — roughly
  62 minutes (41% of total wall time) sat outside any task's own execution window.
- No `context_split` occurred — T1 stayed a single row covering both the "Open Link" button and the
  read-only Source behavior, matching the plan's original scope. No model escalation occurred either;
  every task ran without an explicit `model` override in the table, consistent with a feature this
  narrow in scope (two UI changes to one existing form).

## Proposals
- For reviewer tasks on files with known pre-existing lint-threshold debt (here, `ListingForm`'s
  complexity sitting at 13 against a threshold of 10), add a pre-check step to `feature-reviewer`
  that diffs the specific metric (e.g. `eslint --rule complexity`) before and after the change, and
  auto-classifies the finding as "pre-existing, unaffected by this diff" when the number is unchanged
  — skipping the must-fix/overrule round-trip that cost ~25 extra minutes and well over 100K tokens
  here. Had that check existed, R1 would likely have landed closer to its 15-minute/31K-token
  estimate instead of 40 minutes/183K tokens.
- Raise per-task `estimated_tokens` for builder/reviewer/tester roles on this kind of small-but-deep
  UI change (touching an existing form's structure, not just adding an isolated component) — T1, R1,
  and TE1 all landed between 3.6x and 5.9x their estimates, with no single task being an outlier
  explained only by the complexity debate (T1 alone, with no debate, was still 3.9x over). A planning
  heuristic of "budget review/test tokens for touches to shared form components at 4x the usual
  per-line estimate" would have made this plan's `estimated_tokens` column load-bearing rather than
  consistently too low.
- Investigate the ~11.5-minute gap between T1 landing and R1/TE1 starting, and the ~23-minute gap
  between R1/TE1 landing and U0 starting — together these two gaps are ~34 of the ~62 total
  orchestration-overhead minutes (55% of all non-task time) on a feature with only one cycle and five
  tasks. If this orchestration overhead scales with feature size rather than staying roughly fixed,
  it is worth profiling on the next multi-cycle feature where the absolute cost would be larger.

---
This report cost approximately 4000 tokens (self-reported estimate) /
not available tokens (measured) — the measured figure must come from whoever dispatched this
agent, since a sub-agent's tool-call token usage is attributed to the parent session id, not
separable from it by this agent itself. Not counted in the feature's own total — this analysis
happened after the feature was already done.
