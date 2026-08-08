import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../workflows/review-and-correct.js", import.meta.url),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runWorkflow = new AsyncFunction(
  "args",
  "agent",
  "parallel",
  "phase",
  "log",
  source.replace("export const meta", "const meta"),
);

const parallel = async (thunks) =>
  await Promise.all(thunks.map(async (thunk) => await thunk()));
const noop = () => {};
// A declared meta.phases title that no phase() call emits shows up in ODW's run
// view as a lane that never starts, next to an undeclared lane that does. Scope the
// scrape to the meta.phases array so an unrelated `title:` elsewhere cannot join it.
const phasesBlock = /phases:\s*\[([\s\S]*?)^\s*\],/m.exec(source);
assert.ok(phasesBlock, "could not locate meta.phases in the workflow source");
const declaredPhases = [...phasesBlock[1].matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
assert.ok(declaredPhases.length > 0, "meta.phases declared no titles");
const emittedPhases = [];
const recordPhase = (title) => emittedPhases.push(title);

const reviewCalls = [];
const reviewResult = await runWorkflow(
  {
    ticketKey: "TEST",
    base: "origin/main",
    head: "HEAD",
    ac: "Test acceptance criteria",
    mode: "review",
  },
  async (_prompt, options) => {
    reviewCalls.push(options.label);
    return { findings: [] };
  },
  parallel,
  recordPhase,
  noop,
);
assert.deepEqual(reviewCalls, ["review:behavior", "review:structure"]);
assert.equal(reviewResult.mode, "review");

const priorFindings = [
  {
    severity: "important",
    dimension: "correctness",
    file: "src/a.js",
    title: "Behavior issue",
  },
  {
    severity: "important",
    dimension: "docs",
    file: "README.md",
    title: "Docs issue",
  },
];
const verifyCalls = [];
const verifyResult = await runWorkflow(
  {
    ticketKey: "TEST",
    base: "origin/main",
    head: "HEAD",
    ac: "Test acceptance criteria",
    mode: "verify-fixes",
    priorHead: "before-fixes",
    priorFindings,
  },
  async (prompt, options) => {
    verifyCalls.push(options.label);
    const indexes = [...prompt.matchAll(/"index": (\d+)/g)].map((match) =>
      Number(match[1]),
    );
    return {
      rechecked: indexes.map((index) => ({
        index,
        resolution: {
          current_evidence: "fixed",
          evidence_type: "code-reading",
          resolved: true,
          regressed: false,
          reasoning: "The defect is absent.",
        },
      })),
      findings: [],
    };
  },
  parallel,
  recordPhase,
  noop,
);
assert.deepEqual(verifyCalls, ["verify:behavior", "verify:structure"]);
assert.equal(verifyResult.addressed.length, 2);
assert.equal(verifyResult.unresolved.length, 0);
assert.equal(verifyResult.regressions.length, 0);
assert.deepEqual([...new Set(emittedPhases)].sort(), [...declaredPhases].sort());

// A lane may only resolve the indexes it was assigned. Before ownership filtering,
// a lane that echoed indexes belonging to the other lane overwrote its verdicts --
// with every index present the fail-closed guard stayed quiet and a still-open
// blocker was reported as resolved.
const crossLanePrior = [
  { severity: "important", dimension: "correctness", file: "src/a.js", title: "Still broken" },
  { severity: "important", dimension: "tests", file: "src/a.test.js", title: "Fixed" },
  { severity: "important", dimension: "docs", file: "README.md", title: "Docs fixed" },
];
const resolution = (resolved) => ({
  current_evidence: resolved ? "fixed" : "the original defect is still present",
  evidence_type: "code-reading",
  resolved,
  regressed: false,
  reasoning: resolved ? "The defect is absent." : "The defect is unchanged.",
});
const crossLaneResult = await runWorkflow(
  {
    ticketKey: "TEST",
    base: "origin/main",
    head: "HEAD",
    ac: "Test acceptance criteria",
    mode: "verify-fixes",
    priorHead: "before-fixes",
    priorFindings: crossLanePrior,
  },
  async (_prompt, options) => ({
    rechecked:
      options.label === "verify:behavior"
        ? [
            { index: 0, resolution: resolution(false) },
            { index: 1, resolution: resolution(true) },
          ]
        : // owns index 2 only; index 0 is a poached claim that must be ignored
          [
            { index: 2, resolution: resolution(true) },
            { index: 0, resolution: resolution(true) },
          ],
    findings: [],
  }),
  parallel,
  noop,
  noop,
);
assert.deepEqual(
  crossLaneResult.unresolved.map((finding) => finding.title),
  ["Still broken"],
);
assert.deepEqual(crossLaneResult.addressed.length, 2);

await assert.rejects(
  runWorkflow(
    {
      ticketKey: "TEST",
      base: "origin/main",
      head: "HEAD",
      ac: "Test acceptance criteria",
      mode: "review",
    },
    async () => null,
    parallel,
    noop,
    noop,
  ),
  /Review incomplete: expected 2 valid reviewer results/,
);

await assert.rejects(
  runWorkflow(
    {
      ticketKey: "TEST",
      base: "origin/main",
      head: "HEAD",
      ac: "Test acceptance criteria",
      mode: "verify-fixes",
      priorHead: "before-fixes",
      priorFindings,
    },
    async () => null,
    parallel,
    noop,
    noop,
  ),
  /Fix verification incomplete: expected 2 valid reviewer results/,
);

await assert.rejects(
  runWorkflow(
    {
      ticketKey: "TEST",
      base: "origin/main",
      head: "HEAD",
      ac: "Test acceptance criteria",
      mode: "review",
    },
    async (_prompt, options) => ({
      findings:
        options.label === "review:behavior"
          ? [
              {
                severity: "critical",
                dimension: "correctness",
                file: "src/a.js",
                title: "Missing verdict",
                detail: "A reviewer returned a finding without a verdict.",
                suggested_fix: "n/a",
                verify_command: "",
                // verdict intentionally omitted -- must fail closed, not be silently dropped.
              },
            ]
          : [],
    }),
    parallel,
    noop,
    noop,
  ),
  /Review incomplete: 1 finding\(s\) missing a valid verdict/,
);

await assert.rejects(
  runWorkflow(
    {
      ticketKey: "TEST",
      base: "origin/main",
      head: "HEAD",
      ac: "Test acceptance criteria",
      mode: "verify-fixes",
      priorHead: "before-fixes",
      priorFindings,
    },
    // A lane that never recheck's its assigned index must fail closed rather than
    // let the missing index silently default to "still open".
    async () => ({ rechecked: [], findings: [] }),
    parallel,
    noop,
    noop,
  ),
  /Fix verification incomplete: missing recheck result\(s\) for prior finding index/,
);

await assert.rejects(
  runWorkflow(
    {
      ticketKey: "TEST",
      base: "origin/main",
      head: "HEAD",
      ac: "Test acceptance criteria",
      mode: "verify-fixes",
      priorHead: "before-fixes",
      priorFindings,
    },
    async (prompt, options) => {
      const indexes = [...prompt.matchAll(/"index": (\d+)/g)].map((match) =>
        Number(match[1]),
      );
      return {
        rechecked: indexes.map((index) => ({
          index,
          resolution: {
            current_evidence: "fixed",
            evidence_type: "code-reading",
            resolved: true,
            regressed: false,
            reasoning: "The defect is absent.",
          },
        })),
        findings:
          options.label === "verify:behavior"
            ? [
                {
                  severity: "important",
                  dimension: "correctness",
                  file: "src/a.js",
                  title: "Missing verdict on a regression candidate",
                  detail:
                    "A regression candidate was returned without a verdict.",
                  suggested_fix: "n/a",
                  verify_command: "",
                  // verdict intentionally omitted -- must fail closed, not be silently dropped.
                },
              ]
            : [],
      };
    },
    parallel,
    noop,
    noop,
  ),
  /Fix verification incomplete: 1 regression candidate\(s\) missing a valid verdict/,
);

console.log(
  "Workflow topology passed: exactly two agents in review and verify-fixes modes.",
);
