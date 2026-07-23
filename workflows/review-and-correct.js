export const meta = {
  name: 'review-and-correct',
  description: 'Final pre-PR review of a commit range: shared-context review, adversarial verification, ticket-scoped output',
  whenToUse: 'Run after implementation and build/lint/tests are green, before opening a PR. Pass {ticketKey, base, head, ac}; always pass base explicitly. After fixes, re-run with {...same, mode:"verify-fixes", priorFindings, priorHead} to confirm current blockers are resolved and the fix commits introduced nothing new.',
  phases: [
    { title: 'Orient', detail: 'one pass builds a shared context packet (diff, touched-symbol callers/callees, doc excerpts, risk hunks) reused by every later phase' },
    { title: 'Review', detail: 'two wide-scope reviewers (behavior: correctness/error-handling/tests; structure: design/conventions/docs) over the diff, seeded with the context packet' },
    { title: 'Verify', detail: 'adversarially verify each finding; prefer running a concrete verify_command over speculation; drop false positives + out-of-scope' },
    { title: 'Re-verify', detail: 'verify-fixes mode: re-review the CURRENT code at each prior finding locus (evidence-first; lines are stale, re-locate by symbol; prefer execution evidence for behavioral claims)' },
    { title: 'Regression', detail: 'verify-fixes mode: review only the fix delta (priorHead...head) for newly-introduced issues, seeded with the same context packet' },
  ],
}

// args: { ticketKey, base, head, ac, mode?, priorFindings?, priorHead? }
//   base/head     -- git SHAs or refs. The diff reviewed is THREE-dot (base...head):
//                    the branch's own work since it diverged from base, which excludes
//                    anything already on base (e.g. a merged-in develop). This is the
//                    diff GitHub shows for a PR -- reviewers no longer re-review
//                    upstream commits the branch merged in.
//   mode          -- 'review' (default) | 'verify-fixes'.
//   priorFindings -- current round blockers being verified (not cumulative history);
//                    presence of any defaults mode to 'verify-fixes'.
//   priorHead     -- the head SHA before the current fix round; the regression sweep
//                    scopes to priorHead...head (just the fix commits). Defaults to base.
//   codegraphContext -- optional pre-built context packet (e.g. `codegraph review`/`impact`
//                    output the caller already gathered). When supplied, the Orient phase
//                    is skipped entirely instead of re-deriving the same facts.
//   riskHunks     -- optional [{file, line?, reason}], paired with codegraphContext; hunks
//                    reviewers should scrutinize closely instead of spreading effort evenly.
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
// Optional pre-built context (e.g. `codegraph review`/`impact` output the caller already
// gathered before invoking the workflow). When supplied, the Orient phase is skipped
// entirely instead of re-deriving the same facts via an extra agent call.
const callerContext = (input && input.codegraphContext) || ''
const callerRiskHunks = Array.isArray(input && input.riskHunks) ? input.riskHunks : []
const mode = input && input.mode === 'verify-fixes' ? 'verify-fixes' : priorFindings.length ? 'verify-fixes' : 'review'

// Three-dot: branch's own work since divergence from base. Two-dot would re-surface
// commits the branch merged in from base (the upstream-noise that had to be steered
// out by hand before).
const DIFF = `${base}...${head}`

