# review-until-clean-odw

Portable pre-PR review loop skill and Claude Code-compatible dynamic workflow, runnable in Claude Code and via [Open Dynamic Workflows (ODW)](https://github.com/xz1220/open-dynamic-workflows) for other harnesses.

- `workflows/review-and-correct.js` is the executable Claude Code-compatible review workflow: fan out independent reviewers, adversarially verify findings, sweep fix regressions, and return structured JSON + concise markdown.
- `skills/review-until-clean/SKILL.md` is the host-agent operating procedure: safety gates, run the workflow, fix with native tools, test, local commit, verify fixes, carry a compact ledger, and report the final result.

The workflow is compatible with Claude Code's dynamic workflow model. ODW runs that workflow from other agent harnesses; the examples and installer use the ODW CLI.

## Key rule

This workflow reviews a git diff. Reviewer agents must see `.git`.

Create an ODW config:

```json
{ "workspaceMode": "inplace" }
```

Use it for this git-diff workflow. ODW default copy mode may strip `.git` and produce unanchored findings.

If this is empty, stop; there is nothing branch-local to review:

```bash
git diff --name-only <base>...HEAD
```

## Why a workflow and a skill?

A skill can document the loop, but it cannot enforce the review topology. The workflow JS makes the review repeatable:

- runs the same six independent review dimensions every time
- adversarially verifies each finding instead of trusting first-pass reviewer prose
- returns stable fields (`confirmed[]`, `addressed[]`, `unresolved[]`, `regressions[]`) that the loop can act on
- checks fix commits for regressions with `priorHead...head`
- keeps reviewer transcripts out of the host agent context; the host carries only current blockers plus a compact ledger

The split is intentional:

- workflow: executable review engine
- skill: orchestration, state discipline, and final reporting

Two skills would document the same intent, but the orchestrating agent would have to recreate fan-out, verification, regression sweeps, and result shaping by hand on every run.

## Process outline

```mermaid
flowchart TB
  S[Begin multi-agent/dimension review] --> A[Gather AC + session clarifications]
  A --> B[Preflight: safe branch, base, non-empty diff, baseline green]
  B --> C[Workflow review: 6 independent dimensions]
  C --> D[Adversarially verify each finding]
  D --> E{Critical/important blockers?}
  E -- No --> Z[Final compact ledger summary]
  E -- Direct AC contradiction --> H[Ask user: source says vs implementation does]
  H --> H2[Update effective AC; rerun review]
  E -- Yes --> F[Agent fixes current blockers]
  F --> G[Run build/lint/tests and commit locally]
  G --> I[verify-fixes: recheck current blockers + sweep fix commits]
  I --> J{Unresolved blockers or regressions?}
  J -- Yes --> K[Next iteration: fix remaining blockers/regressions]
  J -- No --> Z
```

State stays small: full detail only for current blockers; resolved history becomes ledger lines from `addressed[]`. User-approved deviations from AC/plan/docs are folded into the effective AC and summarized at the end.

## Install

Cross-platform installer (Windows/macOS/Linux; copies by default, no symlink privileges required):

```bash
node scripts/install.mjs
```

PowerShell:

```powershell
node .\scripts\install.mjs
```

The installer writes:

- ODW workflow copy: `~/.odw/workflows/review-and-correct.js`
- Claude Code workflow copy: `~/.claude/workflows/review-and-correct.js` (so Claude Code's workflow tool resolves it by `scriptPath`; skipped with `--no-harness`)
- `~/.agents/skills/review-until-clean`
- common harness skill copies: `~/.codex/skills`, `~/.claude/skills`, `~/.cursor/skills`

Options:

```bash
node scripts/install.mjs --dry-run
node scripts/install.mjs --link
node scripts/install.mjs --no-harness
node scripts/install.mjs --harness-dir ~/.my-agent/skills
```

Manual fallback:

```bash
# ODW + shared skill
mkdir -p ~/.odw/workflows ~/.agents/skills
cp workflows/review-and-correct.js ~/.odw/workflows/review-and-correct.js
cp -R skills/review-until-clean ~/.agents/skills/review-until-clean

# Claude Code (workflow by scriptPath + skill)
mkdir -p ~/.claude/workflows ~/.claude/skills
cp workflows/review-and-correct.js ~/.claude/workflows/review-and-correct.js
cp -R skills/review-until-clean ~/.claude/skills/review-until-clean
```

## Run one review

The same engine runs in either harness with identical `args`.

### Claude Code (native)

Invoke the workflow tool by `scriptPath`, passing `args` as a real JSON object:

```
Workflow({
  scriptPath: "~/.claude/workflows/review-and-correct.js",
  args: {
    ticketKey: "ENG-1234",
    base: "origin/develop",
    head: "HEAD",
    ac: "<acceptance criteria text>",
    mode: "review"
  }
})
```

`~/.claude/workflows/` is not scanned by the named-workflow registry, so invoke by `scriptPath`, not by name. Reviewer agents run `git diff` in the real working tree, so no extra config is needed.

### ODW (other harnesses)

Prefer `--args @file.json` for multiline AC.

```bash
odw run review-and-correct \
  --wait \
  --config odw-inplace-config.json \
  --source /path/to/repo \
  --args '{
    "ticketKey": "ENG-1234",
    "base": "origin/develop",
    "head": "HEAD",
    "ac": "<acceptance criteria text>",
    "mode": "review"
  }'
```

## Run until clean

Ask an agent with the skill installed:

```text
Use review-until-clean on this branch for ticket ENG-1234 against origin/develop. AC: ...
```

Loop policy:

1. Feature branch only. Never push.
2. Non-empty `<base>...HEAD` diff only.
3. Baseline build/lint/tests green.
4. Run the workflow review: Claude Code via the workflow tool, or ODW with `workspaceMode: "inplace"`.
5. Fix critical/important findings only; minors do not force another round.
6. Run verification, commit locally once per round.
7. Re-run with `mode: "verify-fixes"`, current round blockers as `priorFindings`, and pre-fix HEAD.
8. Stop when no critical/important unresolved findings or regressions remain.

## Result contract

Review mode returns:

```text
confirmed[]  verified real/in-scope findings
clusters[]   shared-locus annotations; duplicates are cross-linked, not merged
dropped[]    false positives or out-of-scope findings rejected by verification
report       concise markdown summary
```

Verify-fixes mode returns:

```text
addressed[]    compact ledger input for resolved current-round blockers
resolved[]     full details for current blockers verified as fixed
unresolved[]   full details for current blockers still open
regressions[]  new verified findings in the fix commits
report         concise markdown summary
```

Findings are expected to be anchored to changed files/hunks. The workflow reviews an empty diff as clean.
