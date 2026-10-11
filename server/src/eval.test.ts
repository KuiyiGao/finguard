import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadCases, runEval, scorecard } from "../eval/regression.ts";

const VERDICTS = ["allow", "ask", "deny"];

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "steward-eval-"));
}

test("the eval runs every labeled case and writes the scorecard file", async () => {
  const dir = tempDir();
  try {
    const outFile = path.join(dir, "last-result.json");
    const cases = loadCases();
    const result = await runEval({ outFile });

    assert.ok(cases.length >= 30, "about 30 labeled cases");
    assert.equal(result.total, cases.length);
    assert.ok(!Number.isNaN(Date.parse(result.ranAt)));
    assert.equal(result.passed, result.cases.filter((c) => c.ok).length);
    assert.deepEqual(
      result.cases.map((c) => c.id),
      cases.map((c) => c.id),
    );
    for (const c of result.cases) {
      assert.deepEqual(Object.keys(c), ["id", "category", "expected", "actual", "ok", "ms", "reason"]);
      assert.ok(VERDICTS.includes(c.expected));
      assert.ok([...VERDICTS, "error"].includes(c.actual), `${c.id}: ${c.actual}`);
      assert.equal(c.ok, c.expected === c.actual);
      assert.ok(c.ms >= 0);
      assert.ok(c.reason.length > 0, `${c.id} has a reason`);
    }
    const categories = [...new Set(cases.map((c) => c.category))];
    assert.deepEqual(Object.keys(result.byCategory), categories);
    for (const name of categories) {
      const inCategory = result.cases.filter((c) => c.category === name);
      assert.deepEqual(result.byCategory[name], { total: inCategory.length, passed: inCategory.filter((c) => c.ok).length });
    }
    assert.ok(result.latencyMs.p50 >= 0 && result.latencyMs.p50 <= result.latencyMs.p95);

    const written = JSON.parse(fs.readFileSync(outFile, "utf8")) as unknown;
    assert.deepEqual(written, JSON.parse(JSON.stringify(result)));
    assert.deepEqual(Object.keys(written as object), ["ranAt", "total", "passed", "byCategory", "latencyMs", "cases"]);
    assert.match(scorecard(result), /cases match the expected verdict/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every case is labeled with a verdict, a category and a reason", () => {
  const cases = loadCases();
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "ids are unique");
  for (const c of cases) {
    assert.ok(VERDICTS.includes(c.expected), c.id);
    assert.ok(c.why.trim().length > 0 && c.description.trim().length > 0, c.id);
  }
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  for (const name of ["everyday", "over_limit", "new_payee", "forwarded_scam", "injected_instruction", "payee_swap", "consent_and_pause"])
    assert.ok((counts.get(name) ?? 0) >= 4, `${name} has at least 4 cases`);
});

test("a case that cannot be set up is reported as an error, not a crash, and nothing is written without a path", async () => {
  const dir = tempDir();
  try {
    const casesFile = path.join(dir, "cases.json");
    fs.writeFileSync(
      casesFile,
      JSON.stringify({
        cases: [
          {
            id: "broken-setup",
            category: "runner",
            description: "setup names a tool that does not exist",
            setup: { toolResults: [{ tool: "bank.no_such_tool" }] },
            call: { tool: "bank.move_own", args: { from_account: "acct-checking", to_account: "acct-savings", amount: 10 } },
            expected: "allow",
            why: "runner check",
          },
          {
            id: "money-setup-refused",
            category: "runner",
            description: "setup may not run a money tool",
            setup: { toolResults: [{ tool: "bank.transfer", args: { from_account: "acct-checking", to_account: "9917", amount: 5 } }] },
            call: { tool: "bank.get_accounts", args: {} },
            expected: "allow",
            why: "runner check",
          },
        ],
      }),
    );
    const result = await runEval({ casesFile, outFile: null });
    assert.deepEqual(
      result.cases.map((c) => [c.actual, c.ok]),
      [
        ["error", false],
        ["error", false],
      ],
    );
    assert.match(result.cases[1]!.reason, /only run read-only tools/);
    assert.deepEqual(fs.readdirSync(dir), ["cases.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