// One findings schema per invocation, parameterized by the sub-dimensions in play
// (a review group's members, or the full DIMENSIONS list for the regression sweep).
// Each finding self-tags its `dimension` -- required because one reviewer now covers
// several sub-dimensions in a single pass; reporting/clustering still needs the
// finer-grained tag.
const findingsSchema = (dimKeys) => ({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          dimension: { type: 'string', enum: dimKeys, description: 'which sub-dimension this finding belongs to' },
          file: { type: 'string' },
          line: { type: 'string', description: 'line number or range, "" if N/A' },
          title: { type: 'string', description: 'short issue title' },
          detail: { type: 'string', description: 'concise evidence: what is wrong and why it matters, 1-3 sentences' },
          suggested_fix: { type: 'string', description: 'concise fix direction, not a patch' },
          verify_command: {
            type: 'string',
            description:
              'A concrete, cheap, read-only command (test/build/repro) that would prove or disprove this finding, ' +
              'ONLY when the claim is behavioral (threshold, tolerance, timing, replication, concurrency). Empty ' +
              'string if the finding is structural/stylistic or no cheap repro exists -- do not invent one.',
          },
        },
        required: ['severity', 'dimension', 'file', 'title', 'detail', 'suggested_fix'],
      },
    },
  },
  required: ['findings'],
})

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    real: { type: 'boolean', description: 'is this a genuine defect in the diff, not a false positive' },
    in_scope: { type: 'boolean', description: 'is fixing it within this ticket scope (not pre-existing / unrelated)' },
    severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
    evidence_type: {
      type: 'string',
      enum: ['execution', 'code-reading'],
      description: 'execution if a verify_command (or an obvious equivalent gate) was actually run and grounds this verdict; code-reading otherwise',
    },
    reasoning: { type: 'string', description: 'brief evidence for the verdict; quote command output when evidence_type is execution' },
  },
  required: ['real', 'in_scope', 'severity', 'evidence_type', 'reasoning'],
}

const RESOLVED_SCHEMA = {
  type: 'object',
  properties: {
    current_evidence: {
      type: 'string',
      description:
        'A short VERBATIM quote of the CURRENT post-fix code (or, when evidence_type is execution, the relevant ' +
        'command output) at the finding\'s locus, re-located by symbol/content (line numbers from the prior finding ' +
        'have SHIFTED under the fix commit -- do NOT trust them). Use "<absent>" if the described code/defect no ' +
        'longer exists. This quote is the REQUIRED basis for the verdict.',
    },
    evidence_type: {
      type: 'string',
      enum: ['execution', 'code-reading'],
      description:
        'execution if a verify_command (or the project\'s existing test/build gate covering this code path) was ' +
        'actually run to ground the verdict. For behavioral claims (thresholds, tolerances, timing, replication, ' +
        'concurrency) prefer running the gate over reasoning from the diff; use code-reading only when no cheap ' +
        'execution path exists.',
    },
    resolved: {
      type: 'boolean',
      description:
        'true UNLESS you can point to the original defect STILL present in current_evidence. Code that is gone, ' +
        'removed, or replaced is resolved. Never infer "still broken" from the prior description alone.',
    },
    regressed: {
      type: 'boolean',
      description: 'did the fix introduce a NEW problem at this site, visible in current_evidence (incomplete patch, broke something adjacent)',
    },
    reasoning: { type: 'string', description: 'brief justification grounded ONLY in current_evidence' },
  },
  required: ['current_evidence', 'evidence_type', 'resolved', 'regressed', 'reasoning'],
}

// Canonical sub-dimensions. Kept fine-grained for reporting/clustering and for the
// regression sweep; REVIEW/RE-REVIEW passes cover them via the two wide GROUPS below
// rather than one reviewer agent per dimension, so a diff gets 2 fresh-context reads
// instead of 6.
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
      'Solution shape and architecture. Does the change achieve the ticket goal at the right seam, with the ' +
      'right ownership, data flow, boundaries, and existing mechanisms? Flag wrong abstractions, layering ' +
      'violations, duplicated subsystems/utilities, lifecycle/API contract mismatches, and material scope changes that alter behavior or risk.',
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
      'Local repo conventions and maintainability hygiene. Check instruction files plus nearby code for naming, ' +
      'file placement, exports, comments, dead code, and idiomatic local patterns. Do not flag harmless cleanup ' +
      'or minor style drift; flag only convention issues that materially hurt readability, maintainability, or reviewability.',
  },
  {
    key: 'docs',
    focus:
      'Accuracy of any docs/runbooks/comments touched. Verify SQL, table + column names, file paths, and ' +
      'commands against the real code (read the referenced source). Flag anything that would mislead an operator.',
  },
]
const dim = (key) => DIMENSIONS.find((d) => d.key === key)

