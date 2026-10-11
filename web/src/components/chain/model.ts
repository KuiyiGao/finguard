import type { Evidence, EvidenceOrigin, Finding, Reason, Tone } from "@contracts";
import { describeCall } from "../../lib/describe.ts";
import { amountOf } from "../../lib/format.ts";
import { firstReason, plainReason, type ActionState } from "../../lib/status.ts";
import type { ToolStep } from "../../lib/turns.ts";
import { sortReasons } from "../gate.tsx";
import type { ValueUnit } from "../viz/format.ts";

export type StationId = "source" | "evidence" | "calc" | "action" | "permission" | "receipt";
export type StationState = "done" | "active" | "stopped" | "pending";

export const STATION_TITLES: Record<StationId, string> = {
  source: "Source",
  evidence: "Evidence",
  calc: "Calculation",
  action: "Proposed action",
  permission: "Permission",
  receipt: "Receipt",
};

export const STATION_ORDER: StationId[] = ["source", "evidence", "calc", "action", "permission", "receipt"];

export interface Mark {
  n: number;
  start: number;
  end: number;
  label: string;
  tone: Tone;
  key?: { start: number; end: number; text: string; shape: "circle" | "underline" };
  note: string;
}

export interface ChainItem {
  key: string;
  n?: number;
  label: string;
  origin: EvidenceOrigin;
  trusted: boolean;
  source: string;
  quote?: string;
}

export interface Term {
  text: string;
  note: string;
  value: number | null;
  from?: { origin: EvidenceOrigin; trusted: boolean; n?: number; label: string };
}

export interface Calc {
  caption?: string;
  terms: Term[];
  ops: string[];
  result?: { text: string; value: number; unit: ValueUnit; label?: string };
  sentence?: string;
  citation?: { title: string; url?: string; host?: string };
}

export interface PermissionView {
  state: StationState;
  headline: string;
  verdict?: "allow" | "ask" | "deny";
  passed: Reason[];
  blocking: Reason[];
  total: number;
  actionHash?: string;
  code?: "waiting" | "approved" | "declined";
  note?: string;
}

export interface ReceiptView {
  state: StationState;
  headline: string;
  id?: string;
  actionHash?: string;
}

export interface ChainModel {
  kind: "document" | "message" | "records";
  sourceTitle: string;
  sourceRef?: string;
  text?: string;
  marks: Mark[];
  items: ChainItem[];
  calc: Calc;
  action?: { label: string; tool: string; args: Record<string, unknown>; byMessage: boolean };
  permission: PermissionView;
  receipt: ReceiptView;
  states: Record<StationId, StationState>;
}

const inWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}$]/u.test(c);

function marksOf(text: string, spans: { start: number; end: number; label: string; tone: Tone }[]): Mark[] {
  const out: Mark[] = [];
  let prev = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.end <= s.start || s.start < 0 || s.end > text.length) continue;
    let start = s.start;
    let end = s.end;
    while (start > prev && inWord(text[start - 1]) && inWord(text[start])) start--;
    while (end < text.length && inWord(text[end]) && inWord(text[end - 1])) end++;
    if (start < prev) start = prev;
    if (end <= start) continue;
    const passage = text.slice(start, end);
    const key = keyOf(passage);
    out.push({ n: out.length + 1, start, end, label: s.label, tone: s.tone, key, note: noteOf(s.label, passage, key?.text) });
    prev = end;
  }
  return out;
}

function keyOf(passage: string): Mark["key"] {
  const tries: [RegExp, "circle" | "underline"][] = [
    [/\$\d[\d,]*(?:\.\d+)?/, "circle"],
    [/\d+(?:\.\d+)?%/, "circle"],
    [/\b\d+(?:-|\s)(?:day|days|week|weeks|month|months|year|years|hours?)\b/i, "underline"],
    [/\b\d[\d,]*(?:\.\d+)?\b/, "underline"],
  ];
  for (const [re, shape] of tries) {
    const m = passage.match(re);
    if (m && m.index !== undefined) return { start: m.index, end: m.index + m[0].length, text: m[0], shape };
  }
  return undefined;
}

