import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, SERVER_ROOT } from "../src/config.ts";
import { Gate, actionHash } from "../src/policy/gate.ts";
import { buildServices, type Services } from "../src/services.ts";
import type { AuthorizationReceipt, Decision, Reason, ToolCall, Verdict } from "../src/types.ts";
import { readFixture, type CaseSet, type Category, type EvalCase } from "./schema.ts";

export const EVAL_ROOT = path.join(SERVER_ROOT, "eval");
export interface CaseResult {
  id: string;
  category: Category;
  expected: Verdict;
  actual: Verdict | "error";
  ok: boolean;
  status: "matched" | "mismatch" | "error";
  rationale: string;
  reasons: Reason[];
  error?: { stage: "setup" | "check"; message: string };
}
export interface Scorecard {
  ranAt: string;
  total: number;
  passed: number;
  byCategory: Record<string, { total: number; passed: number }>;
  cases: CaseResult[];
  referenceTime: string;
  runnerErrors: number;
}
export class CaseError extends Error {
  constructor(readonly stage: "setup" | "check", cause: unknown) {
    const kind = cause instanceof TypeError ? "TypeError" : cause instanceof RangeError ? "RangeError" : "Error";
    super(`Case ${stage} failed (${kind}); inspect the offline setup and runner`);
  }
}

let clockInUse = false;
export async function atReferenceTime<T>(instant: string, work: () => Promise<T>): Promise<T> {
  if (clockInUse) throw new Error("Eval clock already in use; run cases sequentially");
  const milliseconds = Date.parse(instant);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid reference time");
  const NativeDate = globalThis.Date;
  const previousTimezone = process.env.TZ;
  const fixedDate = new Proxy(NativeDate, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [milliseconds], target); },
    apply() { return new NativeDate(milliseconds).toString(); },
    get(target, property, receiver) { return property === "now" ? () => milliseconds : Reflect.get(target, property, receiver); },
  });
  clockInUse = true;
  process.env.TZ = "UTC";
  globalThis.Date = fixedDate;
  try { return await work(); }
  finally {
    globalThis.Date = NativeDate;
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    clockInUse = false;
  }
}

export function offlineServices(): Services {
  return buildServices(loadConfig({
    NESSIE_MODE: "mock", RAG_MODE: "mock", AGENT_MODE: "replay",
    SPECTRUM_PROVIDER: "off", GATE_LLM: "off", APPROVAL_TTL_SECONDS: "1",
  }), { persist: false });
}

function replayHistory(s: Services, c: EvalCase): void {
  c.setup.history.forEach((entry, i) => {
    const call: ToolCall = {
      id: `${c.id}:history:${i}`, turnId: `${c.id}:history`, tool: "bank.move_own",
      args: { from_account: "acct-checking", to_account: "acct-savings", amount: entry.amount },
      skill: "core", activeSkills: [], requestedBy: "replay",
    };
    const receipt: AuthorizationReceipt = {
      id: `${c.id}:historical-receipt:${i}`, callId: call.id, actionHash: actionHash(call),
      action: "Fictional prior authorized move (eval history only)",
      values: [{ field: "amount", value: String(entry.amount), origin: "system", source: "eval:historical-bank-snapshot" }],
      authorizedBy: { kind: "approval", approvalId: `${c.id}:fictional-prior-approval:${i}` },
      consentId: "eval:historical-consent", channel: "app", executedAt: entry.executedAt,
      traceSeq: s.trace.last()!.seq,
    };
    s.trace.append("receipt_issued", receipt, call.turnId);
  });
  if (c.setup.history.length) {
    s.gate = new Gate({ policy: s.policy, trace: s.trace, tools: s.tools, scam: s.scam,
      cashFlow: s.cashFlow, approvalTtlSeconds: s.config.approvalTtlSeconds });
  }
}

