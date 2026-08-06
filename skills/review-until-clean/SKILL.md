---
name: review-until-clean
description: Run an agent/harness-agnostic pre-PR review loop with the Claude Code-compatible review-and-correct dynamic workflow. ODW is the runner for non-Claude harnesses; the documented example drives Oh My Pi (omp).
---

# Review Until Clean

`review-and-correct` is the reviewer. Your normal harness tools do the edits, tests, and local commits. The workflow is read-only; you own branch safety, fixes, loop state, and the final report.

## 1. Pick the invocation path

| Active host                               | Path                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| Claude Code                               | native `Workflow` tool (§4)                                 |
| Anything else (omp, Codex, Cursor, …)      | `odw run review-and-correct` (§3)                           |

Claude Code supports dynamic workflows natively, so it never needs ODW. A `claude` binary on `PATH` does **not** give a non-Claude host the `Workflow` tool — that host uses ODW.

## 2. One-time ODW setup

Skip if `odw workflows where review-and-correct` already resolves and `~/.odw/review-config.json` exists. Otherwise, from a checkout of the review-until-clean-odw repo:

```bash
node scripts/install.mjs         # ~/.odw/workflows/review-and-correct.js + ~/.odw/review-config.json
odw workflows where review-and-correct
```

**Reviewer agents must have shell/file tools.** They run `git diff` and read the touched files themselves; an adapter without tools produces a confidently hallucinated review, not an error.

That is why the installer ships `~/.odw/review-config.json`: ODW's built-in `omp` adapter runs `omp --print --no-tools` (fine for pure-text workflows, fatal here), and the config restores tools. Pass it on every run. If you must write it by hand:

```json
{
  "timeout": 3600,
  "adapters": {
    "omp": {
      "label": "Oh My Pi (tools enabled)",
      "command": ["omp", "--print", "--no-session", "--approval-mode", "yolo", "--cwd", "{workspace}"],
      "stdin": "{prompt}",
      "flags": { "model": ["--model"] }
    }
  }
}
```

An adapter entry **replaces** the built-in wholesale, so restate the full `command`. `codex`, `claude`, `cursor`, `kilo`, `opencode`, `gemini`, `qwen`, and `kimi` are tool-capable as shipped and need no override — with those you may drop `--config` entirely. `timeout` (seconds, per agent CLI call, ODW default 1800) is worth raising for large diffs.

There is nothing to configure for workspace isolation: ODW runs agents in place in `--source` by default, which is what a git-diff review needs. Never request `isolation: "worktree"` here — a worktree is a clean checkout of the base commit and hides the branch's uncommitted state. `workspaceMode` is not a config key; a config containing it is ignored with a warning.

## 3. Run a review (ODW)

```bash
odw run review-and-correct --wait \
  --adapter omp \
  --config ~/.odw/review-config.json \
  --source <repo> \
  --args @review-args.json
```

`review-args.json`:

```json
{
  "ticketKey": "ENG-1234",
  "base": "origin/develop",
  "head": "HEAD",
  "ac": "<effective acceptance criteria text>",
  "mode": "review"
}
```

Use `--args @file.json`, not inline JSON: multiline AC does not survive shell quoting, and ODW hard-fails args that look like JSON but do not parse.

Output contract for `--wait`: result JSON on **stdout**, `running <run_id> …` on **stderr**, exit `0` done / `1` failed or stopped / `124` timed out with the run still going. Without `--wait` (or a TTY) `odw run` detaches and prints only the run id; then use `odw result <run_id>` and `odw logs <run_id>`.

Optional accelerants: if Codegraph is already installed *and* you already ran `codegraph review`/`codegraph impact`, pass its output as `codegraphContext` and dense/risky hunks as `riskHunks` (`[{file, line?, reason}]`). Otherwise omit both — the same two reviewers derive their own context from the live diff. Never install Codegraph or block a review on its absence.

## 4. Run a review (Claude Code, native)

Invoke by `scriptPath`, and pass `args` as a real JSON object — a stringified object loses the fields. `~/.claude/workflows/` is not scanned by the named-workflow registry, so a bare name will not resolve.

```
Workflow({
  scriptPath: "<install path>/review-and-correct.js",   // e.g. ~/.claude/workflows/review-and-correct.js
  args: {
    ticketKey: "ENG-1234",
    base: "origin/develop",
    head: "HEAD",
    ac: "<effective acceptance criteria text>",
    mode: "review"
  }
})
```

Subagents run in the real working tree, so there is nothing else to configure.

## 5. Preflight

Run all of these before the first review; abort rather than improvise.

