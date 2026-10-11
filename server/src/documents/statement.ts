import type { DelegationPolicy, Evidence, Finding, RagHit } from "../types.ts";
import { shortDate } from "../findings/normalize.ts";
import { DATE, daysBetween, inOrder, isoDate, joinAnd, markAt, money, round2, today, usd, type DocumentMark } from "./text.ts";

export interface StatementLine {
  written: string;
  date?: string;
  description: string;
  amount: number;
  balance: number;
  start: number;
  end: number;
  quote: string;
}

export interface StatementFee extends StatementLine {
  kind: "overdraft" | "maintenance" | "other";
  fee: number;
}

export interface StatementReading {
  period?: { from: string; to: string };
  lines: StatementLine[];
  fees: StatementFee[];
  feesTotal: number;
  feesPerYear: number;
  low?: { line: StatementLine; next?: StatementLine; overdrawn: boolean };
  marks: DocumentMark[];
}

const ROW = /^[ \t]*(\d{1,2}\/\d{1,2})[ \t]+(\S.*?)[ \t]+(-?\$?[\d,]+\.\d{2})[ \t]+(-?\$?[\d,]+\.\d{2})[ \t]*$/gm;

function feeKind(description: string): StatementFee["kind"] | null {
  if (!/\bfees?\b|\bcharge\b/i.test(description)) return null;
  if (/\b(overdraft|insufficient|nsf|returned item)\b/i.test(description)) return "overdraft";
  if (/\b(maintenance|monthly service|service charge|monthly fee)\b/i.test(description)) return "maintenance";
  return "other";
}

const FEE_LABEL: Record<StatementFee["kind"], string> = { overdraft: "Overdraft fee", maintenance: "Monthly maintenance fee", other: "Fee" };

function dated(written: string, period?: { from: string; to: string }): string | undefined {
  if (!period) return undefined;
  const [m, d] = written.split("/").map(Number);
  for (const year of [Number(period.from.slice(0, 4)), Number(period.to.slice(0, 4))]) {
    const iso = isoDate(`${m}/${d}/${year}`);
    if (iso && iso >= period.from && iso <= period.to) return iso;
  }
  return undefined;
}

export function readStatement(text: string): StatementReading {
  const p = new RegExp(String.raw`\bstatement period\b[^\n:]*:?[ \t]*(${DATE})[ \t]*(?:to|through|-|–)[ \t]*(${DATE})`, "i").exec(text);
  const from = p ? isoDate(p[1]!) : undefined;
  const to = p ? isoDate(p[2]!) : undefined;
  const period = from && to ? { from, to } : undefined;

  const lines: StatementLine[] = [...text.matchAll(ROW)].map((m) => {
    const span = markAt(text, m.index, m.index + m[0].length, "", "info");
    const date = dated(m[1]!, period);
    return { written: m[1]!, ...(date ? { date } : {}), description: m[2]!.trim(), amount: money(m[3]!), balance: money(m[4]!), start: span.start, end: span.end, quote: span.quote };
  });

  const fees: StatementFee[] = [];
  for (const line of lines) {
    const kind = feeKind(line.description);
    if (kind && line.amount < 0) fees.push({ ...line, kind, fee: round2(-line.amount) });
  }
  const feesTotal = round2(fees.reduce((sum, f) => sum + f.fee, 0));

  let low: StatementReading["low"];
  const firstNegative = lines.findIndex((l) => l.balance < 0);
  if (firstNegative > 0) low = { line: lines[firstNegative - 1]!, next: lines[firstNegative], overdrawn: true };
  else if (firstNegative < 0 && lines.length) {
    const i = lines.reduce((best, l, j) => (l.balance < lines[best]!.balance ? j : best), 0);
    low = { line: lines[i]!, ...(lines[i + 1] ? { next: lines[i + 1] } : {}), overdrawn: false };
  }

  const when = (l: StatementLine) => (l.date ? shortDate(l.date) : l.written);
  const marks: DocumentMark[] = fees.map((f) =>
    markAt(text, f.start, f.end, `${FEE_LABEL[f.kind]}: ${usd(f.fee)}`, f.kind === "overdraft" ? "bad" : "warn", { value: f.fee, ...(f.date ? { date: f.date } : {}) }),
  );
  if (low) {
    const label = low.overdrawn && low.next ? `Low balance before ${low.next.description}: ${usd(low.line.balance)} on ${when(low.line)}` : `Lowest balance: ${usd(low.line.balance)} on ${when(low.line)}`;
    marks.push(markAt(text, low.line.start, low.line.end, label, "warn", { value: low.line.balance, ...(low.line.date ? { date: low.line.date } : {}) }));
  }
  return { ...(period ? { period } : {}), lines, fees, feesTotal, feesPerYear: round2(feesTotal * 12), ...(low ? { low } : {}), marks: inOrder(marks) };
}

