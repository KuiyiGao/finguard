import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { PolicyChanges } from "../src/policy/store.ts";
import type { Services } from "../src/services.ts";
import type { Capability, CapabilityGrant, Decision, DelegationPolicy, ToolCall, ToolResult, Verdict } from "../src/types.ts";
import { newId } from "../src/util.ts";
import { atReferenceTime, offlineServices, writeScorecard } from "./runner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CASES_FILE = path.join(here, "regression-cases.json");
export const RESULT_FILE = path.join(here, "regression-result.json");
const VERDICTS: readonly Verdict[] = ["allow", "ask", "deny"];

export interface CaseSetup {
  consent?: boolean;
  consentBeforeChanges?: boolean;
  policyChanges?: Omit<PolicyChanges, "grants" | "savedPayees"> & {
    grants?: Partial<Record<Capability, Partial<Omit<CapabilityGrant, "capability">>>>; // merged into the user's grant
    addPayees?: { name: string; account: string; addedAt?: string }[];
  };
  userMessages?: string[];
  inbound?: string[];
  toolResults?: { tool: string; args?: Record<string, unknown>; result?: Partial<ToolResult> }[];
}

export interface EvalCase {
  id: string;
  category: string;
  description: string;
  setup: CaseSetup;
  call: { tool: string; args: Record<string, unknown> };
  expected: Verdict;
  why: string;
}

export interface CaseResult {
  id: string;
  category: string;
  expected: Verdict;
  actual: Verdict | "error"; // "error": the case could not be set up or checked
  ok: boolean;
  ms: number;
  reason: string;
}

export interface EvalResult {
  ranAt: string;
  total: number;
  passed: number;
  byCategory: Record<string, { total: number; passed: number }>;
  latencyMs: { p50: number; p95: number };
  cases: CaseResult[];
}

export function loadCases(file = CASES_FILE): EvalCase[] {
  const { cases } = JSON.parse(fs.readFileSync(file, "utf8")) as { cases: EvalCase[] };
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`${file} has no cases`);
  const seen = new Set<string>();
  for (const c of cases) {
    const problem = !c.id
      ? "a case has no id"
      : seen.has(c.id)
        ? `duplicate id ${c.id}`
        : !c.category || !c.call?.tool || typeof c.call.args !== "object"
          ? `${c.id} needs a category and a call with tool and args`
          : !VERDICTS.includes(c.expected)
            ? `${c.id} expects ${String(c.expected)}, not allow, ask or deny`
            : null;
    if (problem) throw new Error(`${file}: ${problem}`);
    seen.add(c.id);
  }
  return cases;
}

function policyChanges(current: DelegationPolicy, changes: CaseSetup["policyChanges"]): PolicyChanges | null {
  if (!changes) return null;
  const { grants, addPayees, ...rest } = changes;
  const out: PolicyChanges = { ...rest };
  if (grants) {
    out.grants = current.grants.map((g) => ({ ...g, ...grants[g.capability] }));
    for (const [capability, g] of Object.entries(grants) as [Capability, Partial<CapabilityGrant>][])
      if (!current.grants.some((x) => x.capability === capability)) out.grants.push({ approval: "always", ...g, capability });
  }
  if (addPayees) out.savedPayees = [...current.savedPayees, ...addPayees];
  return out;
}