export async function prepareCase(c: EvalCase): Promise<Services> {
  const s = offlineServices();
  try {
    if (c.setup.consent === "stale") s.policy.recordConsent("app");
    const before = s.policy.current().version;
    s.policy.update(structuredClone(c.setup.policy), `Eval scenario ${c.id}`);
    if (c.setup.consent === "stale" && s.policy.current().version === before) throw new Error("Stale-consent setup must actually change the policy");
    if (c.setup.consent === "current") s.policy.recordConsent("app");
    replayHistory(s, c);
    for (const message of c.setup.userMessages) s.gate.recordUserMessage(c.call.turnId, message.id, message.text);
    for (const inbound of c.setup.inbound) s.gate.recordInbound(c.call.turnId, inbound.id, "fixture" in inbound ? readFixture(inbound.fixture).text : inbound.text);
    for (const skill of c.setup.loadedSkills) s.gate.recordSkillLoaded(c.call.turnId, skill);
    for (const read of c.setup.bankReads) {
      const adapter = s.tools.get(read.tool);
      if (!adapter || adapter.spec.effect !== "read") throw new Error("Setup adapter must be a registered read tool");
      const result = await adapter.run(structuredClone(read.args));
      if (!result.ok) throw new Error("Offline setup read failed");
      s.gate.recordToolResult(c.call.turnId, read.tool, result);
    }
    for (const entry of c.setup.toolResults) s.gate.recordToolResult(c.call.turnId, entry.tool, structuredClone(entry.result));
    return s;
  } catch (error) {
    s.db?.close();
    throw error;
  }
}

export async function evaluateCase(c: EvalCase, referenceTime: string): Promise<Decision> {
  return atReferenceTime(referenceTime, async () => {
    let s: Services;
    try { s = await prepareCase(c); }
    catch (error) { throw new CaseError("setup", error); }
    try { return await s.gate.check(structuredClone(c.call)); }
    catch (error) { throw new CaseError("check", error); }
    finally { s.db?.close(); }
  });
}

export async function runCaseSet(dataset: CaseSet, evaluate = evaluateCase): Promise<Scorecard> {
  const cases: CaseResult[] = [];
  for (const c of dataset.cases) {
    try {
      const decision = await evaluate(c, dataset.referenceTime);
      if (!["allow", "ask", "deny"].includes(decision.verdict)) throw new CaseError("check", new Error("Invalid Gate verdict"));
      const ok = decision.verdict === c.expected;
      cases.push({ id: c.id, category: c.category, expected: c.expected, actual: decision.verdict,
        ok, status: ok ? "matched" : "mismatch", rationale: c.rationale, reasons: decision.reasons });
    } catch (error) {
      const safe = error instanceof CaseError ? error : new CaseError("check", error);
      cases.push({ id: c.id, category: c.category, expected: c.expected, actual: "error", ok: false,
        status: "error", rationale: c.rationale, reasons: [], error: { stage: safe.stage, message: safe.message } });
    }
  }
  const byCategory: Scorecard["byCategory"] = {};
  for (const c of cases) {
    const count = byCategory[c.category] ??= { total: 0, passed: 0 };
    count.total += 1;
    count.passed += Number(c.ok);
  }
  return { ranAt: new Date().toISOString(), total: cases.length, passed: cases.filter((c) => c.ok).length,
    byCategory, cases, referenceTime: dataset.referenceTime, runnerErrors: cases.filter((c) => c.status === "error").length };
}

export function scorecardExitCode(result: Scorecard): 0 | 1 | 2 {
  return result.runnerErrors ? 2 : result.passed === result.total ? 0 : 1;
}

export function writeScorecard(file: string, result: {
  ranAt: string; total: number; passed: number;
  byCategory: Record<string, { total: number; passed: number }>; cases: unknown[];
}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(result, null, 2) + "\n");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function printScorecard(result: Scorecard, write: (line: string) => void = console.log): void {
  write(`SkillGate eval: ${result.passed}/${result.total} matched; ${result.runnerErrors} runner errors`);
  write(`Run: ${result.ranAt}; scenario clock: ${result.referenceTime}`);
  for (const [name, count] of Object.entries(result.byCategory)) write(`  ${name}: ${count.passed}/${count.total}`);
  for (const c of result.cases.filter((c) => !c.ok)) {
    write(`FAIL ${c.id} [${c.category}] expected=${c.expected} actual=${c.actual} (${c.status})`);
    write(`  Expected basis: ${c.rationale}`);
    if (c.error) write(`  ${c.error.message}`);
    else for (const r of c.reasons.filter((r) => r.verdict !== "allow")) write(`  ${r.rule}/${r.verdict}: ${r.message}`);
  }
}