export function feePhrases(fees: StatementFee[]): string[] {
  const count = (kind: StatementFee["kind"]) => fees.filter((f) => f.kind === kind).length;
  const phrase = (n: number, one: string, many: string) => (n === 0 ? null : n === 1 ? one : `${n} ${many}`);
  return [
    phrase(count("overdraft"), "an overdraft fee", "overdraft fees"),
    phrase(count("maintenance"), "a monthly maintenance fee", "monthly maintenance fees"),
    phrase(count("other"), "another fee", "other fees"),
  ].filter((x): x is string => !!x);
}

export function feeWords(fees: StatementFee[]): string {
  return joinAnd(feePhrases(fees)) || "no fees";
}

export function statementFinding(text: string, r: StatementReading, o: { source: string; citations: RagHit[]; createdAt: string }): Finding {
  const quoted: Evidence[] = r.marks.map((m) => ({ label: m.label, origin: "document", trusted: false, source: o.source, quote: m.quote, ...(m.value !== undefined ? { value: m.value } : {}) }));
  const calcs: Evidence[] = r.fees.length
    ? [
        { label: `Fees on this statement: ${r.fees.map((f) => usd(f.fee)).join(" + ")} = ${usd(r.feesTotal)}`, origin: "calculation", trusted: true, source: "calc:documents/statement-fees", value: r.feesTotal },
        { label: `A year at this rate: ${usd(r.feesTotal)} × 12 statements = ${usd(r.feesPerYear)}`, origin: "calculation", trusted: true, source: "calc:documents/fees-per-year", value: r.feesPerYear },
      ]
    : [];
  const low = r.low
    ? r.low.overdrawn && r.low.next
      ? ` The balance fell to ${usd(r.low.line.balance)} on ${r.low.line.date ? shortDate(r.low.line.date) : r.low.line.written}, just before the ${r.low.next.description} payment overdrew the account.`
      : ` The lowest balance was ${usd(r.low.line.balance)} on ${r.low.line.date ? shortDate(r.low.line.date) : r.low.line.written}.`
    : "";
  return {
    id: `review:${o.source.slice(4)}`,
    area: "everyday",
    tone: r.fees.length ? "warn" : "info",
    title: r.fees.length ? `${usd(r.feesTotal)} in fees on this statement: ${feeWords(r.fees)}` : "No fees found on this statement",
    summary:
      (r.fees.length
        ? `This statement charged ${usd(r.feesTotal)} in fees (${r.fees.map((f) => `${FEE_LABEL[f.kind].toLowerCase()} ${usd(f.fee)}`).join(", ")}), which is ${usd(r.feesPerYear)} a year if every month were like this one.`
        : "The keyword rules found no fee lines on this statement.") + low,
    ...(r.fees.length ? { metric: { label: "Fees a year at this rate", value: r.feesPerYear, unit: "usd_year" as const } } : {}),
    viz: { kind: "clauses", text, spans: r.marks.map(({ start, end, label, tone }) => ({ start, end, label, tone })) },
    evidence: [...quoted, ...calcs],
    citations: o.citations,
    assumptions:
      "Fee lines and balances are read from the statement by keyword rules, which can miss lines written differently. \"A year at this rate\" assumes every month has the same fees. Overdraft rules differ by bank and account, so check your account agreement. Not financial advice.",
    ask: "How do I avoid overdraft fees next month?",
    simulated: false,
    from: "research",
    createdAt: o.createdAt,
  };
}

type Row = Record<string, unknown>;

export interface MovePlan {
  checking: { id: string; name: string; balance: number };
  savings?: { id: string; name: string; balance: number };
  next?: { id: string; payee: string; amount: number; due: string };
  buffer: number;
  need?: number;
  move?: number;
}

const accountId = (a: Row) => String(a.id ?? a._id ?? "");
const accountName = (a: Row, fallback: string) => String(a.nickname ?? a.type ?? fallback);

