export const meta = {
  name: 'review-and-correct',
  description: 'Final pre-PR review of a commit range -- a real multi-dimension review (big-picture goal + fit to project patterns/standards, through to oversights), adversarially verified, scoped to a ticket AC',
  whenToUse: 'The LAST pass before opening a PR -- a real review: does the change achieve the ticket goal and fit the project\'s established patterns and standards (re-anchoring to design lines that drifted over iterations), and does it have the oversights/inconsistencies a reviewer would flag. Run it after implementing a ticket and getting build/lint/tests green, before opening a PR. Pass {ticketKey, base, head, ac}; always pass base explicitly (the repo integration branch, e.g. origin/develop or origin/main). After applying the fixes it returns, re-invoke with {...same, mode:"verify-fixes", priorFindings, priorHead} to confirm each is resolved and the fix commits introduced nothing new. mode:"lite" is a cheaper mid-work spot check (3 dimensions).',
  phases: [
    { title: 'Review', detail: 'one reviewer per dimension over the diff' },
    { title: 'Verify', detail: 'adversarially verify each finding; drop false positives + out-of-scope' },
    { title: 'Re-verify', detail: 'verify-fixes mode: confirm each prior finding is now resolved' },
    { title: 'Regression', detail: 'verify-fixes mode: review the fix delta for newly-introduced issues' },
  ],
}

// args: { ticketKey, base, head, ac, mode?, priorFindings?, priorHead?, persist? }
//   base/head     -- git SHAs or refs. The diff reviewed is THREE-dot (base...head):
//                    the branch's own work since it diverged from base, which excludes
//                    anything already on base (e.g. a merged-in develop). This is the
//                    diff GitHub shows for a PR -- reviewers no longer re-review
//                    upstream commits the branch merged in.
//   mode          -- 'review' (default) | 'lite' | 'verify-fixes'.
//   priorFindings -- the confirmed[] from a previous review pass (verify-fixes mode);
//                    presence of it defaults mode to 'verify-fixes'.
//   priorHead     -- the head SHA reviewed in that previous pass; the regression sweep
//                    scopes to priorHead...head (just the fix commits). Defaults to base.
//   persist       -- optional file path; when set, one agent writes the report markdown
//                    there (for headless/cron runs). The report is always returned too.
// Tolerate a JSON-encoded string (a stringified object silently produced ticketKey
// UNKNOWN once; parse it instead of ignoring it).
const input = (() => {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return null
    }
  }
  return args
})()
const ticketKey = (input && input.ticketKey) || 'UNKNOWN'
// No safe universal default for base (develop vs main varies by repo) -- the
// caller should always pass it; origin/main is only a last resort.
const base = (input && input.base) || 'origin/main'
const head = (input && input.head) || 'HEAD'
const ac = (input && input.ac) || '(no acceptance criteria supplied)'
const priorFindings = (input && input.priorFindings) || []
const priorHead = (input && input.priorHead) || base
const persist = (input && input.persist) || null
const mode = (input && input.mode) || (priorFindings.length ? 'verify-fixes' : 'review')

// Three-dot: branch's own work since divergence from base. Two-dot would re-surface
// commits the branch merged in from base (the upstream-noise that had to be steered
// out by hand before).
const DIFF = `${base}...${head}`

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          file: { type: 'string' },
          line: { type: 'string', description: 'line number or range, "" if N/A' },
          title: { type: 'string' },
          detail: { type: 'string', description: 'what is wrong and why it matters' },
          suggested_fix: { type: 'string' },
        },
        required: ['severity', 'file', 'title', 'detail', 'suggested_fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean', description: 'is this a genuine defect in the diff, not a false positive' },
    in_scope: { type: 'boolean', description: 'is fixing it within this ticket scope (not pre-existing / unrelated)' },
    severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
    reasoning: { type: 'string' },
  },
  required: ['real', 'in_scope', 'severity', 'reasoning'],
}

