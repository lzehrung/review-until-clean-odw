export const meta = {
  name: 'review-and-correct',
  description: 'Final pre-PR review of a commit range: exactly two self-verifying reviewers, ticket-scoped output',
  whenToUse: 'Run after implementation and build/lint/tests are green, before opening a PR. Pass {ticketKey, base, head, ac}; always pass base explicitly. After fixes, re-run with {...same, mode:"verify-fixes", priorFindings, priorHead} to confirm current blockers are resolved and the fix commits introduced nothing new.',
  phases: [
    { title: 'Review', detail: 'exactly two wide-scope reviewers; each reviews and adversarially verifies its own behavior or structure findings' },
    { title: 'Re-verify + Regression', detail: 'the same two groups recheck prior findings and review only priorHead...head for regressions' },
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
//                    output the caller already gathered). When omitted, the two reviewers
//                    derive the context they need from the live diff without an extra agent.
//   riskHunks     -- optional [{file, line?, reason}] highlighting hunks the two reviewers
//                    should scrutinize closely instead of spreading effort evenly.
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
// Optional pre-built context (e.g. `codegraph review`/`impact` output gathered by
// the caller). The same two reviewers use it directly; without it, they derive their
// own context from the live diff. Only accept a real string and trim whitespace so
// malformed values never render as "[object Object]" in prompts.
const callerContext = typeof (input && input.codegraphContext) === 'string' ? input.codegraphContext.trim() : ''
// Drop malformed entries up front so packetSection() receives a stable shape.
const sanitizeRiskHunks = (arr) =>
  Array.isArray(arr)
    ? arr
        .filter((r) => r && typeof r === 'object' && typeof r.file === 'string' && r.file.trim())
        .map((r) => ({
          file: r.file.trim(),
          line: typeof r.line === 'string' ? r.line : typeof r.line === 'number' && Number.isFinite(r.line) ? String(r.line) : '',
          reason: typeof r.reason === 'string' ? r.reason : '',
        }))
    : []
const callerRiskHunks = sanitizeRiskHunks(input && input.riskHunks)
const mode = input && input.mode === 'verify-fixes' ? 'verify-fixes' : priorFindings.length ? 'verify-fixes' : 'review'

// Three-dot: branch's own work since divergence from base. Two-dot would re-surface
// commits the branch merged in from base (the upstream-noise that had to be steered
// out by hand before).
const DIFF = `${base}...${head}`

// One findings schema per invocation, parameterized by the sub-dimensions in play --
// a review group's members. Both the main Review pass and the Regression sweep call
// this with a group's `dims`, never the full DIMENSIONS key list. Each finding
// self-tags its `dimension` -- required because one reviewer now covers several
// sub-dimensions in a single pass; reporting/clustering still needs the finer-grained tag.
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

const verifiedFindingsSchema = (dimKeys) => {
  const schema = findingsSchema(dimKeys)
  const finding = schema.properties.findings.items
  return {
    ...schema,
    properties: {
      findings: {
        ...schema.properties.findings,
        items: {
          ...finding,
          properties: { ...finding.properties, verdict: VERDICT_SCHEMA },
          required: [...finding.required, 'verdict'],
        },
      },
    },
  }
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

const fixGroupSchema = (dimKeys) => ({
  type: 'object',
  properties: {
    rechecked: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'zero-based index supplied with the prior finding' },
          resolution: RESOLVED_SCHEMA,
        },
        required: ['index', 'resolution'],
      },
    },
    findings: verifiedFindingsSchema(dimKeys).properties.findings,
  },
  required: ['rechecked', 'findings'],
})

// Canonical sub-dimensions, kept fine-grained for self-tagging, reporting, and
// clustering. Review and Regression both fan out over the two wide GROUPS below,
// not this list directly -- each group's `dims` is a subset of these keys.
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
const dim = (key) => {
  const d = DIMENSIONS.find((d) => d.key === key)
  if (!d) throw new Error(`groupFocus: '${key}' is not a key in DIMENSIONS -- check GROUPS[].dims for a typo or a stale key after a DIMENSIONS edit`)
  return d
}

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
// A finding with no (or malformed) verdict is NOT the same as a verified false
// positive -- treating it as one would let a broken/incomplete reviewer response
// produce a false-clean result. Shared by the Review pass and the verify-fixes
// regression sweep so both fail closed on the same shape.
const isValidVerdict = (v) => v && typeof v.real === 'boolean' && typeof v.in_scope === 'boolean' && typeof v.severity === 'string'


