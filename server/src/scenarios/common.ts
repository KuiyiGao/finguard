import type { Evidence, RagHit, Retriever } from "../types.ts";

export const DAY = 86_400_000;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (n: number) => USD.format(n);
const USD0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const usd0 = (n: number) => USD0.format(n);

export const pct = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

export { shortDate } from "../findings/normalize.ts";

export async function cite(retriever: Retriever, docId: string, query: string): Promise<RagHit[]> {
  const hits = await retriever.search(query, { k: 50 }).catch(() => [] as RagHit[]);
  const hit = hits.find((h) => h.docId === docId);
  return hit ? [hit] : [];
}

export function references(citations: RagHit[]): Evidence[] {
  return citations
    .filter((c) => c.url)
    .map((c) => ({ label: c.title, origin: "reference" as const, trusted: true, source: c.docId, url: c.url! }));
}
