import fs from "node:fs";
import path from "node:path";
import { loadConfig, SERVER_ROOT } from "../src/config.ts";
import { loadPolicyFile, validatePolicy, type PolicyChanges } from "../src/policy/store.ts";
import { BANK_TOOLS } from "../src/tools/specs.ts";
import type { ToolCall, ToolResult, Verdict } from "../src/types.ts";

export const CATEGORIES = ["everyday", "limits", "scams", "provenance", "authorization", "cash_flow_context"] as const;
export type Category = (typeof CATEGORIES)[number];
export interface EvalCase {
  id: string;
  category: Category;
  description: string;
  setup: {
    policy: PolicyChanges;
    consent: "current" | "none" | "stale";
    userMessages: { id: string; text: string }[];
    inbound: ({ id: string; text: string } | { id: string; fixture: string })[];
    bankReads: { tool: string; args: Record<string, unknown> }[];
    toolResults: { tool: string; result: ToolResult }[];
    loadedSkills: string[];
    history: { amount: number; executedAt: string }[];
  };
  call: ToolCall;
  expected: Verdict;
  rationale: string;
}
export interface CaseSet {
  schemaVersion: 1;
  referenceTime: string;
  cases: EvalCase[];
}
export class InputError extends Error {}

type Obj = Record<string, unknown>;
function object(value: unknown, at: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${at} must be an object`);
  return value as Obj;
}
function keys(value: Obj, required: string[], optional: string[], at: string): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new InputError(`${at}.${key} is required`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) throw new InputError(`${at}.${key} is unknown`);
}
function text(value: unknown, at: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${at} must be nonempty text`);
}
function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new InputError(`${at} must be a list`);
  return value;
}
function choices(value: unknown, allowed: readonly string[], at: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new InputError(`${at} must be one of ${allowed.join(", ")}`);
}
function number(value: unknown, at: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InputError(`${at} must be a finite number`);
}
function iso(value: unknown, at: string): void {
  text(value, at);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new InputError(`${at} must be a valid canonical UTC ISO timestamp`);
}
function json(value: unknown, at: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") return number(value, at);
  if (Array.isArray(value)) { value.forEach((v, i) => json(v, `${at}[${i}]`)); return; }
  const obj = object(value, at);
  for (const [key, v] of Object.entries(obj)) json(v, `${at}.${key}`);
}
function uniqueIds(values: unknown[], at: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    const row = object(value, at);
    text(row.id, `${at}.id`);
    if (ids.has(row.id)) throw new InputError(`${at} has duplicate id ${row.id}`);
    ids.add(row.id);
  }
}

export function readFixture(name: string): { id: string; text: string } {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw new InputError(`Invalid message fixture name: ${name}`);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, "fixtures", "messages", name), "utf8")); }
  catch { throw new InputError(`Cannot read valid JSON message fixture ${name}`); }
  const fixture = object(value, `fixture ${name}`);
  text(fixture.id, `fixture ${name}.id`);
  text(fixture.text, `fixture ${name}.text`);
  return { id: fixture.id, text: fixture.text };
}