// Two wide-scope reviewers instead of one-per-dimension. Each still owns independent
// judgment over its members (no single verdict is diluted), but the diff and repo
// context are only re-read twice, not six times.
const GROUPS = [
  {
    key: 'behavior',
    label: 'runtime + tests',
    dims: ['correctness', 'error-handling', 'tests'],
  },
  {
    key: 'structure',
    label: 'design + docs',
    dims: ['design', 'conventions', 'docs'],
  },
]
const groupFocus = (g) => g.dims.map((k) => `### ${k}\n${dim(k).focus}`).join('\n\n')

const rank = { critical: 0, important: 1, minor: 2 }

// --- Orient: one shared context packet, built once, reused by every reviewer/verifier. ---
// Reviewers previously each re-derived the same facts (call sites, related fields, doc
// claims) independently. This single pass gathers them once; its output is inlined into
// every later prompt so nobody re-pays that exploration cost. It also flags dense/risky
// hunks so reviewers weight scrutiny instead of spreading it uniformly across the diff.
const ORIENT_SCHEMA = {
  type: 'object',
  properties: {
    packet: {
      type: 'string',
      description:
        'Markdown context packet for ticket reviewers: diff summary (files + hunk shapes), each touched exported ' +
        'symbol with its callers/callees (codegraph CLI/MCP if available in this repo, e.g. `codegraph impact ' +
        '--provider git --base <base> --head <head> --pretty`; otherwise git diff + grep/lsp by hand -- codegraph ' +
        'is an optional accelerant, never a requirement), and excerpts from any doc/runbook/spec the diff touches ' +
        'or that documents the touched behavior. This is handed verbatim to reviewers so they do not need to ' +
        're-derive it; keep it factual and citation-anchored (file:line), not conclusions about defects.',
    },
    risk_hunks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'string', description: 'line number or range, "" if N/A' },
          reason: {
            type: 'string',
            description:
              'why this hunk is semantically dense / worth close scrutiny, e.g.: a conditional guard that skips a ' +
              'call (replication, cleanup, notification), a value computed but never read/used, a changed threshold ' +
              'tolerance/timing/ordering, or a change to replication/concurrency-sensitive state',
          },
        },
        required: ['file', 'reason'],
      },
      description:
        'Hunks that deserve a full reasoning pass, ranked by suspicion. Reviewers should still cover the whole ' +
        'diff, but concentrate scrutiny here rather than spreading it evenly; hunks with no risk signal and no ' +
        'behavioral surface (pure rename/format/comment-only) can be confirmed quickly.',
    },
  },
  required: ['packet', 'risk_hunks'],
}

const orientPrompt = (diff) =>
  `Build a shared context packet for the pre-PR review of ticket ${ticketKey}'s diff ${diff}. This is a research ` +
  `pass, not a review: do not judge the change or report defects, and do not modify files.\n\n` +
  `1. Run \`git diff --stat ${diff}\` then \`git diff ${diff}\` (THREE dots -- the branch's own work, excluding ` +
  `commits already on the base) to see every changed file and hunk.\n` +
  `2. For each touched exported/public symbol (function, method, type, config key) that other code depends on, ` +
  `find its callers and callees so reviewers know the blast radius without re-deriving it themselves. Codegraph ` +
  `is an OPTIONAL accelerant, not a dependency -- check once whether it's available (the \`codegraph\` CLI on ` +
  `PATH, or codegraph MCP/skill tools registered) and never try to install it or fail this pass if it isn't:\n` +
  `   - If available: run \`codegraph impact --provider git --base ${base} --head ${head} --pretty\` (or the ` +
  `refs/callers/callees/impact tools) for a fast, evidence-grounded map of touched symbols and blast radius.\n` +
  `   - If not available: fall back to \`git diff ${diff}\` plus grep/lsp/read -- follow imports and call sites ` +
  `by hand and do your best to capture the same callers/callees/blast-radius picture manually.\n` +
  `3. Read the repo instruction file (AGENTS.md or CLAUDE.md) plus any in-repo doc/runbook/spec that the diff ` +
  `touches or that documents the touched behavior; pull the sections relevant to this diff.\n` +
  `4. Scan the diff for hunks worth close scrutiny and list them in risk_hunks: a conditional guard that skips a ` +
  `call (e.g. a replication/notification/cleanup call now only fires on one branch), a value that is computed but ` +
  `never read afterward, a changed numeric threshold/tolerance/timing window, or an edit to ` +
  `replication/concurrency-sensitive state. Do not flag pure rename/format/comment-only hunks.\n\n` +
  `Write the packet as factual, citation-anchored (file:line) notes a reviewer can trust and build on -- not ` +
  `conclusions about whether anything is wrong. If \`git diff ${diff}\` is empty, return an empty packet and an ` +
  `empty risk_hunks array.`

