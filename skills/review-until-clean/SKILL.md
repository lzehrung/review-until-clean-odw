---
name: review-until-clean
description: Run an agent/harness-agnostic pre-PR review loop with ODW's review-and-correct workflow. Use when asked to review until clean, run final review before PR, iterate review fixes, or verify fixes after review findings.
---

# Review Until Clean

Use ODW as the reviewer; use your normal harness tools for edits/tests. Keep the loop small and local.

## Invariants

- NEVER push, force-push, delete branches, or mutate remote state.
- Abort on shared branches: `main`, `master`, `develop`, `trunk`, `release/*`.
- Fetch/read acceptance criteria caller-side; pass AC text to ODW. Do not make reviewer agents fetch Jira/GitHub.
- Always pass `base` explicitly when known. If omitted, prefer `origin/develop`, else `origin/main`.
- If `git diff --name-only <base>...HEAD` is empty, stop: there are no branch changes to review. Do not review base-only commits from a branch that is behind base.
- Start only from a known-good baseline: run the repo's build/lint/tests first. If unknown, inspect package/config docs; ask only if still ambiguous.
- Critical/important findings block. Minor findings are reported, not loop-forcing.

## Review command

Use a temp ODW config with `{"workspaceMode":"inplace"}` so reviewer agents can run `git diff` in the real repo.

```bash
odw run review-and-correct --wait --config <odw-inplace-config.json> --source <repo> --args '{
  "ticketKey": "ENG-1234",
  "base": "origin/develop",
  "head": "HEAD",
  "ac": "<acceptance criteria text>",
  "mode": "review"
}'
```

Prefer `--args @file.json` for multiline AC. Default copy mode may strip `.git`; do not use it for this git-diff workflow.

## Loop

1. Preflight: branch safety, base, non-empty branch diff, AC, baseline green.
2. Save `preFixHead=$(git rev-parse HEAD)` before applying any fixes.
3. Run review mode.
4. If no critical/important `confirmed[]`, stop clean enough.
5. Fix only confirmed critical/important items; minors only if obvious and safe.
6. Run build/lint/tests. Fix failures before proceeding.
7. Commit locally once for the round. Do not push.
8. Verify fixes:

Write `verify-args.json` containing the same fields plus:

```json
{
  "mode": "verify-fixes",
  "priorFindings": [],
  "priorHead": "<pre-fix HEAD>"
}
```

Then run:

```bash
odw run review-and-correct --wait --source <repo> --args @verify-args.json
```

9. New blockers are critical/important `unresolved[]` plus critical/important `regressions[]`.
10. Repeat until no blockers remain or max rounds is reached; default max rounds: 3.

## State to carry

Keep only:

- `base`
- `ticketKey`
- `ac`
- `preFixHead` for the round
- full prior `confirmed[]`
- final `report` markdown from the latest workflow run

For unresolved summaries in verify-fixes, refer back to the saved full prior `confirmed[]` for detail/suggested fix.

## Final response

Report:

- rounds run
- local commit SHAs, if any
- remaining blockers/minors and why
- final workflow `report`
- explicit confirmation: branch name, local commits only, nothing pushed