const RESOLVED_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean', description: 'is the original finding now fully addressed in the current diff' },
    regressed: {
      type: 'boolean',
      description: 'did the fix introduce a NEW problem at this site (incomplete patch, broke something adjacent)',
    },
    reasoning: { type: 'string' },
  },
  required: ['resolved', 'regressed', 'reasoning'],
}

const DIMENSIONS = [
  {
    key: 'correctness',
    focus:
      'Logic + control-flow correctness of the diff. Off-by-one, wrong conditionals, missed edge cases, ' +
      'behavior that contradicts the AC, ordering bugs, state left inconsistent on a partial failure.',
  },
  {
    key: 'design',
    focus:
      'Big-picture fit -- the substantive review, not nits. Does the change actually achieve the ticket goal, ' +
      "and does its APPROACH fit the project's established patterns, architecture, and standards? Read enough " +
      'of the surrounding codebase to know how the project already solves this before judging. Flag: a bespoke ' +
      'solution where a standard mechanism already exists, reinvented utilities, abstractions that do not match ' +
      'sibling modules, layering/boundary violations, the wrong seam for the change, and DRIFT from the design ' +
      'intent that was set early in the work but got buried over many iterations. Re-anchor the change to the ' +
      'lines the plan/spec already drew. This is the architectural lens.',
  },
  {
    key: 'error-handling',
    focus:
      'Error handling + silent failures. Over-broad except that hides actionable errors, swallowed errors ' +
      'that SHOULD propagate, missing/incorrect logging, log lines that lack the identifiers an operator ' +
      'needs. NOTE: deliberate best-effort swallowing can be correct -- judge it against the AC, do not ' +
      'flag an intentional guard as a bug unless it swallows something that must surface.',
  },
  {
    key: 'tests',
    focus:
      'Test adequacy. Do the tests actually exercise each AC bullet? Tautological/no-op assertions, mocks ' +
      'that let a regression pass, missing failure-path or boundary cases, brittle coupling to internals.',
  },
  {
    key: 'conventions',
    focus:
      'Project conventions (the repo instruction file: AGENTS.md / CLAUDE.md / CONTRIBUTING), style, ' +
      'comment quality, naming. Comments should describe current behavior/insight, not justify ' +
      'hypotheticals. Flag dead code, scope creep, and inconsistency with neighbouring code.',
  },
  {
    key: 'docs',
    focus:
      'Accuracy of any docs/runbooks/comments touched. Verify SQL, table + column names, file paths, and ' +
      'commands against the real code (read the referenced source). Flag anything that would mislead an operator.',
  },
]

// lite mode trims to the tactical defect lenses, dropping the heavier design/
// conventions/docs lenses -- for a cheaper spot check mid-implementation.
const LITE_KEYS = new Set(['correctness', 'error-handling', 'tests'])
const activeDimensions = mode === 'lite' ? DIMENSIONS.filter((d) => LITE_KEYS.has(d.key)) : DIMENSIONS