const packetSection = (contextPacket, riskHunks) => {
  if (!contextPacket && !(riskHunks && riskHunks.length)) return ''
  const risk = (riskHunks || [])
    .map((r) => `- \`${r.file}\`${r.line ? `:${r.line}` : ''} -- ${r.reason}`)
    .join('\n')
  return (
    `\n\nPre-built context packet (facts only; verify against the live diff/code rather than trusting it blindly, ` +
    `and go beyond it if it is incomplete -- but you should not need to re-derive callers/callees or doc context ` +
    `from scratch):\n${contextPacket || '(empty)'}\n\n` +
    (risk
      ? `Hunks flagged as worth close scrutiny (concentrate reasoning here; hunks with no signal and no behavioral ` +
        `surface can be confirmed quickly):\n${risk}\n`
      : '')
  )
}

const reviewPrompt = (g, diff, contextPacket, riskHunks) =>
  `Final pre-PR review for ticket ${ticketKey}. Judge whether the diff satisfies the acceptance criteria, fits ` +
  `established repo patterns, and contains issues a human reviewer should block. On this pass, cover ALL of the ` +
  `following sub-dimensions together (**${g.label}**) -- they are reviewed as one wide pass, not split further:\n\n` +
  `You are reviewing the git diff ${diff} for ticket ${ticketKey}. Review only: do not modify files, run ` +
  `formatters, commit, or push.\n\n` +
  `Run \`git diff ${diff}\` (THREE dots -- the branch's own work, excluding commits already on the base) to see ` +
  `the change. If \`git diff ${diff}\` is empty, return an empty findings array. Only review files and hunks ` +
  `present in that diff; do not report base-only, pre-existing, or merely missing work. Read the touched files + ` +
  `enough surrounding context to judge them.\n\n` +
  `Judge the change against its INTENT, not just the diff. Treat repo context as enrichment: the acceptance ` +
  `criteria below remain authoritative. The AC may include later user/session clarifications or approved ` +
  `deviations; treat those as authoritative over older AC/plan/docs. If the implementation directly contradicts ` +
  `the effective AC in total or on a key criterion, do not infer changed scope; report the source-vs-implementation ` +
  `difference as a blocking finding.\n\n` +
  `Acceptance criteria (including any user/session clarifications or approved deviations):\n${ac}\n\n` +
  `Sub-dimensions to cover this pass (tag each finding's \`dimension\` with the matching key):\n\n${groupFocus(g)}` +
  packetSection(contextPacket, riskHunks) +
  `\n\nWhen a finding's claim is behavioral (a threshold, tolerance, timing window, replication/ordering guarantee), ` +
  `set \`verify_command\` to a concrete, cheap, read-only command that would prove or disprove it (an existing test, ` +
  `a repro script) -- leave it empty if none exists or the finding is structural/stylistic.\n\n` +
  `Report concrete, actionable findings that are anchored in changed files/hunks from the diff. Be specific ` +
  `(file + line). Do NOT report pre-existing issues, base-only commits, harmless cleanup, minor style drift, ` +
  `or acceptance-criteria work absent from an empty diff. If the change is clean on every sub-dimension above, ` +
  `return an empty findings array.`

