---
description: Iteratively review-and-correct the current feature branch until the adversarial review is clean. Dev branches only, local commits only, never pushes.
argument-hint: [ticketKey] [base] [maxRounds]
---

Drive the `review-and-correct` workflow in a correct loop: review -> apply the confirmed
fixes -> commit locally -> re-verify -> repeat, until the review is clean or the round cap
is hit. The workflow itself is a pure finder; YOU apply and commit the fixes between rounds,
so every change stays under git control.

## Inputs

- `$1` = ticketKey (e.g. ENG-22876). If omitted, infer from the current branch name; if it
  can't be inferred, ask once.
- `$2` = base, the repo's integration branch (`origin/develop` or `origin/main`). If omitted,
  detect it (prefer `origin/develop` if it exists, else `origin/main`) and state which you chose.
- `$3` = maxRounds (default 3).
- AC: fetch CALLER-side and pass it into the workflow as `ac` text. Use the Atlassian MCP
  `getJiraIssue` for `$1` (or `gh issue view`). Do not make the reviewer agents fetch it.

## Hard safety gates (check BEFORE any work; abort if violated)

1. **Feature branches only.** Run `git branch --show-current`. If it is a shared branch
   (`main`, `master`, `develop`, `trunk`, or anything matching `release/*`), ABORT immediately
   and tell the user. This loop commits; it must never run on a shared branch.
2. **Confirm the upstream is the branch's own remote, not a shared branch** (`git branch -vv`).
3. **Local commits only. NEVER push** (no `git push`, no force-push) and never delete a branch.
   Stop and report at the end; the user pushes / opens the PR themselves.
4. **Known-good baseline.** Before round 1, run the project's build + lint + tests. If they are
   not green, stop and surface that first -- don't start a correct loop on a red baseline.

## The loop

Track `head0` = the current HEAD SHA before any fixes (the regression-sweep floor for later rounds).

For round `r` from 1 to maxRounds:

1. **Review.**
   - Round 1: invoke the full workflow:
     `Workflow({scriptPath: "C:\\Users\\lzehrung\\.claude\\workflows\\review-and-correct.js", args: {ticketKey, base, head: "HEAD", ac}})`
     -> note `confirmed[]` and the workflow's reported `head`.
   - Round 2+: invoke verify-fixes against the prior round's findings:
     `args: {ticketKey, base, head: "HEAD", ac, mode: "verify-fixes", priorFindings: <prior confirmed>, priorHead: <HEAD before the prior round's fix commits>}`
     -> the new worklist is `unresolved` + `regressions`.

2. **Stop check.** If there are no confirmed/unresolved **critical or important** findings
   (and no regressions), STOP -- the branch is clean enough. Remaining **minor** findings are
   reported but do NOT force another round (diminishing returns; let the user decide). Also stop
   if `r == maxRounds`.

3. **Apply fixes.** Implement the confirmed fixes (critical + important first; minors only if
   cheap and safe). Stay in scope for the ticket AC -- do not scope-creep.

4. **Re-verify green.** Run build + lint + tests. If a fix broke them, fix that before committing.

5. **Commit locally.** One commit per round. Message: lowercase, casual, ASCII, ticket-prefixed,
   e.g. `eng-22876: review round 2 -- error-handling + correctness fixes`. Do NOT push.

6. Continue to round `r+1`, carrying this round's confirmed list as `priorFindings` and the
   pre-fix HEAD as `priorHead`.

## Report at the end

- Rounds run, and per round: how many findings confirmed, fixed, and the commit SHA.
- Anything left unfixed (e.g. deferred minors, or items still open at the round cap) with why.
- Explicit confirmation: branch is `<name>`, all commits are LOCAL, nothing was pushed.
- The final workflow `report` markdown (paste it) so there's a record of the last clean/near-clean state.
- Recommend next step (push + open/update the PR) but do NOT do it -- the user pushes themselves.

## Notes

- Stochastic reviews rarely hit literal zero; the critical/important stop condition + round cap
  are what make this converge. Trust them over chasing every minor.
- This is a personal, machine-local command. Do not share, commit to a repo, or otherwise send
  it or its output anywhere outward without explicit approval.