export function planMove(i: { accounts: Row[]; bills: Row[]; policy: DelegationPolicy; now: Date }): MovePlan | undefined {
  const [checkingId, savingsId] = i.policy.ownAccounts;
  const checkingRow = i.accounts.find((a) => accountId(a) === checkingId);
  if (!checkingRow || typeof checkingRow.balance !== "number") return undefined;
  const savingsRow = i.accounts.find((a) => accountId(a) === savingsId);
  const checking = { id: checkingId!, name: accountName(checkingRow, "Checking"), balance: checkingRow.balance };
  const savings = savingsRow && typeof savingsRow.balance === "number" ? { id: savingsId!, name: accountName(savingsRow, "Savings"), balance: savingsRow.balance } : undefined;
  const day = today(i.now);
  const next = i.bills
    .filter((b) => b.status !== "paid" && typeof b.amount === "number" && typeof b.due === "string" && (b.account_id === undefined || b.account_id === checking.id) && daysBetween(day, String(b.due).slice(0, 10)) >= 0)
    .map((b) => ({ id: String(b.id ?? b._id), payee: String(b.payee ?? "a bill"), amount: Number(b.amount), due: String(b.due).slice(0, 10) }))
    .sort((a, b) => a.due.localeCompare(b.due) || b.amount - a.amount)[0];
  const buffer = i.policy.cashFlowBuffer ?? 0;
  if (!next) return { checking, ...(savings ? { savings } : {}), buffer };
  const need = round2(next.amount + buffer - checking.balance);
  return { checking, ...(savings ? { savings } : {}), next, buffer, need, ...(need > 0 && savings ? { move: need } : {}) };
}

export function withMovePlan(f: Finding, plan: MovePlan | undefined): Finding {
  if (!plan) return { ...f, summary: `${f.summary} FinGuard could not read the checking balance, so it proposes no move.` };
  const records: Evidence[] = [
    { label: `${plan.checking.name} balance today: ${usd(plan.checking.balance)}`, origin: "bank_record", trusted: true, source: `nessie.accounts#${plan.checking.id}`, value: plan.checking.balance },
    ...(plan.next
      ? [{ label: `Next bill: ${plan.next.payee} ${usd(plan.next.amount)} due ${shortDate(plan.next.due)}`, origin: "bank_record" as const, trusted: true, source: `nessie.bills#${plan.next.id}`, value: plan.next.amount }]
      : []),
    { label: `Your buffer: ${usd(plan.buffer)}`, origin: "policy", trusted: true, source: "policy:cashFlowBuffer", value: plan.buffer },
    ...(plan.move !== undefined && plan.savings
      ? [{ label: `${plan.savings.name} balance today: ${usd(plan.savings.balance)}`, origin: "bank_record" as const, trusted: true, source: `nessie.accounts#${plan.savings.id}`, value: plan.savings.balance }]
      : []),
  ];
  let calc: Evidence | undefined;
  let tail: string;
  if (!plan.next || plan.need === undefined) tail = ` No unpaid bill is on file for ${plan.checking.name.toLowerCase()}, so no move is needed now.`;
  else if (plan.move !== undefined) {
    calc = { label: `Move before ${plan.next.payee} is due: bill ${usd(plan.next.amount)} − balance ${usd(plan.checking.balance)} + buffer ${usd(plan.buffer)} = move ${usd(plan.move)}`, origin: "calculation", trusted: true, source: "calc:documents/statement-move", value: plan.move };
    tail = ` Today ${plan.checking.name.toLowerCase()} has ${usd(plan.checking.balance)}: to keep your ${usd(plan.buffer)} buffer when ${plan.next.payee} (${usd(plan.next.amount)}) is due ${shortDate(plan.next.due)}, FinGuard can move ${usd(plan.move)} from ${plan.savings!.name.toLowerCase()}. It runs only if you tap it, after SkillGate checks it.`;
  } else if (plan.need > 0) {
    tail = ` Today ${plan.checking.name.toLowerCase()} has ${usd(plan.checking.balance)}, ${usd(plan.need)} short of ${plan.next.payee} (${usd(plan.next.amount)}) plus your ${usd(plan.buffer)} buffer, and there is no savings account to move from.`;
  } else {
    const spare = round2(-plan.need);
    calc = { label: `${plan.checking.name} covers ${plan.next.payee}: balance ${usd(plan.checking.balance)} − bill ${usd(plan.next.amount)} − buffer ${usd(plan.buffer)} = ${usd(spare)} to spare`, origin: "calculation", trusted: true, source: "calc:documents/statement-move", value: spare };
    tail = ` Today ${plan.checking.name.toLowerCase()} has ${usd(plan.checking.balance)}, enough for ${plan.next.payee} (${usd(plan.next.amount)}, due ${shortDate(plan.next.due)}) plus your ${usd(plan.buffer)} buffer, so no move is needed now.`;
  }
  const quoted = f.evidence.filter((e) => e.origin === "document");
  const rest = f.evidence.filter((e) => e.origin !== "document");
  return {
    ...f,
    summary: f.summary + tail,
    evidence: [...quoted, ...records, ...(calc ? [calc] : []), ...rest],
    ...(plan.move !== undefined && plan.next && plan.savings
      ? { action: { label: `Move ${usd(plan.move)} from ${plan.savings.name.toLowerCase()} before ${plan.next.payee} is due`, tool: "bank.move_own", args: { from_account: plan.savings.id, to_account: plan.checking.id, amount: plan.move } } }
      : {}),
  };
}
