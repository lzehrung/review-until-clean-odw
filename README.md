# review-until-clean-odw

Portable pre-PR review loop for ODW.

- `workflows/review-and-correct.js` is the executable review engine: fan out independent reviewers, adversarially verify findings, sweep fix regressions, and return structured JSON + concise markdown.
- `skills/review-until-clean/SKILL.md` is the host-agent operating procedure: safety gates, run workflow, fix with native tools, test, local commit, verify fixes, carry a compact ledger, and report the final result.

## Key rule

This workflow reviews a git diff. Reviewer agents must see `.git`.

Create an ODW config:

```json
{ "workspaceMode": "inplace" }
```

Use it for this workflow. ODW default copy mode may strip `.git` and produce unanchored findings.

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

## Install

```bash
mkdir -p ~/.odw/workflows ~/.agents/skills
cp workflows/review-and-correct.js ~/.odw/workflows/review-and-correct.js
cp -R skills/review-until-clean ~/.agents/skills/review-until-clean
```

Optional agent links:

```bash
mkdir -p ~/.codex/skills ~/.cursor/skills
ln -sfn ~/.agents/skills/review-until-clean ~/.codex/skills/review-until-clean
ln -sfn ~/.agents/skills/review-until-clean ~/.cursor/skills/review-until-clean
```

## Run one review

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
4. Run ODW review with `workspaceMode: "inplace"`.
5. Fix critical/important findings only; minors do not force another round.
6. Run verification, commit locally once per round.
7. Re-run with `mode: "verify-fixes"`, current round blockers as `priorFindings`, and pre-fix HEAD.
8. Stop when no critical/important unresolved findings or regressions remain.

## Result contract

Review mode returns:

```text
confirmed[]
clusters[]
dropped[]
report
```

Verify-fixes mode returns:

```text
addressed[]
resolved[]
unresolved[]
regressions[]
report
```


`addressed[]` is the compact ledger input. `resolved[]`, `unresolved[]`, and `regressions[]` keep full details only for current blockers so the loop can continue without carrying historical report prose.