const verifyPrompt = (f, diff, contextPacket) =>
  `Adversarially verify this code-review finding against ticket ${ticketKey}. Default to refuting it: a ` +
  `finding survives only if it is a genuine defect in the diff ${diff} AND fixing it is in scope ` +
  `for this ticket.\n\n` +
  `Finding (${f.severity}, ${f.dimension || 'unknown dimension'}) in ${f.file}:${f.line || '?'}\n${f.title}\n${f.detail}\n` +
  `Suggested fix: ${f.suggested_fix}\n` +
  (f.verify_command ? `Suggested verify command: \`${f.verify_command}\`\n` : '') +
  `\nAcceptance criteria (including any user/session clarifications or approved deviations):\n${ac}\n` +
  packetSection(contextPacket) +
  `\nInspect the actual diff first: run \`git diff --name-only ${diff}\` and \`git diff ${diff}\`. Do not modify ` +
  `files. If a verify_command was suggested (or an equivalent fast test/build/repro exists) and it is safe and ` +
  `cheap to run, RUN it and ground your verdict in its output -- set evidence_type='execution' and quote the ` +
  `relevant output in reasoning; this is strictly more reliable than reasoning about the diff for behavioral ` +
  `claims (thresholds, tolerances, timing, replication). Use evidence_type='code-reading' only when no cheap ` +
  `execution path exists. If the diff is empty, or the finding is not anchored to a changed file/hunk in that ` +
  `diff, set real=false. When the verdict turns on intent or scope, consult the relevant in-repo plan/spec/docs, ` +
  `but treat later user/session clarifications in the AC as authoritative. If the evidence shows direct ` +
  `contradiction with the effective AC/source material, keep the finding in scope and summarize the contradiction; ` +
  `do not infer changed scope. Re-rate severity from the evidence.`

// Re-REVIEW the current code at the finding's locus, do NOT re-judge the stale finding text.
// We feed only the MINIMAL claim (file + dimension + title) -- never the prior detail/suggested-fix
// narrative or its (now-shifted) line numbers, which previously anchored the verifier into
// confirming an already-fixed finding. The verdict must be grounded in a verbatim quote of the
// CURRENT code (RESOLVED_SCHEMA.current_evidence), and the default is RESOLVED unless the original
// defect can be pointed to in that quote.
const reverifyPrompt = (f, contextPacket) =>
  `A prior review of ${ticketKey} flagged a ${f.dimension || 'code'} issue in \`${f.file}\` titled "${f.title}". ` +
  `Fixes have since been committed. Determine, FROM THE CURRENT CODE ONLY, whether that issue still exists.\n\n` +
  `Do NOT trust the prior finding's description, suggested fix, or line numbers -- the line numbers have SHIFTED ` +
  `under the fix commit, so re-locate the relevant code by SYMBOL / function name / content, never by line number. ` +
  `Treat the title as a hint about WHERE to look, not as evidence of the current state.\n` +
  (f.verify_command ? `The original finding suggested this verify command: \`${f.verify_command}\`.\n` : '') +
  packetSection(contextPacket) +
  `\nSteps:\n` +
  `1. Run \`git diff ${DIFF} -- ${f.file}\` and read the current \`${f.file}\` to see the post-fix code.\n` +
  `2. Re-locate the code the finding was about (by symbol/content).\n` +
  `3. If a verify_command was suggested, or the project has an obvious fast gate (unit test/build) covering this ` +
  `code path, RUN it -- for behavioral claims (thresholds, tolerances, timing, replication) this is strictly more ` +
  `reliable than re-reading the diff. Set evidence_type='execution' and quote the relevant output. Fall back to ` +
  `'code-reading' only when no cheap execution path exists.\n` +
  `4. Quote the CURRENT evidence (code or command output) verbatim into current_evidence (or "<absent>" if that ` +
  `code/defect no longer exists).\n` +
  `5. Set resolved=true UNLESS you can point to the ORIGINAL defect still present in that quoted current evidence. ` +
  `A defect that is gone, removed, or replaced is resolved -- do not infer "still broken" from the prior text alone.\n` +
  `6. Set regressed=true only if the fix introduced a NEW problem at this site, visible in the current evidence. ` +
  `Justify in reasoning using ONLY current_evidence. Do not modify files.`