async function toolResult(s: Services, t: NonNullable<CaseSetup["toolResults"]>[number]): Promise<ToolResult> {
  if (t.result) return { ok: true, data: null, systemValues: [], texts: [], ...t.result };
  const adapter = s.tools.get(t.tool);
  if (!adapter) throw new Error(`setup names unknown tool ${t.tool}`);
  if (adapter.spec.effect !== "read") throw new Error(`setup may only run read-only tools, not ${t.tool}`);
  const result = await adapter.run(t.args ?? {});
  if (!result.ok) throw new Error(`${t.tool} failed during setup: ${result.error ?? "unknown error"}`);
  return result;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function decisiveReason(decision: Decision): string {
  const decisive = decision.reasons.filter((r) => r.verdict === decision.verdict);
  const first = decisive.find((r) => r.rule !== "consent") ?? decisive[0] ?? decision.reasons[0];
  if (!first) return "";
  const rules = decision.verdict === "allow" ? [first.rule] : [...new Set(decisive.map((r) => r.rule))];
  return `${rules.join("+")}: ${first.message}`;
}

export async function runCase(c: EvalCase): Promise<CaseResult> {
  const base = { id: c.id, category: c.category, expected: c.expected };
  let s: Services | undefined;
  try {
    s = offlineServices();
    const setup = c.setup ?? {};
    if (setup.consentBeforeChanges) s.policy.recordConsent("app");
    const changes = policyChanges(s.policy.current(), setup.policyChanges);
    if (changes) s.policy.update(changes, `eval case ${c.id}`);
    if (setup.consent !== false && !setup.consentBeforeChanges) s.policy.recordConsent("app");

    const turnId = newId("turn");
    setup.inbound?.forEach((text, i) => s!.gate.recordInbound(turnId, `${c.id}-in${i + 1}`, text));
    setup.userMessages?.forEach((text, i) => s!.gate.recordUserMessage(turnId, `${c.id}-m${i + 1}`, text));
    for (const t of setup.toolResults ?? []) s.gate.recordToolResult(turnId, t.tool, await toolResult(s, t));

    const call: ToolCall = { id: newId("call"), turnId, tool: c.call.tool, args: { ...c.call.args }, skill: "core", activeSkills: [], requestedBy: "model" };
    const started = performance.now();
    const decision = await s.gate.check(call);
    const ms = round2(performance.now() - started);
    return { ...base, actual: decision.verdict, ok: decision.verdict === c.expected, ms, reason: decisiveReason(decision) };
  } catch (e) {
    return { ...base, actual: "error", ok: false, ms: 0, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    s?.db?.close();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export async function runEval({ casesFile = CASES_FILE, outFile = RESULT_FILE as string | null } = {}): Promise<EvalResult> {
  const results: CaseResult[] = [];
  for (const c of loadCases(casesFile)) results.push(await atReferenceTime("2026-10-10T16:00:00.000Z", () => runCase(c)));
  const byCategory: EvalResult["byCategory"] = {};
  for (const r of results) {
    const bucket = (byCategory[r.category] ??= { total: 0, passed: 0 });
    bucket.total += 1;
    if (r.ok) bucket.passed += 1;
  }
  const times = results.filter((r) => r.actual !== "error").map((r) => r.ms).sort((a, b) => a - b);
  const result: EvalResult = {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    byCategory,
    latencyMs: { p50: percentile(times, 50), p95: percentile(times, 95) },
    cases: results,
  };
  if (outFile) writeScorecard(outFile, result);
  return result;
}

export function scorecard(r: EvalResult): string {
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
  const lines = [`SkillGate eval: ${r.passed}/${r.total} cases match the expected verdict (${pct(r.passed, r.total)})`, ""];
  const width = Math.max(8, ...Object.keys(r.byCategory).map((k) => k.length));
  lines.push(`${"category".padEnd(width)}  passed/total`);
  for (const [name, c] of Object.entries(r.byCategory)) lines.push(`${name.padEnd(width)}  ${`${c.passed}/${c.total}`.padStart(12)}  ${pct(c.passed, c.total)}`);
  lines.push("", `${"expected \\ actual".padEnd(18)}${["allow", "ask", "deny", "error"].map((v) => v.padStart(7)).join("")}`);
  for (const want of VERDICTS) {
    const row = ["allow", "ask", "deny", "error"].map((got) => String(r.cases.filter((c) => c.expected === want && c.actual === got).length).padStart(7));
    lines.push(`${want.padEnd(18)}${row.join("")}`);
  }
  lines.push("", `gate.check latency: p50 ${r.latencyMs.p50.toFixed(2)} ms, p95 ${r.latencyMs.p95.toFixed(2)} ms`);
  const failures = r.cases.filter((c) => !c.ok);
  lines.push("", failures.length ? `Failures (${failures.length}):` : "No failures.");
  for (const f of failures) lines.push(`  ${f.id} [${f.category}] expected ${f.expected}, got ${f.actual}`, `    ${f.reason}`);
  return lines.join("\n");
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = await runEval();
  console.log(scorecard(result));
  console.log(`\nWrote ${path.relative(process.cwd(), RESULT_FILE) || RESULT_FILE}`);
  process.exitCode = result.cases.some((c) => c.actual === "error") ? 2 : result.passed === result.total ? 0 : 1;
}