export function validateCaseSet(value: unknown): CaseSet {
  const root = object(value, "dataset");
  keys(root, ["schemaVersion", "referenceTime", "cases"], [], "dataset");
  if (root.schemaVersion !== 1) throw new InputError("dataset.schemaVersion must be 1");
  iso(root.referenceTime, "dataset.referenceTime");
  const cases = list(root.cases, "dataset.cases");
  if (!cases.length) throw new InputError("dataset.cases must not be empty");
  uniqueIds(cases, "dataset.cases");
  const defaults = loadPolicyFile(loadConfig({}).policyFile);
  cases.forEach((value, i) => {
    const at = `cases[${i}]`;
    const c = object(value, at);
    keys(c, ["id", "category", "description", "setup", "call", "expected", "rationale"], [], at);
    for (const key of ["id", "description", "rationale"]) text(c[key], `${at}.${key}`);
    choices(c.category, CATEGORIES, `${at}.category`);
    choices(c.expected, ["allow", "ask", "deny"], `${at}.expected`);
    const call = object(c.call, `${at}.call`);
    keys(call, ["id", "turnId", "tool", "args", "skill", "activeSkills", "requestedBy"], [], `${at}.call`);
    for (const key of ["id", "turnId", "tool", "skill"]) text(call[key], `${at}.call.${key}`);
    object(call.args, `${at}.call.args`); json(call.args, `${at}.call.args`);
    list(call.activeSkills, `${at}.call.activeSkills`).forEach((v) => text(v, `${at}.call.activeSkills`));
    choices(call.requestedBy, ["model", "replay", "app"], `${at}.call.requestedBy`);
    const s = object(c.setup, `${at}.setup`);
    keys(s, ["policy", "consent", "userMessages", "inbound", "bankReads", "toolResults", "loadedSkills", "history"], [], `${at}.setup`);
    choices(s.consent, ["current", "none", "stale"], `${at}.setup.consent`);
    const policy = object(s.policy, `${at}.setup.policy`);
    keys(policy, [], ["grants", "ownAccounts", "savedPayees", "newPayeeCoolingOffMinutes", "dailyLimit", "cashFlowBuffer", "trustedContact", "paused"], `${at}.setup.policy`);
    if (policy.grants !== undefined) list(policy.grants, `${at}.setup.policy.grants`).forEach((v) => keys(object(v, "grant"), ["capability", "approval"], ["maxAmount"], "grant"));
    if (policy.savedPayees !== undefined) list(policy.savedPayees, "savedPayees").forEach((v) => {
      const p = object(v, "payee"); keys(p, ["id", "name", "account", "addedAt"], [], "payee"); iso(p.addedAt, "payee.addedAt");
    });
    if (policy.trustedContact !== undefined) keys(object(policy.trustedContact, "trustedContact"), ["name", "handle"], [], "trustedContact");
    const problems = validatePolicy({ ...defaults, ...policy, version: 1 });
    if (problems.length) throw new InputError(`${at}.setup.policy: ${problems.join("; ")}`);
    if (s.consent === "stale" && !Object.keys(policy).length) throw new InputError(`${at}: stale consent needs a policy change`);
    for (const kind of ["userMessages", "inbound"] as const) {
      const rows = list(s[kind], `${at}.setup.${kind}`); uniqueIds(rows, `${at}.setup.${kind}`);
      rows.forEach((v) => {
        const row = object(v, kind);
        const fixture = kind === "inbound" && Object.hasOwn(row, "fixture");
        keys(row, ["id", fixture ? "fixture" : "text"], [], kind);
        text(row[fixture ? "fixture" : "text"], kind);
        if (fixture) readFixture(row.fixture as string);
      });
    }
    list(s.bankReads, `${at}.setup.bankReads`).forEach((v) => {
      const read = object(v, "bankRead"); keys(read, ["tool", "args"], [], "bankRead"); text(read.tool, "bankRead.tool");
      object(read.args, "bankRead.args"); json(read.args, "bankRead.args");
      if (!Object.values(BANK_TOOLS).some((t) => t.name === read.tool && t.effect === "read")) throw new InputError(`${at}: bankReads allows registered read tools only`);
    });
    list(s.toolResults, `${at}.setup.toolResults`).forEach((v) => {
      const entry = object(v, "toolResult"); keys(entry, ["tool", "result"], [], "toolResult"); text(entry.tool, "toolResult.tool");
      const result = object(entry.result, "result"); keys(result, ["ok", "data", "systemValues", "texts"], ["error"], "result");
      if (typeof result.ok !== "boolean") throw new InputError("result.ok must be boolean");
      json(result.data, "result.data"); if (result.error !== undefined) text(result.error, "result.error");
      list(result.systemValues, "systemValues").forEach((v) => {
        const row = object(v, "systemValue"); keys(row, ["source", "value"], [], "systemValue"); text(row.source, "systemValue.source");
        if (typeof row.value === "number") number(row.value, "systemValue.value"); else text(row.value, "systemValue.value");
      });
      list(result.texts, "texts").forEach((v) => {
        const row = object(v, "toolText"); keys(row, ["source", "text"], [], "toolText"); text(row.source, "toolText.source"); text(row.text, "toolText.text");
      });
    });
    list(s.loadedSkills, `${at}.setup.loadedSkills`).forEach((v) => text(v, "loadedSkill"));
    list(s.history, `${at}.setup.history`).forEach((v) => {
      const row = object(v, "history"); keys(row, ["amount", "executedAt"], [], "history"); number(row.amount, "history.amount");
      if (row.amount <= 0) throw new InputError("history.amount must be positive");
      iso(row.executedAt, "history.executedAt");
      if (Date.parse(row.executedAt as string) > Date.parse(root.referenceTime as string)) throw new InputError("history cannot occur after referenceTime");
    });
  });
  return structuredClone(value) as CaseSet;
}

export function loadCaseSet(file: string): CaseSet {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new InputError("Cannot read the eval input as JSON"); }
  return validateCaseSet(value);
}
