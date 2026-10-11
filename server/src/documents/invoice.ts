import type { Evidence, Finding, RagHit, ScamAssessment } from "../types.ts";
import { DATE, daysBetween, inOrder, isoDate, longDate, markAt, money, round2, sentences, today, usd, type DocumentMark } from "./text.ts";

export interface InvoiceItem {
  label: string;
  amount: number;
  start: number;
  end: number;
  quote: string;
  hours?: number;
  rate?: number;
}

export interface InvoiceReading {
  payee?: { name: string; mark: DocumentMark };
  number?: string;
  invoiceDate?: string;
  due?: { iso: string; mark: DocumentMark };
  amountDue?: { value: number; mark: DocumentMark };
  account?: { digits: string; mark: DocumentMark };
  items: InvoiceItem[];
  itemsTotal?: number;
  termsDays?: number;
  daysUntilDue?: number;
  redFlags: DocumentMark[];
  marks: DocumentMark[];
}

export const INVOICE_RED_FLAGS: { label: string; re: RegExp }[] = [
  {
    label: "Red flag: says the bank details changed",
    re: /\b(?:bank|account|payment|banking|remittance)\s+(?:details|information|info|instructions)\s+(?:have|has)\s+(?:been\s+)?(?:changed|updated)\b|\b(?:new|updated|changed)\s+(?:bank|account|payment|remittance)\s+(?:details|information|info|instructions)\b/i,
  },
  { label: "Red flag: asks you to pay a new account", re: /\b(?:remit|send|pay|transfer|make)\b[^.\n]*\bnew (?:bank )?account\b/i },
  { label: "Red flag: pushes you to pay right away", re: /\b(?:today|immediately|urgent(?:ly)?|right away|asap|within \d+ (?:hours|minutes)|final notice)\b/i },
  { label: "Red flag: tells you not to call and check", re: /\b(?:do not|don'?t)\s+(?:call|phone|contact|visit)\b/i },
];

const NOT_AN_ITEM = /\b(?:amount|balance|total)\s+due\b|\b(?:sub-?)?total\b|\bpaid\b|\bdeposit\b/i;

function payeeOf(text: string): InvoiceReading["payee"] {
  const labeled = /^[ \t]*(?:from|payee|pay to|remit to|vendor)[ \t]*:[ \t]*(\S[^\n(]*?)[ \t]*(?:\(|$)/im.exec(text);
  if (labeled) {
    const at = labeled.index + labeled[0].indexOf(labeled[1]!);
    return { name: labeled[1]!, mark: markAt(text, at, at + labeled[1]!.length, `Payee named in the invoice: ${labeled[1]}`, "info") };
  }
  const first = /^[ \t]*(\S[^\n]*)$/m.exec(text);
  if (!first) return undefined;
  const name = first[1]!.replace(/\s*\(.*\)\s*$/, "").replace(/\s*\binvoice\b.*$/i, "").trim();
  if (!/[A-Za-z]{3}/.test(name)) return undefined;
  const at = first.index + first[0].indexOf(name);
  return { name, mark: markAt(text, at, at + name.length, `Payee named in the invoice: ${name}`, "info") };
}

export function readInvoice(text: string, now?: Date): InvoiceReading {
  const payee = payeeOf(text);
  const number = /\binvoice\s*(?:no\.?|number|#)?\s*:?\s*([A-Z]{1,5}-?\d{2,})\b/i.exec(text)?.[1];
  const issued = new RegExp(String.raw`^[ \t]*(?:invoice\s+)?date[ \t]*:?[ \t]*(${DATE})`, "im").exec(text);
  const invoiceDate = issued ? isoDate(issued[1]!) : undefined;

  const d = new RegExp(String.raw`\b(?:due date|due by|due on|payment due)[ \t]*:?[ \t]*(${DATE})`, "i").exec(text);
  const dueIso = d ? isoDate(d[1]!) : undefined;
  const due = d && dueIso ? { iso: dueIso, mark: markAt(text, d.index, d.index + d[0].length, `Due date: ${longDate(dueIso)}`, "info", { date: dueIso }) } : undefined;

  const a = /\b(?:amount|balance|total)\s+due\b[ \t:]*\$[ \t]?([\d,]+\.\d{2})/i.exec(text);
  const amountDue = a ? { value: money(a[1]!), mark: markAt(text, a.index, a.index + a[0].length, `Amount due: ${usd(money(a[1]!))}`, "warn", { value: money(a[1]!) }) } : undefined;

  const acct = /\b(?:account|acct\.?)\s*(?:number|no\.?|#)[ \t]*:?[ \t]*(\d[\d -]{2,}\d)/i.exec(text);
  const digits = acct ? acct[1]!.replace(/\D/g, "") : "";
  const account = acct && digits.length >= 4 ? { digits, mark: markAt(text, acct.index, acct.index + acct[0].length, `Account to pay, written only in this invoice: ending ${digits.slice(-4)}`, "bad") } : undefined;

  const items: InvoiceItem[] = [...text.matchAll(/^[ \t]*([A-Za-z][^\n]*?)[ \t]+\$([\d,]+\.\d{2})[ \t]*$/gm)]
    .filter((m) => !NOT_AN_ITEM.test(m[1]!))
    .map((m) => {
      const span = markAt(text, m.index, m.index + m[0].length, "", "info");
      const rate = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\s*(?:at|@|x|×)\s*\$([\d,]+\.\d{2})/i.exec(m[1]!);
      return { label: m[1]!.trim(), amount: money(m[2]!), start: span.start, end: span.end, quote: span.quote, ...(rate ? { hours: Number(rate[1]), rate: money(rate[2]!) } : {}) };
    });
  const itemsTotal = items.length ? round2(items.reduce((sum, i) => sum + i.amount, 0)) : undefined;

  const taken = [payee?.mark, due?.mark, amountDue?.mark, account?.mark].filter((m): m is DocumentMark => !!m);
  const redFlags: DocumentMark[] = [];
  for (const s of sentences(text)) {
    if (taken.some((m) => m.start < s.end && s.start < m.end)) continue;
    const rule = INVOICE_RED_FLAGS.find((r) => r.re.test(s.text));
    if (rule) redFlags.push(markAt(text, s.start, s.end, rule.label, "bad"));
  }

  return {
    ...(payee ? { payee } : {}),
    ...(number ? { number } : {}),
    ...(invoiceDate ? { invoiceDate } : {}),
    ...(due ? { due } : {}),
    ...(amountDue ? { amountDue } : {}),
    ...(account ? { account } : {}),
    items,
    ...(itemsTotal !== undefined ? { itemsTotal } : {}),
    ...(invoiceDate && due ? { termsDays: daysBetween(invoiceDate, due.iso) } : {}),
    ...(now && due ? { daysUntilDue: daysBetween(today(now), due.iso) } : {}),
    redFlags,
    marks: inOrder([...taken, ...redFlags]),
  };
}

const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

export function dueWords(n: number): string {
  return n === 0 ? "today" : n > 0 ? `in ${days(n)}` : `${days(-n)} ago`;
}

export function invoiceFinding(text: string, r: InvoiceReading, o: { source: string; citations: RagHit[]; createdAt: string }): Finding {
  const quoted: Evidence[] = r.marks.map((m) => ({ label: m.label, origin: "document", trusted: false, source: o.source, quote: m.quote, ...(m.value !== undefined ? { value: m.value } : {}) }));
  const calcs: Evidence[] = [];
  const labor = r.items.find((i) => i.hours !== undefined && i.rate !== undefined);
  if (r.items.length >= 2 && r.itemsTotal !== undefined) {
    const parts = r.items.map((i) => `${i.label.split(/[,(]/)[0]!.trim().toLowerCase()} ${usd(i.amount)}`);
    calcs.push({ label: `Invoice total: ${parts.join(" + ")} = ${usd(r.itemsTotal)}`, origin: "calculation", trusted: true, source: "calc:documents/invoice-total", value: r.itemsTotal });
  }
  if (labor) {
    const product = round2(labor.hours! * labor.rate!);
    calcs.push({ label: `Labor: ${labor.hours} hours × ${usd(labor.rate!)} = ${usd(product)}${product === labor.amount ? ", as billed" : `, but the invoice bills ${usd(labor.amount)}`}`, origin: "calculation", trusted: true, source: "calc:documents/invoice-labor", value: product });
  }
  if (r.due && r.daysUntilDue !== undefined)
    calcs.push({ label: `Due ${longDate(r.due.iso)}: ${dueWords(r.daysUntilDue)}${r.termsDays !== undefined ? ` (${days(r.termsDays)} after the invoice date)` : ""}`, origin: "calculation", trusted: true, source: "calc:documents/invoice-days", value: r.daysUntilDue });

  const amount = r.amountDue?.value ?? r.itemsTotal;
  const totalNote = r.amountDue && r.itemsTotal !== undefined ? (Math.abs(r.amountDue.value - r.itemsTotal) < 0.005 ? " The line items add up to the amount due." : ` The line items add up to ${usd(r.itemsTotal)}, not the ${usd(r.amountDue.value)} it asks for.`) : "";
  const who = r.payee ? r.payee.name : "The sender";
  return {
    id: `review:${o.source.slice(4)}`,
    area: "protection",
    tone: r.account || r.redFlags.length ? "warn" : "info",
    title: r.account && amount !== undefined ? `Invoice asks you to pay ${usd(amount)} to an account ending ${r.account.digits.slice(-4)}` : amount !== undefined ? `Invoice for ${usd(amount)}` : "Invoice read",
    summary:
      `${who} asks for ${amount !== undefined ? usd(amount) : "a payment"}${r.due ? ` by ${longDate(r.due.iso)}${r.daysUntilDue !== undefined ? ` (${dueWords(r.daysUntilDue)})` : ""}` : ""}` +
      (r.account ? `, paid to an account ending ${r.account.digits.slice(-4)} that is written only in this invoice.` : ".") +
      totalNote +
      (r.redFlags.length ? ` ${r.redFlags.length === 1 ? "One sentence carries" : `${r.redFlags.length} sentences carry`} common payment-scam signals.` : ""),
    ...(amount !== undefined ? { metric: { label: "Amount the invoice asks for", value: amount, unit: "usd" as const } } : {}),
    viz: { kind: "clauses", text, spans: r.marks.map(({ start, end, label, tone }) => ({ start, end, label, tone })) },
    evidence: [...quoted, ...calcs],
    citations: o.citations,
    assumptions:
      "The payee, account, amount, dates and warning sentences are read by keyword rules, which can miss terms written differently. The account and amount in an invoice are the sender's instructions, not your records: confirm any change of payment details with the company on a number you already know.",
    ask: "How do I check whether this invoice is real?",
    simulated: false,
    from: "research",
    createdAt: o.createdAt,
  };
}

type Row = Record<string, unknown>;

export interface PayeeCheck {
  onFile?: { id: string; name: string; account: string; addedAt?: string };
  differs: boolean;
}

export function checkPayee(r: InvoiceReading, payees: Row[], text: string): PayeeCheck {
  const lower = text.toLowerCase();
  const found = payees.find((p) => typeof p.name === "string" && p.name.length >= 3 && (lower.includes(p.name.toLowerCase()) || (!!r.payee && r.payee.name.toLowerCase() === p.name.toLowerCase())));
  const onFile = found ? { id: String(found.id ?? found._id ?? ""), name: String(found.name), account: String(found.account ?? ""), ...(typeof found.addedAt === "string" ? { addedAt: found.addedAt } : {}) } : undefined;
  const want = r.account?.digits ?? "";
  const filed = (onFile?.account ?? "").replace(/\D/g, "");
  const same = want.length >= 4 && filed.length >= 4 && (want === filed || want.endsWith(filed) || filed.endsWith(want));
  return { ...(onFile ? { onFile } : {}), differs: !!r.account && !!onFile && !same };
}

export function withPayeeCheck(f: Finding, r: InvoiceReading, check: PayeeCheck, o: { fromAccount: string; scam?: ScamAssessment; scamSource?: string }): Finding {
  const records: Evidence[] = [];
  if (check.onFile)
    records.push({
      label: `${check.onFile.name} on file: account ending ${check.onFile.account.replace(/\D/g, "").slice(-4)}${check.onFile.addedAt ? `, saved since ${longDate(check.onFile.addedAt.slice(0, 10))}` : ""}`,
      origin: "bank_record",
      trusted: true,
      source: `nessie.payees#${check.onFile.id}`,
    });
  const compare: Evidence[] =
    r.account && check.onFile
      ? [
          {
            label: check.differs
              ? `Account check: the invoice's account (ending ${r.account.digits.slice(-4)}) is not ${check.onFile.name}'s account on file (ending ${check.onFile.account.replace(/\D/g, "").slice(-4)})`
              : `Account check: the invoice's account matches ${check.onFile.name}'s account on file`,
            origin: "calculation",
            trusted: true,
            source: "calc:documents/payee-check",
          },
        ]
      : r.account && r.payee
        ? [{ label: `Account check: ${r.payee.name} is not one of your saved payees, so nothing on file vouches for this account`, origin: "calculation", trusted: true, source: "calc:documents/payee-check" }]
        : [];
  const scam: Evidence[] =
    o.scam && o.scamSource
      ? [{ label: `ScamShield: ${o.scam.risk} risk, ${o.scam.score}/100${o.scam.typologies[0] ? ` (${o.scam.typologies[0].name.toLowerCase()})` : ""}`, origin: "calculation", trusted: true, source: o.scamSource }]
      : [];
  const quoted = f.evidence.filter((e) => e.origin === "document");
  const calcs = f.evidence.filter((e) => e.origin !== "document");
  const amount = r.amountDue?.value ?? r.itemsTotal;
  const swapped = check.differs && check.onFile && r.account;
  const tail = swapped
    ? ` ${check.onFile!.name}'s account on file ends in ${check.onFile!.account.replace(/\D/g, "").slice(-4)}, so this is a change of payment details. Do not pay the new account: check the change with ${check.onFile!.name} on a number you already know. Paying it as written goes to SkillGate, which stops an account that appears only in a document.`
    : r.account && !check.onFile
      ? " Nothing on file vouches for the account it gives, so check it with the company on a number you already know."
      : "";
  const citations = [...f.citations];
  for (const t of o.scam?.typologies ?? []) if (t.citation.docId.startsWith("kb:") && !citations.some((c) => c.docId === t.citation.docId)) citations.push(t.citation);
  return {
    ...f,
    tone: swapped || o.scam?.risk === "high" ? "block" : f.tone,
    title: swapped ? `Invoice asks you to pay a new account, not ${check.onFile!.name}'s account on file` : f.title,
    summary: f.summary + tail,
    evidence: [...quoted, ...records, ...calcs, ...compare, ...scam],
    citations,
    ...(r.account && amount !== undefined
      ? {
          action: {
            label: `Pay as the invoice asks: ${usd(amount)} to the account ending ${r.account.digits.slice(-4)}`,
            tool: "bank.transfer",
            args: { from_account: o.fromAccount, to_account: r.account.digits, amount, ...(r.payee ? { payee_name: r.payee.name } : {}) },
          },
        }
      : {}),
  };
}
