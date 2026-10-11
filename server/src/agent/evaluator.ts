import type { RunOutcome } from "../policy/run.ts";
import type { AuthorizationReceipt, ScamAssessment } from "../types.ts";
import { explainAssessment, explainOutcome } from "./explain.ts";

export interface TurnEvidence {
  userText: string;
  policy: unknown;
  outcomes: RunOutcome[];
  records: unknown[];
  receipts: AuthorizationReceipt[];
  pendingApprovals: number;
}

export interface Review {
  ok: boolean;
  problems: string[];
}

export function emptyEvidence(userText: string, policy: unknown): TurnEvidence {
  return { userText, policy, outcomes: [], records: [], receipts: [], pendingApprovals: 0 };
}

export function withoutCode(o: RunOutcome): RunOutcome {
  if (!("approval" in o) || !o.approval) return o;
  const { code: _code, ...approval } = o.approval;
  return { ...o, approval: approval as typeof o.approval };
}

const NEGATION = /\b(not|no|nothing|never|none|cannot|unable|without|stopped|blocked|declined|denied|expired|failed|refused|instead)\b|n't\b/i;
const CLAIM = /\b(done|paid|moved|sent|transferred|cancell?ed|completed)\b/i;
const PENDING = /\b(waiting for|awaiting|pending)\b[^.!?]{0,40}\b(code|approv\w*)\b|\bonce you approve\b|\bwill go through\b/i;
const ASKS_SECRET = /\b(send|tell|give|share|text|reply with|type|enter|provide|what is|what's)\b[^.!?]{0,30}\b(code|password|passcode|pin|card number|cvv|security code|social security|ssn)\b/i;
const ADVICE = [
  /\b(you should|i (would |'d )?(recommend|suggest)|i recommend|consider|it's a good idea to|go ahead and)\b[^.!?]{0,40}\b(buy|sell|short|invest)\b/i,
  /\b(buy|sell|short)\b[^.!?]{0,25}\b(stocks?|shares?|bonds?|crypto\w*|bitcoin|etfs?|index funds?|mutual funds?|options|gold)\b/i,
  /\binvest(ing)? (in|into)\b/i,
];
const KB_ID = /\bkb:[a-z0-9_-]+(?:\/[a-z0-9_.-]*[a-z0-9_-])*/gi;
const YEAR = /^(19|20)\d{2}$/;

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
const cents = (raw: string) => Math.round(Number(raw.replace(/,/g, "")) * 100);

function evidenceText(ev: TurnEvidence): string {
  return JSON.stringify([ev.userText, ev.policy, ev.outcomes.map(withoutCode), ev.records, ev.receipts]);
}

export function dollarAmounts(text: string): string[] {
  return [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:dollars|usd)\b/gi)].map((m) => (m[1] ?? m[2])!.replace(/,$/, ""));
}

export function accountNumbers(text: string): string[] {
  const stripped = text
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ")
    .replace(/\b\d[\d,]*(?:\.\d+)?\s?(?:dollars|usd)\b/gi, " ")
    .replace(/\b[a-z]+_[a-z0-9]+\b/gi, " ") // rcpt_..., appr_..., turn_...
    .replace(/\bkb:\S+/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, " ");
  return [...stripped.matchAll(/\d[\d-]{2,}\d/g)].map((m) => m[0].replace(/-/g, "")).filter((d) => d.length >= 4 && !YEAR.test(d));
}

export function evaluateReply(text: string, ev: TurnEvidence, kbIds: ReadonlySet<string>): Review {
  const problems: string[] = [];
  const corpus = evidenceText(ev);
  const known = new Set([...corpus.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => cents(m[0].replace(/,$/, ""))));
  const digitRuns = [...corpus.matchAll(/\d+/g)].map((m) => m[0]);

  for (const amount of new Set(dollarAmounts(text)))
    if (!known.has(cents(amount))) problems.push(`The amount $${amount} does not appear in this turn's records or the customer's words.`);
  for (const account of new Set(accountNumbers(text)))
    if (!digitRuns.some((d) => d === account || d.endsWith(account))) problems.push(`The number ${account} does not appear in this turn's records or the customer's words.`);

  for (const sentence of sentences(text)) {
    const negated = NEGATION.test(sentence);
    if (!negated && CLAIM.test(sentence) && ev.receipts.length === 0)
      problems.push(`It says "${CLAIM.exec(sentence)![0]}" but no action was completed with a receipt in this turn.`);
    if (!negated && PENDING.test(sentence) && ev.pendingApprovals === 0) problems.push("It says an approval is waiting, but none is pending.");
    if (!negated && ASKS_SECRET.test(sentence) && !/\bin (the|your) app\b/i.test(sentence)) problems.push("It asks the customer for a code, password or card number.");
    if (!negated && ADVICE.some((re) => re.test(sentence))) problems.push("It reads as investment advice (buy, sell or invest in); give general information instead.");
  }

  for (const id of new Set([...text.matchAll(KB_ID)].map((m) => m[0])))
    if (!kbIds.has(id)) problems.push(`It cites ${id}, which is not in the knowledge base.`);

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

function isAssessment(x: unknown): x is ScamAssessment {
  return !!x && typeof x === "object" && "risk" in x && "redFlags" in x && "advice" in x;
}

export function deterministicReply(ev: TurnEvidence): string {
  const lines = ev.outcomes.map((o) => explainOutcome(o)).filter((l): l is string => !!l);
  if (lines.length) return lines.join(" ");
  const assessment = ev.records.find(isAssessment);
  if (assessment) return explainAssessment(assessment);
  return "I could not give you an answer I can back up with your records, so I stopped there. Nothing was moved or changed.";
}
