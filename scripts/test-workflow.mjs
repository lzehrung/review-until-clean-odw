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

console.log(
  "Workflow topology passed: exactly two agents in review and verify-fixes modes.",
);
