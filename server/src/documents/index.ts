import { cite, references } from "../scenarios/common.ts";
import { extractClauses, type Clause } from "../scenarios/contracts.ts";
import { MAX_CONTRACT_CHARS, reviewContract } from "../research/contracts.ts";
import type { Finding, Retriever } from "../types.ts";
import { sha256 } from "../util.ts";
import { invoiceFinding, readInvoice, type InvoiceReading } from "./invoice.ts";
import { readStatement, statementFinding, type StatementReading } from "./statement.ts";
import type { DocumentKind, DocumentMark } from "./text.ts";

export { classifyDocument, documentNoun, type Classification } from "./classify.ts";
export { checkPayee, dueWords, invoiceFinding, readInvoice, withPayeeCheck, type InvoiceReading, type PayeeCheck } from "./invoice.ts";
export { documentSamples, sampleFor, servedText, type DocumentSample } from "./samples.ts";
export { feePhrases, feeWords, planMove, readStatement, statementFinding, withMovePlan, type MovePlan, type StatementReading } from "./statement.ts";
export { DOCUMENT_KINDS, joinAnd, type DocumentKind, type DocumentMark } from "./text.ts";

export const MAX_DOCUMENT_CHARS = MAX_CONTRACT_CHARS;

export const DOCUMENT_SOURCES: Record<DocumentKind, { docId: string; query: string }> = {
  contract: { docId: "kb:contracts/auto-renewal", query: "contract renews automatically cancellation notice" },
  statement: { docId: "kb:savings/overdraft", query: "overdraft fee cash buffer upcoming bills" },
  invoice: { docId: "kb:scams/invoice-payee-swap", query: "invoice asks to pay a new account number changed bank details payee" },
};

export interface Annotation {
  kind: DocumentKind;
  marks: DocumentMark[];
  clauses: Clause[];
  statement?: StatementReading;
  invoice?: InvoiceReading;
  finding: Finding;
}

export async function annotateDocument(text: string, kind: DocumentKind, o: { retriever?: Retriever; now?: Date } = {}): Promise<Annotation> {
  const now = o.now ?? new Date();
  if (kind === "contract") {
    const clauses = extractClauses(text);
    const marks = clauses.map(({ label, tone, start, end, quote, amount }) => ({ label, tone, start, end, quote, ...(amount !== undefined ? { value: amount } : {}) }));
    return { kind, marks, clauses, finding: await reviewContract(text, { ...(o.retriever ? { retriever: o.retriever } : {}), now }) };
  }
  const source = `doc:${kind}#${sha256(text).slice(0, 12)}`;
  const { docId, query } = DOCUMENT_SOURCES[kind];
  const citations = o.retriever ? await cite(o.retriever, docId, query) : [];
  const createdAt = now.toISOString();
  if (kind === "statement") {
    const statement = readStatement(text);
    const finding = statementFinding(text, statement, { source, citations, createdAt });
    return { kind, marks: statement.marks, clauses: [], statement, finding: { ...finding, evidence: [...finding.evidence, ...references(citations)] } };
  }
  const invoice = readInvoice(text, now);
  const finding = invoiceFinding(text, invoice, { source, citations, createdAt });
  return { kind, marks: invoice.marks, clauses: [], invoice, finding: { ...finding, evidence: [...finding.evidence, ...references(citations)] } };
}