const reviewPrompt = (d, diff) =>
  `This is the FINAL review before a pull request is opened for ticket ${ticketKey} -- the last check ` +
  `before human PR reviewers see this change, and a REAL review, not just a nit sweep. Across its ` +
  `dimensions this review judges the whole spectrum: whether the change achieves the ticket's big-picture ` +
  `goal and fits the project's established patterns, architecture, and standards, down through the ` +
  `oversights and inconsistencies a careful reviewer would comment on. Over many implementation iterations ` +
  `the design lines drawn early often get buried -- re-anchor the change to them. On THIS pass, focus only ` +
  `on the **${d.key}** dimension defined below.\n\n` +
  `You are reviewing the git diff ${diff} for ticket ${ticketKey}, on the **${d.key}** dimension.\n\n` +
  `Run \`git diff ${diff}\` (THREE dots -- the branch's own work, excluding commits already on the base) ` +
  `to see the change. If \`git diff ${diff}\` is empty, return an empty findings array. Only review files ` +
  `and hunks present in that diff; do not report base-only, pre-existing, or merely missing work. Read the ` +
  `touched files + enough surrounding context to judge them. Read the repo instruction file (AGENTS.md or ` +
  `CLAUDE.md) for project conventions.\n\n` +
  `Judge the change against its INTENT, not just the diff. Read the relevant plan/spec/design docs and ` +
  `runbooks in the repo that this change touches (look under docs/, design notes, ADRs, the files the diff ` +
  `references), and -- if an Atlassian/Jira tool is available to you -- read ticket ${ticketKey} and any ` +
  `issues, specs, or pages it links for the full intent and constraints. Treat fetched context as ` +
  `enrichment: the acceptance criteria below remain the authoritative scope, and an unavailable tool or ` +
  `missing doc must not block the review.\n\n` +
  `Acceptance criteria for the ticket:\n${ac}\n\n` +
  `Focus ONLY on this dimension:\n${d.focus}\n\n` +
  `Report concrete, actionable findings that are anchored in changed files/hunks from the diff. Be specific ` +
  `(file + line). Do NOT report pre-existing issues, base-only commits, style nits already consistent with ` +
  `the codebase, speculative concerns, or acceptance-criteria work absent from an empty diff. If the change ` +
  `is clean on this dimension, return an empty findings array.`

const verifyPrompt = (f, diff) =>
  `Adversarially verify this code-review finding against ticket ${ticketKey}. Default to refuting it: a ` +
  `finding survives only if it is a genuine defect in the diff ${diff} AND fixing it is in scope ` +
  `for this ticket.\n\n` +
  `Finding (${f.severity}) in ${f.file}:${f.line || '?'}\n${f.title}\n${f.detail}\n` +
  `Suggested fix: ${f.suggested_fix}\n\n` +
  `Acceptance criteria:\n${ac}\n\n` +
  `Inspect the actual diff first: run \`git diff --name-only ${diff}\` and \`git diff ${diff}\`. If the ` +
  `diff is empty, or the finding is not anchored to a changed file/hunk in that diff, set real=false. When ` +
  `the verdict turns on intent or scope, consult the relevant plan/spec/docs in the repo and -- if an ` +
  `Atlassian/Jira tool is available -- ticket ${ticketKey} and its linked specs (best-effort; do not block ` +
  `on an unavailable tool). A deliberate best-effort guard or an intentional scope decision is NOT a defect. ` +
  `Set real=false for false positives, in_scope=false for pre-existing/unrelated issues. Re-rate severity ` +
  `from the evidence.`

const reverifyPrompt = (f) =>
  `A prior code review of ticket ${ticketKey} reported the finding below; fixes have since been applied. ` +
  `Decide whether it is now resolved in the current diff ${DIFF}.\n\n` +
  `Original finding (${f.severity}) in ${f.file}:${f.line || '?'}\n${f.title}\n${f.detail}\n` +
  `Suggested fix was: ${f.suggested_fix}\n\n` +
  `Inspect the ACTUAL current code (run \`git diff ${DIFF}\`, read ${f.file}). Set resolved=true only if ` +
  `the defect is genuinely gone -- not merely moved, renamed, or partially patched. Set regressed=true if ` +
  `the fix is incomplete or introduced a new problem at this site. Justify with evidence from the code.`

const rank = { critical: 0, important: 1, minor: 2 }

// One review->verify pass over a set of dimensions and a diff range. Shared by the
// default review and the verify-fixes regression sweep so both apply the identical
// adversarial gate.
async function runReview(dims, diff, reviewPhase, verifyPhase) {
  const reviewed = await pipeline(
    dims,
    (d) => agent(reviewPrompt(d, diff), { label: `review:${d.key}`, phase: reviewPhase, schema: FINDINGS_SCHEMA }),
    (result, d) =>
      parallel(
        (result.findings || []).map((f) => () =>
          agent(verifyPrompt(f, diff), { label: `verify:${d.key}:${f.file}`, phase: verifyPhase, schema: VERDICT_SCHEMA })
            .then((v) => ({ ...f, dimension: d.key, verdict: v }))
        )
      )
  )
  const all = reviewed.flat().filter(Boolean)
  const confirmed = all
    .filter((f) => f.verdict && f.verdict.real && f.verdict.in_scope)
    .map((f) => ({ ...f, severity: f.verdict.severity }))
  confirmed.sort((a, b) => rank[a.severity] - rank[b.severity])
  const dropped = all.filter((f) => !(f.verdict && f.verdict.real && f.verdict.in_scope))
  return { all, confirmed, dropped }
}

