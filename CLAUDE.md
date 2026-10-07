# Project instructions

## Use the `feature` skill for all changes

Any code change in this repository — new feature, bug fix, refactor, no matter how small it looks
— MUST go through the `feature` skill (`/feature`), not a direct, ad-hoc edit made straight in the
main checkout.

Why: a change made outside the skill skips its planning, build/review/test separation, and UAT gate.
Those exist specifically because a change that looks small in the moment can turn out not to be —
this project has already had direct fixes that missed a validation edge case, an architectural
requirement (a background job's own persistence depending on a browser being open), and a
regression in another feature (an "AI suggested" badge silently losing its data) — each only caught
by a later follow-up, after already shipping. The skill's review/test/UAT stages exist to catch
exactly this class of miss before merge, not after.

The skill already has its own fast path for a genuinely trivial, low-risk request (see its "skip the
harness" option at the plan-approval step) — so routing everything through `/feature` first does not
mean every request gets the full multi-agent ceremony, only that the decision to skip it is made
deliberately, with a plan in view, not by defaulting to a direct edit before any plan exists.
