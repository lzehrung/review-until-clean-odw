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
  noop,
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
  noop,
  noop,
);
assert.deepEqual(verifyCalls, ["verify:behavior", "verify:structure"]);
assert.equal(verifyResult.addressed.length, 2);
assert.equal(verifyResult.unresolved.length, 0);
assert.equal(verifyResult.regressions.length, 0);

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
