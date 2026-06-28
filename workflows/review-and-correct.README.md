# review-and-correct + review-until-clean skill

A final pre-PR review toolkit:

- `workflows/review-and-correct.js` -- ODW/Claude-compatible review engine. It finds issues and returns structured results; it does not edit or commit.
- `skills/review-until-clean/SKILL.md` -- portable loop policy for Codex/Cursor/Claude-style agents: run review, apply fixes with native tools, test, commit locally, then verify fixes.

## Purpose

The last pass before opening a PR. Not a nit sweep: verifies whether the change achieves the ticket goal and fits project patterns/architecture/standards, then catches oversights a human reviewer would flag.

## Critical ODW usage note

This workflow is git-diff based. Reviewer agents must be able to run `git diff <base>...HEAD` in the real repo.

Use ODW with an explicit config containing:

```json
{ "workspaceMode": "inplace" }
```

Default ODW copy mode may strip `.git`; do not use copy mode for this workflow. The workflow is review-only, but `inplace` gives agents read access to the real git checkout.

If `git diff --name-only <base>...HEAD` is empty, stop: there are no branch changes to review. Do not review base-only commits from a branch that is behind base.

## `review-and-correct.js`

Per run:

- Reviews the **three-dot diff** (`base...head`) -- the branch's own work since it diverged from base, matching PR semantics.
- Runs 6 independent reviewers: correctness, design, error-handling, tests, conventions, docs.
- Grounds judgment in ticket AC plus repo intent/docs.
- Adversarially verifies every finding; default is to refute false positives and out-of-scope issues.
- Requires findings to be anchored to changed files/hunks. Empty diffs should return no findings.
- Annotates duplicate/shared-locus findings without merging them.
- Returns structured JSON plus human-readable `report` markdown.

## ODW invoke

Install the workflow at `~/.odw/workflows/review-and-correct.js`, create `odw-inplace-config.json` with `{ "workspaceMode": "inplace" }`, then run:

```bash
odw run review-and-correct --wait --config odw-inplace-config.json --source <repo> --args '{
  "ticketKey": "ENG-1234",
  "base": "origin/develop",
  "head": "HEAD",
  "ac": "<acceptance criteria text>",
  "mode": "review"
}'
```

Prefer `--args @file.json` for multiline AC.

## Args

- `ticketKey` -- ticket id used for scoping.
- `base` -- repo integration branch/ref. Always pass explicitly when known.
- `head` -- defaults to `HEAD`.
- `ac` -- acceptance criteria text. Fetch caller-side; do not make reviewer agents fetch it.
- `mode` -- `"review"` (default) | `"verify-fixes"`.
- `priorFindings`, `priorHead` -- current round blockers and pre-fix HEAD for `verify-fixes` mode.

## Modes

- **review** -- full 6-dimension pass.
- **verify-fixes** -- rechecks `priorFindings` and reviews `priorHead...head` for regressions. Returns `addressed[]` (compact resolved findings for session summaries), full `resolved[]`, full `unresolved[]`, `regressions[]`, and `report`.

## Portable loop

Use the `review-until-clean` skill, not a wrapper command, for agent/harness-agnostic operation:

1. Safety gates: feature branch only, never push, non-empty branch diff, baseline build/lint/tests green.
2. Run ODW review mode with `workspaceMode: "inplace"`.
3. Fix critical/important findings using the active agent's normal edit tools.
4. Run build/lint/tests.
5. Commit locally once per round.
6. Run ODW `verify-fixes` mode with current round blockers as `priorFindings` and pre-fix HEAD.
7. Carry full detail only for current blockers; compress resolved history to round ledger lines from `addressed[]`. Do not write or commit a report artifact.
8. Repeat until no critical/important unresolved/regressions remain, or the caller/orchestrator's round limit is hit.

## Install / share

ODW/global agent install:

- `workflows/review-and-correct.js` -> `~/.odw/workflows/review-and-correct.js`
- `skills/review-until-clean/` -> your shared skills directory, e.g. `~/.agents/skills/review-until-clean/`, then symlink into agent-specific skill dirs.