const words4 = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 4).join(" ");

function noteOf(label: string, passage: string, figure?: string): string {
  const l = label.toLowerCase();
  const p = passage.toLowerCase();
  const money = figure && figure.startsWith("$") ? figure : undefined;
  const days = figure && /\d+\s*(day|days)/i.test(figure) ? figure : undefined;
  const months = figure && /\d+-?\s*months?/i.test(figure) ? figure.replace(/-month$/i, " months").replace(/-/g, " ") : undefined;
  if (/auto-?renew|renews/.test(l)) return months ? `renews for ${months}` : "renews itself";
  if (/early termination|leave early|ending early/.test(l)) return money ? `${money} to leave early` : "fee to leave early";
  if (/extra fee|maintenance|annual fee|facility fee/.test(l)) return money ? (/annual|a year|each year|each term/.test(p) ? `${money} a year` : `${money} extra fee`) : "extra fee";
  if (/how to cancel|cancel/.test(l)) return days && /notice|before/.test(p) ? `${days} notice` : "how to cancel";
  if (/price can|price|dues can/.test(l)) return /\bmay\b/.test(p) ? "price may change" : "price can change";
  if (/arbitration/.test(l)) return /jury/.test(p) ? "no jury trial" : "arbitration only";
  if (/monthly (dues|price)/.test(l)) return money ? `${money} a month` : "monthly price";
  if (/safe account/.test(l)) return "not your account";
  if (/secrecy/.test(l)) return "asks for secrecy";
  if (/act fast|pressure|urgen/.test(l)) return "rushes you";
  if (/guaranteed/.test(l)) return figure && figure.endsWith("%") ? `promises ${figure}` : "promises returns";
  if (/gift card|crypto|wire/.test(l)) return "hard-to-trace payment";
  if (/someone you trust|impersonat|claims to be/.test(l)) return "poses as someone trusted";
  if (/request from a message/.test(l)) return "asks for money";
  return words4(label.toLowerCase().replace(/[\u00b7:]/g, " "));
}

const strip = (q: string) => q.replace(/^[\s…]+|[\s…]+$/g, "").replace(/^\.\.\.|\.\.\.$/g, "").trim();
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);