const packetSection = (contextPacket, riskHunks) => {
  const packet = typeof contextPacket === 'string' ? contextPacket.trim() : ''
  const hunks = (riskHunks || []).filter((r) => r && typeof r === 'object' && typeof r.file === 'string')
  if (!packet && !hunks.length) return ''
  const risk = hunks.map((r) => `- \`${r.file}\`${r.line ? `:${r.line}` : ''} -- ${r.reason || ''}`).join('\n')
  return (
    `\n\nPre-built context packet (facts only; verify against the live diff/code rather than trusting it blindly, ` +
    `and go beyond it if it is incomplete -- but you should not need to re-derive callers/callees or doc context ` +
    `from scratch):\n${packet || '(empty)'}\n\n` +
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
  `You are reviewing the git diff ${diff} for ticket ${ticketKey}. Review directly in this session: do not delegate ` +
  `or spawn agents, modify files, run formatters, commit, or push.\n\n` +
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
  `\n\nFor every candidate finding, perform an adversarial verification inside this same pass. Default to refuting ` +
  `it: inspect the live diff and surrounding code, confirm it is both real and in scope, and re-rate severity from ` +
  `the evidence. For behavioral claims, run a concrete cheap read-only test or repro when safe and record execution ` +
  `evidence in \`verdict\`; use code-reading only when no cheap execution path exists. Return candidates with their ` +
  `verdicts so the workflow can separate confirmed findings from dropped false positives without verifier agents.\n\n` +
  `Report only concrete, diff-anchored findings. Do NOT report pre-existing issues, base-only commits, harmless ` +
  `cleanup, minor style drift, or AC work absent from an empty diff. Return an empty array when clean.`

const fixGroupPrompt = (g, indexedFindings, regrDiff, contextPacket, riskHunks) => {
  const prior = indexedFindings.map(({ index, finding }) => ({
    index,
    severity: finding.severity,
    dimension: finding.dimension,
    file: finding.file,
    title: finding.title,
    verify_command: finding.verify_command || '',
  }))
  return (
    `Verify the current fix round for ticket ${ticketKey} as the single **${g.label}** reviewer. This one pass owns ` +
    `both rechecking its assigned prior findings and reviewing the fix delta for regressions; do not delegate or ` +
    `spawn agents. Do not modify files, format, commit, or push.\n\n` +
    `Assigned prior findings, with stable zero-based indexes:\n${JSON.stringify(prior, null, 2)}\n\n` +
    `For every assigned finding, re-locate the current code by symbol/content rather than stale line numbers. Run ` +
    `its verify_command or an obvious cheap gate when safe. Return exactly one \`rechecked\` entry with the supplied ` +
    `index and a resolution grounded in a verbatim current code or command-output quote. Default to resolved unless ` +
    `that evidence shows the original defect still exists; set regressed only for a new adjacent problem visible ` +
    `in the same evidence.\n\n` +
    `Then review only the fix delta \`${regrDiff}\` for new issues across:\n\n${groupFocus(g)}\n\n` +
    `Run \`git diff --name-only ${regrDiff}\` and \`git diff ${regrDiff}\`. If empty, return no findings. Adversarially ` +
    `verify every regression candidate inside this pass and attach its verdict. Acceptance criteria:\n${ac}`
  ) + packetSection(contextPacket, riskHunks)
}

// Exactly two self-verifying group passes. Each reviewer generates candidate findings,
// challenges them against the live diff and AC, and returns its verdicts in one session.
async function runReview(groups, diff, reviewPhase, contextPacket, riskHunks) {
  const reviewed = await parallel(
    groups.map((g) => () =>
      agent(reviewPrompt(g, diff, contextPacket, riskHunks), {
        label: `review:${g.key}`,
        phase: reviewPhase,
        schema: verifiedFindingsSchema(g.dims),
      })
    )
  )
  if (reviewed.length !== groups.length || reviewed.some((result) => !result || !Array.isArray(result.findings))) {
    throw new Error(`Review incomplete: expected ${groups.length} valid reviewer results`)
  }
  const all = reviewed.flatMap((result) => (result && result.findings) || []).filter(Boolean)
  const malformed = all.filter((f) => !isValidVerdict(f.verdict))
  if (malformed.length) {
    // A finding with no (or malformed) verdict is NOT the same as a verified false
    // positive -- silently treating it as "dropped" would let a broken/incomplete
    // reviewer response produce a false-clean result. Fail closed instead.
    throw new Error(
      `Review incomplete: ${malformed.length} finding(s) missing a valid verdict (${malformed.map((f) => f.title || f.file).join(', ')})`
    )
  }
  const confirmed = all
    .filter((f) => f.verdict.real && f.verdict.in_scope)
    .map((f) => ({ ...f, severity: f.verdict.severity }))
  confirmed.sort((a, b) => rank[a.severity] - rank[b.severity])
  const dropped = all.filter((f) => !(f.verdict.real && f.verdict.in_scope))
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

// Caller context is optional. Without it, the same two reviewers derive what they need
// from the live diff; every invocation still uses exactly two subagent sessions.
const contextPacket = callerContext
const riskHunks = callerRiskHunks
if (contextPacket) {
  log(`${ticketKey}: using caller-supplied context packet (${String(contextPacket).length} chars), ${riskHunks.length} risk hunk(s)`)
} else {
  log(`${ticketKey}: no caller context supplied -- the two reviewers will derive context from the live diff`)
}

if (mode === 'verify-fixes') {
  phase('Re-verify + Regression')
  const regrDiff = `${priorHead}...${head}`
  const indexedPrior = priorFindings.map((finding, index) => ({ finding, index }))
  const groupInputs = GROUPS.map((group, groupIndex) => ({
    group,
    prior: indexedPrior.filter(({ finding }) => {
      const owner = GROUPS.findIndex((candidate) => candidate.dims.includes(finding.dimension))
      return owner === -1 ? groupIndex === 0 : owner === groupIndex
    }),
  }))
  const groupResults = await parallel(
    groupInputs.map(({ group, prior }) => () =>
      agent(fixGroupPrompt(group, prior, regrDiff, contextPacket, riskHunks), {
        label: `verify:${group.key}`,
        phase: 'Re-verify + Regression',
        schema: fixGroupSchema(group.dims),
      })
    )
  )
  if (
    groupResults.length !== GROUPS.length ||
    groupResults.some((result) => !result || !Array.isArray(result.rechecked) || !Array.isArray(result.findings))
  ) {
    throw new Error(`Fix verification incomplete: expected ${GROUPS.length} valid reviewer results`)
  }
  const isValidResolution = (r) => r && typeof r.resolved === 'boolean' && typeof r.regressed === 'boolean' && typeof r.current_evidence === 'string'
  const resolutions = new Map()
  const regressionCandidates = []
  for (const [groupIndex, result] of groupResults.entries()) {
    // Only accept indexes this lane was actually assigned. A lane that renumbers
    // its own findings 0..k-1 (its prompt shows a short list) would otherwise
    // overwrite the other lane's genuine result AND satisfy the missing-index
    // guard below, silently turning a still-open blocker into "resolved".
    const owned = new Set(groupInputs[groupIndex].prior.map(({ index }) => index))
    for (const entry of (result && result.rechecked) || []) {
      if (entry && typeof entry.index === 'number' && owned.has(entry.index) && isValidResolution(entry.resolution)) {
        resolutions.set(entry.index, entry.resolution)
      }
    }
    regressionCandidates.push(...((result && result.findings) || []))
  }
  // A prior finding with no (or malformed) recheck result is NOT the same as a
  // verified-still-open finding -- silently defaulting resolution to null would mask
  // a reviewer lane that dropped/skipped its assigned index. Fail closed instead.
  const missingIndexes = priorFindings.map((_, index) => index).filter((index) => !resolutions.has(index))
  if (missingIndexes.length) {
    throw new Error(`Fix verification incomplete: missing recheck result(s) for prior finding index ${missingIndexes.join(', ')}`)
  }
  const rechecked = priorFindings.map((finding, index) => ({
    ...finding,
    resolution: resolutions.get(index) || null,
  }))
  const isResolved = (finding) => finding.resolution && finding.resolution.resolved && !finding.resolution.regressed
  const resolved = rechecked.filter(isResolved)
  const unresolved = rechecked.filter((finding) => !isResolved(finding))
  const malformedRegressions = regressionCandidates.filter((finding) => !isValidVerdict(finding.verdict))
  if (malformedRegressions.length) {
    throw new Error(
      `Fix verification incomplete: ${malformedRegressions.length} regression candidate(s) missing a valid verdict ` +
        `(${malformedRegressions.map((f) => f.title || f.file).join(', ')})`
    )
  }
  const regressions = regressionCandidates
    .filter((finding) => finding.verdict.real && finding.verdict.in_scope)
    .map((finding) => ({ ...finding, severity: finding.verdict.severity }))
    .sort((left, right) => rank[left.severity] - rank[right.severity])

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
    addressed,
    resolved: resolved.map((finding) => ({ ...finding, resolution: finding.resolution || null })),
    unresolved: unresolved.map((finding) => ({ ...finding, resolution: finding.resolution || null })),
    regressions,
    report,
  }
}

phase('Review')
const { confirmed, dropped } = await runReview(GROUPS, DIFF, 'Review', contextPacket, riskHunks)
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