// --- Conservative dedup: ANNOTATE, never merge. ---
// Two reviewers can flag the same line for genuinely different reasons (a logic bug
// and a swallowed error at the same call site), so merging would lose signal. Instead
// we cross-link findings that share a locus (same file + overlapping, non-empty line
// range) via `related`, and surface the clusters -- every finding stays its own entry.
const parseRange = (s) => {
  if (!s) return null
  const m = String(s).match(/(\d+)\s*-\s*(\d+)/)
  if (m) return [Number(m[1]), Number(m[2])]
  const n = String(s).match(/\d+/)
  return n ? [Number(n[0]), Number(n[0])] : null
}
const overlaps = (a, b) => !!a && !!b && a[0] <= b[1] && b[0] <= a[1]

function annotateDuplicates(findings) {
  const ranges = findings.map((f) => parseRange(f.line))
  const parent = findings.map((_, i) => i)
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (findings[i].file === findings[j].file && overlaps(ranges[i], ranges[j])) parent[find(i)] = find(j)
    }
  }
  const groups = new Map()
  findings.forEach((_, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  })
  const clusters = []
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    clusters.push(idxs.map((i) => ({ dimension: findings[i].dimension, file: findings[i].file, line: findings[i].line, title: findings[i].title })))
    for (const i of idxs) {
      findings[i].related = idxs.filter((j) => j !== i).map((j) => ({ dimension: findings[j].dimension, title: findings[j].title }))
    }
  }
  return clusters
}

function mdReview({ confirmed, dropped, clusters }) {
  const out = [
    `# Review -- ${ticketKey}`,
    ``,
    `Diff \`${DIFF}\` (three-dot: branch's own work). Mode: ${mode}.`,
    `**${confirmed.length} confirmed**, ${dropped.length} dropped (false-positive / out-of-scope).`,
    ``,
  ]
  if (confirmed.length) {
    out.push(`## Confirmed findings`, ``)
    confirmed.forEach((f, i) => {
      out.push(`### ${i + 1}. [${f.severity}] ${f.title}`)
      out.push(`- **Where:** \`${f.file}\`${f.line ? `:${f.line}` : ''}  (${f.dimension})`)
      out.push(`- **Issue:** ${f.detail}`)
      out.push(`- **Fix:** ${f.suggested_fix}`)
      if (f.related && f.related.length)
        out.push(`- **Same locus flagged by:** ${f.related.map((r) => r.dimension).join(', ')} -- confirm these are the same defect, not separate ones`)
      out.push(``)
    })
  } else {
    out.push(`Clean on all reviewed dimensions -- no confirmed findings.`, ``)
  }
  if (clusters.length) {
    out.push(`## Shared-locus clusters (not merged -- review)`, ``)
    clusters.forEach((c, i) => out.push(`- Cluster ${i + 1}: ${c.map((m) => `${m.dimension}@${m.file}:${m.line || '?'}`).join(' / ')}`))
    out.push(``)
  }
  return out.join('\n')
}