function markOf(e: Evidence, text: string, marks: Mark[]): Mark | undefined {
  if (!e.quote || marks.length === 0) return undefined;
  const q = strip(e.quote);
  if (q.length < 2) return undefined;
  const at = text.indexOf(q);
  if (at < 0) return undefined;
  const qs = at;
  const qe = at + q.length;
  const lw = words(e.label);
  let best: Mark | undefined;
  let bestScore = 0;
  for (const m of marks) {
    const overlap = Math.min(qe, m.end) - Math.max(qs, m.start);
    if (overlap <= 0) continue;
    const ratio = overlap / (m.end - m.start);
    const mw = words(m.label);
    let shared = 0;
    for (const w of mw) if (lw.has(w)) shared++;
    const score = ratio + shared * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

const NUM = /[-−]?\$?\d[\d,]*(?:\.\d+)?%?/;
const OPS = /\s+([×x*+−÷/]|-(?=\s))\s+/;

function termOf(raw: string): Term {
  const t = raw.trim();
  const m = t.match(NUM);
  if (!m || m.index === undefined) return { text: t, note: "", value: null };
  const before = t.slice(0, m.index).trim();
  const after = t.slice(m.index + m[0].length).trim();
  return { text: m[0], note: [before, after].filter(Boolean).join(" "), value: amountOf(m[0].replace("−", "-")) };
}

function parseFormula(s: string): { caption?: string; terms: Term[]; ops: string[]; rhs?: string } | null {
  const eq = s.lastIndexOf("=");
  if (eq < 0) return null;
  let lhs = s.slice(0, eq);
  const rhs = s.slice(eq + 1).trim().replace(/[.;,]\s*$/, "");
  let caption: string | undefined;
  const colon = lhs.indexOf(":");
  if (colon >= 0) {
    caption = lhs.slice(0, colon).trim();
    lhs = lhs.slice(colon + 1);
  }
  const parts = lhs.trim().split(OPS);
  const terms: Term[] = [];
  const ops: string[] = [];
  parts.forEach((p, i) => (i % 2 === 0 ? terms.push(termOf(p)) : ops.push(p === "x" || p === "*" ? "×" : p === "-" ? "−" : p)));
  if (terms.length < 2 || terms.some((t) => t.value === null)) return null;
  return { caption, terms, ops, rhs: rhs.match(NUM)?.[0] };
}

function summaryFormula(summary: string): string | null {
  for (const m of summary.matchAll(/\(([^()]*\d[^()]*[×x+][^()]*)\)/g)) {
    if (/\d\s*[×x+*]\s*\$?\d|\d[^()]*\s[+×]\s/.test(m[1]!)) return m[1]!;
  }
  return null;
}

function close(a: number, b: number) {
  return Math.abs(a - b) < 0.005;
}

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function calcOf(finding: Finding, items: ChainItem[], marks: Mark[]): Calc {
  const metric = finding.metric;
  const calcEv = finding.evidence.find((e) => e.origin === "calculation");
  const parsed = (calcEv && parseFormula(calcEv.label)) || (() => {
    const f = summaryFormula(finding.summary);
    if (!f || !metric) return null;
    const p = parseFormula(`${f} = ${metric.value}`);
    return p ? { ...p, caption: metric.label, rhs: undefined } : null;
  })();
  const ref = finding.citations[0];
  const refEv = finding.evidence.find((e) => e.origin === "reference" && e.url);
  const citation = ref
    ? { title: ref.title, url: ref.url, host: host(ref.url) }
    : refEv
      ? { title: refEv.label, url: refEv.url, host: host(refEv.url) }
      : undefined;

  const metricResult = metric ? { text: "", value: metric.value, unit: metric.unit as ValueUnit, label: metric.label } : undefined;
  if (!parsed) {
    return {
      terms: [],
      ops: [],
      result: metricResult,
      sentence: calcEv?.label,
      citation,
    };
  }
  const pool = finding.evidence.filter((e) => e.origin !== "calculation" && e.origin !== "reference").sort((a, b) => Number(b.trusted) - Number(a.trusted));
  const terms = parsed.terms.map((t) => {
    if (t.value === null) return t;
    const byValue = pool.find((e) => typeof e.value === "number" && close(e.value, t.value!)) ?? pool.find((e) => e.label.includes(t.text) || (e.quote ?? "").includes(t.text.replace(/\.00$/, "")));
    if (!byValue) return t;
    const item = items.find((i) => i.source === byValue.source && i.label === byValue.label);
    return { ...t, from: { origin: byValue.origin, trusted: byValue.trusted, n: item?.n, label: byValue.label } };
  });
  void marks;
  const rhsValue = parsed.rhs ? amountOf(parsed.rhs.replace("−", "-")) : null;
  let result: Calc["result"];
  if (metric && (rhsValue === null || close(rhsValue, metric.value))) result = { text: parsed.rhs ?? "", value: metric.value, unit: metric.unit as ValueUnit, label: metric.label };
  else if (rhsValue !== null) result = { text: parsed.rhs!, value: rhsValue, unit: parsed.rhs!.includes("$") ? "usd" : parsed.rhs!.includes("%") ? "pct" : "number" };
  return { caption: parsed.caption, terms, ops: parsed.ops, result, citation };
}

export function permissionOf(step: ToolStep | undefined, status: ActionState | undefined, hasAction: boolean, actionLabel?: string): PermissionView {
  const empty = { passed: [], blocking: [], total: 0 };
  if (!step || !step.decision) {
    if (status?.kind === "stopped") return { ...empty, state: "stopped", headline: status.text };
    if (status?.kind === "waiting") return { ...empty, state: "active", headline: "Waiting for your code", code: "waiting" };
    if (status?.kind === "done") return { ...empty, state: "done", headline: "Within your limits" };
    if (step || status?.kind === "checking") return { ...empty, state: "active", headline: "SkillGate is checking" };
    return {
      ...empty,
      state: "pending",
      headline: hasAction ? "Not asked yet" : "Nothing to approve",
      note: hasAction ? `SkillGate checks it when you tap “${actionLabel ?? "the action"}”.` : `${"No money action was proposed."}`,
    };
  }
  const d = step.decision;
  const sorted = sortReasons(d.reasons);
  const passed = sorted.filter((r) => r.verdict === "allow");
  const blocking = sorted.filter((r) => r.verdict !== "allow");
  const a = step.approval;
  const base = { verdict: d.verdict, passed, blocking, total: d.reasons.length, actionHash: a?.actionHash ?? step.receipt?.actionHash };
  if (d.verdict === "deny") return { ...base, state: "stopped", headline: `Stopped: ${firstReason(d)}`, blocking: blocking.filter((r) => r.verdict === "deny") };
  if (d.verdict === "allow") return { ...base, state: "done", headline: "Within your limits: no code needed" };
  if (!a || a.status === "pending") return { ...base, state: "active", headline: "Waiting for your code", code: "waiting" };
  if (a.status === "approved") return { ...base, state: "done", headline: step.approvedVia ? `Approved with your code (${step.approvedVia.replace(/_/g, " ")})` : "Approved with your code", code: "approved" };
  return { ...base, state: "stopped", headline: a.status === "expired" ? "Stopped: no answer in time" : step.approvedVia?.includes("wrong") ? "Stopped: the code did not match" : "Stopped: you declined", code: "declined" };
}

export function receiptOf(step: ToolStep | undefined, permission: PermissionView): ReceiptView {
  if (step?.receipt) {
    const r = step.receipt;
    return { state: "done", headline: "Receipt saved", id: r.id, actionHash: r.actionHash };
  }
  if (step?.executed) return step.executed.ok ? { state: "active", headline: "Done, saving the receipt" } : { state: "stopped", headline: `Stopped: ${plainReason(step.executed.error ?? "the bank did not complete it")}` };
  if (permission.state === "stopped") return { state: "pending", headline: "Nothing ran, so there is no receipt" };
  if (permission.state === "done" && step) return { state: "active", headline: "Running the action" };
  return { state: "pending", headline: "Not reached yet" };
}

export function hasEvidenceChain(finding: Finding): boolean {
  return finding.viz?.kind === "clauses" || finding.from === "scam";
}

export function findChainStep(finding: Finding, steps: Map<string, ToolStep> | undefined, callId?: string): ToolStep | undefined {
  if (!steps) return undefined;
  if (callId && steps.has(callId)) return steps.get(callId);
  for (const e of finding.evidence) {
    const m = e.source.match(/^transfer:(call_[\w-]+)/);
    if (m && steps.has(m[1]!)) return steps.get(m[1]!);
  }
  return undefined;
}

export function buildChain(finding: Finding, step?: ToolStep, status?: ActionState): ChainModel {
  const viz = finding.viz?.kind === "clauses" ? finding.viz : undefined;
  const untrustedEv = finding.evidence.filter((e) => !e.trusted);
  const docEv = finding.evidence.find((e) => e.origin === "document");
  const msgEv = finding.evidence.find((e) => e.origin === "message");
  const kind: ChainModel["kind"] = viz ? (docEv || finding.area === "contracts" ? "document" : "message") : untrustedEv.length ? (docEv ? "document" : "message") : "records";
  const marks = viz ? marksOf(viz.text, viz.spans) : [];
  const text = viz?.text;

  const numbered: ChainItem[] = [];
  const rest: ChainItem[] = [];
  const usedMarks = new Set<number>();
  finding.evidence.forEach((e, i) => {
    if (e.origin === "calculation" || e.origin === "reference") return;
    const m = text ? markOf(e, text, marks) : undefined;
    const item: ChainItem = { key: `e${i}`, n: m?.n, label: e.label, origin: e.origin, trusted: e.trusted, source: e.source, quote: e.quote };
    if (m) {
      usedMarks.add(m.n);
      numbered.push(item);
    } else rest.push(item);
  });
  const fallbackOrigin: EvidenceOrigin = kind === "message" ? "message" : "document";
  for (const m of marks) {
    if (usedMarks.has(m.n)) continue;
    numbered.push({ key: `m${m.n}`, n: m.n, label: m.label, origin: fallbackOrigin, trusted: false, source: (kind === "message" ? msgEv : docEv)?.source ?? (kind === "message" ? "message" : "document"), quote: text!.slice(m.start, m.end) });
  }
  numbered.sort((a, b) => a.n! - b.n!);
  rest.sort((a, b) => Number(a.trusted) - Number(b.trusted));
  const items = [...numbered, ...rest];

  const calc = calcOf(finding, items, marks);

  const byMessage = Boolean(step?.decision?.provenance.some((p) => p.status === "untrusted_only"));
  const action = finding.action
    ? { label: finding.action.label, tool: finding.action.tool, args: finding.action.args, byMessage: false }
    : step
      ? { label: describeCall(step.call), tool: step.call.tool, args: step.call.args, byMessage }
      : undefined;

  const permission = permissionOf(step, status, Boolean(action), action?.label);
  const receipt = receiptOf(step, permission);

  const states: Record<StationId, StationState> = {
    source: "done",
    evidence: items.length ? "done" : "pending",
    calc: calc.terms.length || calc.result || calc.sentence ? "done" : "pending",
    action: action ? "done" : "pending",
    permission: permission.state,
    receipt: receipt.state,
  };

  const sourceTitle = kind === "document" ? (docEv?.label && !docEv.quote ? docEv.label : "The document") : kind === "message" ? "The message" : "Bank records";
  return {
    kind,
    sourceTitle,
    sourceRef: (kind === "document" ? docEv : kind === "message" ? msgEv : undefined)?.source,
    text,
    marks,
    items,
    calc,
    action,
    permission,
    receipt,
    states,
  };
}

export function announce(id: StationId, m: ChainModel): string {
  switch (id) {
    case "source":
      return m.marks.length ? `Source: ${m.marks.length} ${m.marks.length === 1 ? "passage" : "passages"} highlighted in ${m.kind === "message" ? "the message" : "the document"}.` : `Source: ${m.sourceTitle}.`;
    case "evidence": {
      const untrusted = m.items.filter((i) => !i.trusted).length;
      return `Evidence: ${m.items.length} ${m.items.length === 1 ? "piece" : "pieces"}, ${untrusted} from text that is not trusted for payment details.`;
    }
    case "calc": {
      const c = m.calc;
      if (c.terms.length) return `Calculation: ${c.caption ? `${c.caption}, ` : ""}${c.terms.map((t, i) => `${t.text}${t.note ? ` ${t.note}` : ""}${c.ops[i] ? ` ${c.ops[i] === "×" ? "times" : c.ops[i] === "+" ? "plus" : c.ops[i]}` : ""}`).join(" ")}${c.result?.text ? ` equals ${c.result.text}` : ""}.`;
      if (c.sentence) return `Calculation: ${c.sentence}`;
      return c.result ? `Calculation: ${c.result.label ?? "result"} ${c.result.value}.` : "Calculation: none.";
    }
    case "action":
      return m.action ? `Proposed action: ${m.action.label}.` : "Proposed action: none.";
    case "permission":
      return `Permission: ${m.permission.headline}.`;
    case "receipt":
      return m.receipt.id ? `Receipt saved, action hash ${m.receipt.actionHash?.slice(0, 8)}.` : `Receipt: ${m.receipt.headline}.`;
  }
}