1. Branch safety: abort on `main`, `master`, `develop`, `trunk`, `release/*`.
2. `base` is explicit. If the caller did not give one, prefer `origin/develop`, else `origin/main`. Never rely on the workflow's `origin/main` fallback.
3. `git diff --name-only <base>...HEAD` is non-empty. Empty means there is nothing branch-local to review — stop. (Diffs are three-dot: the branch's own work, excluding commits already on base.)
4. Acceptance criteria are fetched **caller-side** and passed as `ac` text. Reviewer agents never fetch Jira/GitHub.
5. Effective AC includes concise session/user clarifications and approved deviations, folded into the same `ac` string. Those later instructions outrank older AC/plan/docs, and must still appear in the final summary.
6. Baseline build/lint/tests are green. If the commands are unknown, read the package/config docs; ask only if still ambiguous.
7. `preFixHead=$(git rev-parse HEAD)`, saved before any fix.

## 6. Invariants

- Never push, force-push, delete branches, or otherwise mutate remote state inside the loop. If the caller also wants the PR updated, push only after the loop is clean.
- Reviewer sessions run under a write-capable permission mode even though their prompts forbid edits. After each workflow run, confirm `git status --porcelain` is unchanged before attributing anything to your own fixes.
- Critical/important findings block. Minor findings are reported, never loop-forcing.
- Both reviewer lanes must return valid results. The workflow throws instead of reporting a false clean review; treat any failed run as an incomplete review, not a pass.
- If the implementation directly contradicts the effective AC in total or on a key criterion, pause before fixing and ask the user. Summarize `source says` vs `implementation does`. Do not reinterpret scope on your own.
- That escalation path is for direct AC/source contradictions only. Do not escalate incidental cleanup or minor code-cleanliness scope.
- For behavioral findings, re-run the concrete gate/test the reviewer named rather than trusting its reasoning. Regardless of reviewer claims, the host runs the repository build/lint/tests after every fix round.

## 7. Loop

1. Preflight (§5).
2. Run review mode.
3. No critical/important entries in `confirmed[]` → stop, clean enough.
4. Confirmed findings that expose a direct AC/source contradiction not already covered by a clarification → ask the user before fixing; record the answer as a concise approved deviation and fold it into `ac` for later runs.
5. Fix confirmed critical/important items; minors only when obvious and safe.
6. Run build/lint/tests. Fix failures before continuing.
7. Commit locally, once per round. Do not push.
8. Verify fixes: same args plus `mode: "verify-fixes"`, `priorHead` = this round's `preFixHead`, and `priorFindings` = **this round's blockers only** (what you just fixed or attempted), never cumulative history.

   ```json
   {
     "ticketKey": "ENG-1234",
     "base": "origin/develop",
     "head": "HEAD",
     "ac": "<effective acceptance criteria text>",
     "mode": "verify-fixes",
     "priorFindings": [],
     "priorHead": "<preFixHead>"
   }
   ```

   - ODW: `odw run review-and-correct --wait --adapter omp --config ~/.odw/review-config.json --source <repo> --args @verify-args.json`
   - Claude Code: `Workflow({ scriptPath: "…/review-and-correct.js", args: { …same fields, mode: "verify-fixes", priorFindings, priorHead } })`

9. New blockers = critical/important `unresolved[]` plus critical/important `regressions[]`.
10. Append one session-only ledger line: round number, local commit SHA, `addressed[]`, approved deviations used. Do not write or commit a report artifact.
11. Repeat from step 5 until no blockers remain or the round limit is hit. Default max rounds: 3.

Each mode makes exactly two reviewer-agent calls. Candidates are adversarially verified inside their owning group session, not by per-finding agents.

### Result fields

| Mode           | Fields                                                          |
| -------------- | --------------------------------------------------------------- |
| `review`       | `confirmed[]`, `clusters[]`, `dropped[]`, `report`               |
| `verify-fixes` | `addressed[]`, `resolved[]`, `unresolved[]`, `regressions[]`, `report` |

## 8. State to carry

Two layers, nothing more.

**Current round:** `base`, `ticketKey`, effective `ac`, `preFixHead` (passed as `priorHead`), this round's blockers (passed as `priorFindings`), and full detail only for blockers still being fixed or still unresolved.

**Compact history:** one ledger entry per round — round number, local fix commit SHA, `addressed[]`, approved deviations used.

Once a finding is resolved, keep only its ledger line and drop its detail and reasoning. Do not re-pass resolved findings. Do not carry dropped false positives beyond a count.

## 9. Final response

Report from the ledger:

- `Completed N review/correct iterations.`
- `<M> findings addressed:` then one line per finding, grouped by round or commit
- local commit SHAs, if any
- remaining blockers/minors and why, including the latest workflow status
- approved deviations/clarifications used, if any

Do not paste dropped/false-positive detail or repeat addressed findings already listed by round.

## 10. Troubleshooting

| Symptom                                                       | Cause and fix                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Reviewer reports "no shell tool available" or invents a diff  | Adapter has tools disabled. For `omp`, apply the §2 override.                             |
| `config warning: unknown key "workspaceMode" is ignored`       | Obsolete knob. Delete it; in-place is already the default.                                |
| `Review incomplete: expected 2 valid reviewer results`         | A reviewer lane failed or returned invalid JSON. Check `odw logs <run_id>`; re-run. Not a pass. |
| `Review incomplete: N finding(s) missing a valid verdict`      | Reviewer response truncated or malformed — often an adapter timeout. Raise `timeout`; re-run. |
| Findings cite base-only or pre-existing code                   | Wrong `base`. Confirm `git diff --name-only <base>...HEAD` shows only the branch's work.   |
| `odw run` returns a run id and exits immediately               | Missing `--wait` in a non-TTY. Add it, or read `odw result <run_id>`.                      |
| `ticketKey` is `UNKNOWN` in the result                         | `args` arrived as a string, not an object. Use `--args @file.json` / a real JSON object.   |
