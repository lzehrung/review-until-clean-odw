---
name: review-until-clean
description: Run an agent/harness-agnostic pre-PR review loop with the Claude Code-compatible review-and-correct dynamic workflow. ODW commands are the documented runner examples.
---

# Review Until Clean

Use the review-and-correct dynamic workflow as the reviewer; use your normal harness tools for edits/tests. In Claude Code, invoke it with the native workflow tool; in other harnesses, run it with ODW. The engine and its `args` are identical either way.

## Invariants

- NEVER push, force-push, delete branches, or mutate remote state.
- Abort on shared branches: `main`, `master`, `develop`, `trunk`, `release/*`.
- Fetch/read acceptance criteria caller-side; pass AC text to the workflow. Do not make reviewer agents fetch Jira/GitHub.
- Add concise session/user clarifications or approved deviations to the AC text before invoking the workflow. Treat those later instructions as authoritative over older AC/plan/docs, but preserve them in the final summary.
- If the implementation directly contradicts the effective AC/source material in total or on a key criterion, pause before fixes and ask the user. Summarize `source says` vs `implementation does`; do not assume reinterpretation or changed scope.
- Do not escalate incidental cleanup or minor code-cleanliness scope increases; the user clarification path is for direct AC/source contradictions.
- Always pass `base` explicitly when known. If omitted, prefer `origin/develop`, else `origin/main`.
- If `git diff --name-only <base>...HEAD` is empty, stop: there are no branch changes to review. Do not review base-only commits from a branch that is behind base.
- Start only from a known-good baseline: run the repo's build/lint/tests first. If unknown, inspect package/config docs; ask only if still ambiguous.
- Critical/important findings block. Minor findings are reported, not loop-forcing.

## Optional Codegraph context

If the Codegraph skill/CLI is available, use it before review for non-trivial diffs and pass a compact summary as `codegraphContext`. If unavailable, continue without it.

Collect only advisory leads:

```bash
codegraph review --root <repo> --base <base> --head <head> --summary
codegraph impact --root <repo> --base <base> --head <head> --pretty
codegraph duplicates --root <repo> <changed-root> --profile cleanup
```

Use `codegraph review` and `impact` for structural risk/candidate tests. Use `duplicates` to look for duplicate code introduced by the change, bounded to changed roots when possible. Treat Codegraph output as leads, not proof; reviewers still verify against the diff/code. Do not carry raw Codegraph output after the round.

For verify-fixes, scope Codegraph context to the fix commits with `--base <preFixHead> --head <head>` when useful.

## Review command

The same `review-and-correct` engine runs in both harnesses with identical `args`. Pick the invocation for yours.

### Claude Code (native)

Invoke the workflow tool by `scriptPath`, passing `args` as a real JSON object (a stringified object loses the fields):

```
Workflow({
  scriptPath: "<install path>/review-and-correct.js",   // e.g. ~/.claude/workflows/review-and-correct.js
  args: {
    ticketKey: "ENG-1234",
    base: "origin/develop",
    head: "HEAD",
    ac: "<acceptance criteria text>",
    codegraphContext: "<optional compact Codegraph review/impact/duplicate summary>",
    mode: "review"
  }
})
```

Reviewer agents run `git diff` in the real working tree, so no extra config is needed. `~/.claude/workflows/` is not scanned by the named-workflow registry, so always invoke by `scriptPath`, not by name.

### ODW (other harnesses)

Use a temp ODW config with `{"workspaceMode":"inplace"}` so reviewer agents can run `git diff` in the real repo.

```bash
odw run review-and-correct --wait --config <odw-inplace-config.json> --source <repo> --args '{
  "ticketKey": "ENG-1234",
  "base": "origin/develop",
  "head": "HEAD",
  "ac": "<acceptance criteria text>",
  "codegraphContext": "<optional compact Codegraph review/impact/duplicate summary>",
  "mode": "review"
}'
```

Prefer `--args @file.json` for multiline AC. ODW default copy mode may strip `.git`; do not use it for this git-diff workflow.

## Loop

1. Preflight: branch safety, base, non-empty branch diff, AC, baseline green.
2. Save `preFixHead=$(git rev-parse HEAD)` before applying any fixes.
3. Run review mode.
4. If no critical/important `confirmed[]`, stop clean enough.
5. If confirmed findings show a direct AC/source contradiction not already covered by session/user clarification, ask the user before fixing or continuing. Include a concise `source says` vs `implementation does` summary.
6. Record any user answer as a concise approved deviation/clarification and include it in AC for later workflow runs.
7. Fix only confirmed critical/important items; minors only if obvious and safe.
8. Run build/lint/tests. Fix failures before proceeding.
9. Commit locally once for the round. Do not push.
10. Verify fixes:

Write `verify-args.json` containing the same fields plus `priorFindings` set to the current round's blockers (the findings just fixed or attempted), not every historic finding:

```json
{
  "mode": "verify-fixes",
  "priorFindings": [],
  "priorHead": "<pre-fix HEAD>"
}
```

Then re-run the same engine in verify-fixes mode:

- **Claude Code:** `Workflow({ scriptPath: "<install path>/review-and-correct.js", args: { ...same fields, mode: "verify-fixes", priorFindings, priorHead } })`
- **ODW:** `odw run review-and-correct --wait --config <odw-inplace-config.json> --source <repo> --args @verify-args.json`

11. New blockers are critical/important `unresolved[]` plus critical/important `regressions[]`.
12. Keep a concise session-only round note: local commit SHA plus `addressed[]` from the verify result. One line per resolved legitimate finding; do not write or commit a report artifact for this.
13. Repeat until no blockers remain or the caller/orchestrator's round limit is reached; default max rounds: 3.

## State to carry

Carry two layers only:

### Current round state

- `base`
- `ticketKey`
- effective `ac`, including concise session/user clarifications and approved deviations
- `preFixHead` for the current fix round, passed as `priorHead`
- current round blockers passed as `priorFindings`
- full finding detail only for blockers still being fixed or still unresolved
- current round `codegraphContext`, if used; drop raw Codegraph output after the round

### Compact history

Append one session-only ledger entry per round:

- round number
- local fix commit SHA
- `addressed[]` from verify-fixes
- approved deviations/clarifications used this round, if any

After a finding is resolved, keep only its compact ledger line; drop its detail/reasoning from carried state. Do not carry dropped false positives except counts if useful. Do not pass already-resolved historical findings again.

## Final response

Report from the compact ledger:

- completed review/correct iterations, e.g. `Completed N review/correct iterations.`
- total addressed legitimate findings, e.g. `15 findings addressed:`
- addressed findings grouped by round or commit (one line per finding)
- local commit SHAs, if any
- remaining blockers/minors and why, including the latest workflow status
- approved deviations/clarifications used, if any
- do not paste dropped/false-positive detail or duplicate addressed findings already listed by round
