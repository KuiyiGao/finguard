import { cite, references } from "../scenarios/common.ts";
import { contractTerms, extractClauses } from "../scenarios/contracts.ts";
import type { Evidence, Finding, Retriever } from "../types.ts";
import { sha256 } from "../util.ts";

export const MAX_CONTRACT_CHARS = 20_000;

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function monthlyPriceQuoted(text: string): { value: number; quote: string } | undefined {
  const m =
    text.match(/\$\s?(\d[\d,]*(?:\.\d{2})?)\s*(?:per month|a month|each month|\/\s?mo(?:nth)?\b|monthly)/i) ??
    text.match(/\bmonthly (?:dues|fees?|payments?|price|rate|charges?)\s+(?:of\s+|is\s+|are\s+)?\$\s?(\d[\d,]*(?:\.\d{2})?)/i);
  return m ? { value: Number(m[1]!.replace(/,/g, "")), quote: m[0] } : undefined;
}

export function monthlyPriceIn(text: string): number | undefined {
  return monthlyPriceQuoted(text)?.value;
}

export async function reviewContract(text: string, opts: { retriever?: Retriever; now?: Date } = {}): Promise<Finding> {
  const now = opts.now ?? new Date();
  const clauses = extractClauses(text);
  const terms = contractTerms(now, clauses);
  const has = (label: string) => clauses.find((c) => c.label === label);
  const notice = has("How to cancel")?.quote.match(/(\d+)\s+days/);
  const annualFee = has("Extra fee") ? terms.annualFee : undefined;
  const etf = has("Early termination fee") ? terms.earlyTerminationFee : null;
  const price = monthlyPriceQuoted(text);
  const monthly = price?.value;

  const facts = [
    has("Auto-renews") && "it renews automatically",
    has("How to cancel") && (notice ? `cancelling needs notice ${notice[1]} days ahead` : "it sets a specific way to cancel"),
    etf !== null && `an early termination fee of ${usd(etf)} applies`,
    annualFee !== undefined && `there is an extra fee of ${usd(annualFee)}`,
    has("Price can change") && "the price can change",
    has("Arbitration") && "disputes go to arbitration",
  ].filter((x): x is string => !!x);

  const citations = has("Auto-renews") && opts.retriever ? await cite(opts.retriever, "kb:contracts/auto-renewal", "contract renews automatically cancellation notice") : [];
  const source = `doc:pasted-contract#${sha256(text).slice(0, 12)}`;
  const evidence: Evidence[] = [
    ...clauses.map((c) => ({
      label: c.amount !== undefined ? `${c.label}: ${usd(c.amount)}` : c.label,
      origin: "document" as const,
      trusted: false,
      source,
      quote: c.quote,
      ...(c.amount !== undefined ? { value: c.amount } : {}),
    })),
    ...(price ? [{ label: `Monthly price written in the contract: ${usd(price.value)}`, origin: "document" as const, trusted: false, source, quote: price.quote, value: price.value }] : []),
    ...references(citations),
  ];
  const bad = clauses.some((c) => c.tone === "bad");
  return {
    id: `review:${source.slice(4)}`,
    area: "contracts",
    tone: clauses.length ? "warn" : "info",
    title: clauses.length ? `${clauses.length} clause${clauses.length === 1 ? "" : "s"} to read closely: ${clauses.map((c) => c.label).join(", ")}` : "No renewal, fee, price-change or arbitration clauses found",
    summary: facts.length
      ? `In this contract, ${facts.join("; ")}.${monthly !== undefined ? ` It names a monthly price of ${usd(monthly)}.` : ""} Each highlighted clause quotes the text you pasted.`
      : "The keyword rules found no auto-renewal, cancellation, fee, price-change or arbitration clause. Rules can miss terms written differently, so read the whole agreement.",
    ...(etf !== null ? { metric: { label: "Early termination fee", value: etf, unit: "usd" as const } } : annualFee !== undefined ? { metric: { label: "Extra fee", value: annualFee, unit: "usd" as const } } : {}),
    viz: { kind: "clauses", text, spans: clauses.map(({ start, end, label, tone }) => ({ start, end, label, tone })) },
    evidence,
    citations,
    assumptions: `Clauses are found by keyword rules, which can miss or mislabel terms; read the whole agreement. ${bad ? "Fees are quoted as written. " : ""}Not legal advice.`,
    ask: "What does this contract commit me to if I do nothing?",
    simulated: false,
    from: "research",
    createdAt: now.toISOString(),
  };
}
