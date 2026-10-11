import type { DocumentKind } from "./text.ts";

const KEYWORDS: Record<DocumentKind, [string, RegExp][]> = {
  contract: [
    ["agreement", /\bagreement\b/i],
    ["renews", /\brenew(?:s|al|ed)?\b/i],
    ["term", /\bterm\b/i],
    ["termination", /\bterminat(?:e|ion)\b/i],
    ["cancel", /\bcancel(?:lation|led|ling)?\b/i],
    ["arbitration", /\barbitration\b/i],
    ["membership", /\bmembership\b/i],
  ],
  statement: [
    ["statement", /\bstatement\b/i],
    ["statement period", /\bstatement period\b/i],
    ["beginning balance", /\b(?:beginning|opening) balance\b/i],
    ["ending balance", /\b(?:ending|closing) balance\b/i],
    ["deposits", /\bdeposits?\b/i],
    ["withdrawals", /\bwithdrawals?\b/i],
    ["overdraft", /\boverdraft\b/i],
  ],
  invoice: [
    ["invoice", /\binvoice\b/i],
    ["amount due", /\b(?:amount|balance|total) due\b/i],
    ["due date", /\bdue date\b/i],
    ["bill to", /\bbill(?:ed)? to\b/i],
    ["remit", /\bremit(?:tance)?\b/i],
    ["labor", /\blabou?r\b/i],
    ["subtotal", /\bsub-?total\b/i],
  ],
};

const TIE_ORDER: DocumentKind[] = ["invoice", "statement", "contract"];

const NOUN: Record<DocumentKind, string> = { contract: "a contract", statement: "a bank statement", invoice: "an invoice" };

export interface Classification {
  kind: DocumentKind;
  given: boolean;
  matched: Record<DocumentKind, string[]>;
  why: string;
}

export function documentNoun(kind: DocumentKind): string {
  return NOUN[kind];
}

export function classifyDocument(text: string, given?: DocumentKind): Classification {
  const matched = Object.fromEntries(TIE_ORDER.map((k) => [k, KEYWORDS[k].filter(([, re]) => re.test(text)).map(([w]) => w)])) as Record<DocumentKind, string[]>;
  if (given) return { kind: given, given: true, matched, why: `Read as ${NOUN[given]}, the kind it was shared as.` };
  const best = TIE_ORDER.reduce((a, b) => (matched[b].length > matched[a].length ? b : a));
  if (matched[best].length === 0)
    return { kind: "contract", given: false, matched, why: "Read as a contract: keyword rules found no statement or invoice words, so it gets the contract review." };
  const words = matched[best].map((w) => `"${w}"`).join(", ");
  return { kind: best, given: false, matched, why: `Read as ${NOUN[best]} by keyword rules: ${words}.` };
}