// One review->verify pass over a set of review groups and a diff range. Shared by the
// default review and the verify-fixes regression sweep so both apply the identical
// adversarial gate. `groups` items need only `.key` + `.label` + `.dims` -- both call
// sites pass GROUPS, so the regression sweep gets the same two wide-scope passes.
async function runReview(groups, diff, reviewPhase, verifyPhase, contextPacket, riskHunks) {
  const reviewed = await pipeline(
    groups,
    (g) => agent(reviewPrompt(g, diff, contextPacket, riskHunks), { label: `review:${g.key}`, phase: reviewPhase, schema: findingsSchema(g.dims) }),
    (result, g) =>
      parallel(
        (result.findings || []).map((f) => () =>
          agent(verifyPrompt(f, diff, contextPacket), { label: `verify:${g.key}:${f.file}`, phase: verifyPhase, schema: VERDICT_SCHEMA })
            .then((v) => ({ ...f, dimension: f.dimension || g.key, verdict: v }))
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

function mdReview({ confirmed, dropped }) {
  const out = [
    `# Review -- ${ticketKey}`,
    ``,
    `Diff \`${DIFF}\` (three-dot: branch's own work). Mode: ${mode}.`,
    `**${confirmed.length} confirmed**, ${dropped.length} dropped (false-positive / out-of-scope).`,
    ``,
  ]
  if (confirmed.length) {
    out.push(`## Confirmed findings`, ``)
    confirmed.forEach((f) => {
      const related = f.related && f.related.length ? `; related: ${f.related.map((r) => r.dimension).join(', ')}` : ''
      const exec = f.verdict && f.verdict.evidence_type === 'execution' ? ' [exec-verified]' : ''
      out.push(`- [${f.severity}] \`${f.file}\`${f.line ? `:${f.line}` : ''} (${f.dimension}) -- ${f.title}${related}${exec}`)
    })
  } else {
    out.push(`Clean on all reviewed dimensions -- no confirmed findings.`, ``)
  }
  return out.join('\n')
}

const compactFinding = (f) => ({
  severity: f.severity,
  file: f.file,
  line: f.line || '',
  title: f.title,
})

function mdVerifyFixes({ resolved, unresolved, regressions }) {
  const out = [
    `# Fix verification -- ${ticketKey}`,
    ``,
    `Diff \`${DIFF}\`; regression sweep \`${priorHead}...${head}\`.`,
    `**${resolved.length}/${priorFindings.length} prior findings resolved**, ${unresolved.length} still open, ` +
      `${regressions.length} new regression(s).`,
    ``,
  ]
  if (resolved.length) {
    out.push(`## Addressed this round`, ``)
    resolved.forEach((f) => {
      const exec = f.resolution && f.resolution.evidence_type === 'execution' ? ' [exec-verified]' : ''
      out.push(`- [${f.severity}] \`${f.file}\`${f.line ? `:${f.line}` : ''} -- ${f.title}${exec}`)
    })
    out.push(``)
  }
  if (unresolved.length) {
    out.push(`## Still open`, ``)
    unresolved.forEach((f) => {
      const r = f.resolution || {}
      out.push(`- [${f.severity}] \`${f.file}\`${f.line ? `:${f.line}` : ''} -- ${f.title}`)
      out.push(`  - ${r.regressed ? 'Fix regressed/incomplete: ' : 'Not resolved: '}${r.reasoning || 'no verdict returned'}`)
      if (r.current_evidence) out.push(`  - current evidence (${r.evidence_type || 'code-reading'}): \`${String(r.current_evidence).replace(/\n/g, ' ').slice(0, 200)}\``)
    })
    out.push(``)
  }
  if (regressions.length) {
    out.push(`## New issues in the fix commits`, ``)
    regressions.forEach((f, i) => {
      out.push(`- [${f.severity}] \`${f.file}\`${f.line ? `:${f.line}` : ''} (${f.dimension}) -- ${f.title}`)
    })
  }
  if (!unresolved.length && !regressions.length) out.push(`All prior findings resolved and no new issues in the fix commits.`, ``)
  return out.join('\n')
}

// --- Orient once, up front. Every later phase (review, verify, re-verify, regression) ---
// reuses this same packet instead of re-deriving callers/callees/doc context per reviewer.
phase('Orient')
let contextPacket = callerContext
let riskHunks = callerRiskHunks
if (!contextPacket) {
  const orient = await agent(orientPrompt(DIFF), { label: 'orient', phase: 'Orient', schema: ORIENT_SCHEMA })
  contextPacket = (orient && orient.packet) || ''
  riskHunks = riskHunks.length ? riskHunks : (orient && orient.risk_hunks) || []
  log(`${ticketKey}: context packet built (${contextPacket.length} chars), ${riskHunks.length} risk hunk(s) flagged`)
} else {
  log(`${ticketKey}: using caller-supplied context packet (${contextPacket.length} chars), ${riskHunks.length} risk hunk(s) -- Orient pass skipped`)
}

if (mode === 'verify-fixes') {
  phase('Re-verify')
  const rechecked = (
    await parallel(
      priorFindings.map((f) => () =>
        agent(reverifyPrompt(f, contextPacket), { label: `recheck:${f.file}`, phase: 'Re-verify', schema: RESOLVED_SCHEMA })
          .then((v) => ({ ...f, resolution: v }))
      )
    )
  ).filter(Boolean)
  const isResolved = (f) => f.resolution && f.resolution.resolved && !f.resolution.regressed
  const resolved = rechecked.filter(isResolved)
  const unresolved = rechecked.filter((f) => !isResolved(f))

  phase('Regression')
  // Scope the regression review to the fix commits (priorHead...head) so we hunt for
  // newly-introduced issues, not re-litigate the whole branch -- this is the "only
  // review what changed since the last verdict" scoping: unchanged hunks from earlier
  // rounds are never re-reviewed. If the fix round produced no new commits (priorHead
  // === head, e.g. a re-verify retry with nothing to sweep), skip the sweep entirely.
  const regrDiff = `${priorHead}...${head}`
  const regr =
    priorHead === head
      ? { confirmed: [] }
      : await runReview(GROUPS, regrDiff, 'Regression', 'Regression', contextPacket, riskHunks)
  const regressions = regr.confirmed

  log(
    `${ticketKey}: ${resolved.length}/${priorFindings.length} resolved, ${unresolved.length} still open, ` +
      `${regressions.length} new regression(s) in the fix commits`
  )

  const addressed = resolved.map(compactFinding)
  const report = mdVerifyFixes({ resolved, unresolved, regressions })
  return {
    ticketKey,
    base,
    head,
    mode,
    // Compact list for session-only loop summaries.
    addressed,
    // Keep full finding details so an outer loop/skill can fix unresolved items
    // without rehydrating them from priorFindings.
    resolved: resolved.map((f) => ({ ...f, resolution: f.resolution || null })),
    unresolved: unresolved.map((f) => ({ ...f, resolution: f.resolution || null })),
    regressions,
    report,
  }
}

phase('Review')
const { confirmed, dropped } = await runReview(GROUPS, DIFF, 'Review', 'Verify', contextPacket, riskHunks)
const clusters = annotateDuplicates(confirmed)
if (clusters.length) log(`${ticketKey}: ${clusters.length} shared-locus cluster(s) cross-linked (annotated, not merged)`)
log(`${ticketKey}: ${confirmed.length} confirmed (${dropped.length} dropped as false-positive/out-of-scope)`)

const report = mdReview({ confirmed, dropped })
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