function mdVerifyFixes({ resolved, unresolved, regressions }) {
  const out = [
    `# Fix verification -- ${ticketKey}`,
    ``,
    `Diff \`${DIFF}\`; regression sweep \`${priorHead}...${head}\`.`,
    `**${resolved.length}/${priorFindings.length} prior findings resolved**, ${unresolved.length} still open, ` +
      `${regressions.length} new regression(s).`,
    ``,
  ]
  if (unresolved.length) {
    out.push(`## Still open`, ``)
    unresolved.forEach((f) => {
      const r = f.resolution || {}
      out.push(`- [${f.severity}] \`${f.file}\`${f.line ? `:${f.line}` : ''} -- ${f.title}`)
      out.push(`  - ${r.regressed ? 'Fix regressed/incomplete: ' : 'Not resolved: '}${r.reasoning || 'no verdict returned'}`)
    })
    out.push(``)
  }
  if (regressions.length) {
    out.push(`## New issues in the fix commits`, ``)
    regressions.forEach((f, i) => {
      out.push(`### ${i + 1}. [${f.severity}] ${f.title}`)
      out.push(`- **Where:** \`${f.file}\`${f.line ? `:${f.line}` : ''}  (${f.dimension})`)
      out.push(`- **Issue:** ${f.detail}`)
      out.push(`- **Fix:** ${f.suggested_fix}`)
      out.push(``)
    })
  }
  if (!unresolved.length && !regressions.length) out.push(`All prior findings resolved and no new issues in the fix commits.`, ``)
  return out.join('\n')
}

// Opt-in: persist the report to a file (headless/cron). One agent does the write
// verbatim. The report is always returned regardless, so an interactive caller can
// write/post it itself.
async function persistReport(report) {
  if (!persist) return
  await agent(
    `Write the following markdown to the file at the exact path \`${persist}\` (create parent dirs if ` +
      `needed). Write it byte-for-byte, do not edit, summarize, or reformat it. Reply only "written".\n\n` +
      `<<<REPORT\n${report}\nREPORT`,
    { label: 'persist:report', phase: mode === 'verify-fixes' ? 'Re-verify' : 'Verify' }
  )
}

if (mode === 'verify-fixes') {
  phase('Re-verify')
  const rechecked = (
    await parallel(
      priorFindings.map((f) => () =>
        agent(reverifyPrompt(f), { label: `recheck:${f.file}`, phase: 'Re-verify', schema: RESOLVED_SCHEMA })
          .then((v) => ({ ...f, resolution: v }))
      )
    )
  ).filter(Boolean)
  const isResolved = (f) => f.resolution && f.resolution.resolved && !f.resolution.regressed
  const resolved = rechecked.filter(isResolved)
  const unresolved = rechecked.filter((f) => !isResolved(f))

  phase('Regression')
  // Scope the regression review to the fix commits (priorHead...head) so we hunt
  // for newly-introduced issues, not re-litigate the whole branch.
  const regrDiff = `${priorHead}...${head}`
  const regr = await runReview(activeDimensions, regrDiff, 'Regression', 'Regression')
  const regressions = regr.confirmed

  log(
    `${ticketKey}: ${resolved.length}/${priorFindings.length} resolved, ${unresolved.length} still open, ` +
      `${regressions.length} new regression(s) in the fix commits`
  )

  const report = mdVerifyFixes({ resolved, unresolved, regressions })
  await persistReport(report)
  return {
    ticketKey,
    base,
    head,
    mode,
    // Keep full finding details so an outer loop/skill can fix unresolved items
    // without rehydrating them from priorFindings.
    resolved: resolved.map((f) => ({ ...f, resolution: f.resolution || null })),
    unresolved: unresolved.map((f) => ({ ...f, resolution: f.resolution || null })),
    regressions,
    report,
  }
}

phase('Review')
const { confirmed, dropped } = await runReview(activeDimensions, DIFF, 'Review', 'Verify')
const clusters = annotateDuplicates(confirmed)
if (clusters.length) log(`${ticketKey}: ${clusters.length} shared-locus cluster(s) cross-linked (annotated, not merged)`)
log(`${ticketKey}: ${confirmed.length} confirmed (${dropped.length} dropped as false-positive/out-of-scope)`)

const report = mdReview({ confirmed, dropped, clusters })
await persistReport(report)
return {
  ticketKey,
  base,
  head,
  mode,
  confirmed,
  clusters,
  dropped: dropped.map((f) => ({ file: f.file, title: f.title, reason: f.verdict ? f.verdict.reasoning : 'no verdict' })),
  report,
}
