import type { Tone } from "../types.ts";

export type DocumentKind = "contract" | "statement" | "invoice";
export const DOCUMENT_KINDS: readonly DocumentKind[] = ["contract", "statement", "invoice"];

export interface DocumentMark {
  label: string;
  tone: Tone;
  start: number;
  end: number;
  quote: string;
  value?: number;
  date?: string;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (n: number) => USD.format(n);

export function money(raw: string): number {
  return Number(raw.replace(/[$,\s]/g, ""));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const DATE = String.raw`(?:[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})`;

export function isoDate(raw: string): string | undefined {
  const s = raw.trim();
  let y: number, m: number, d: number;
  const named = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (named) [y, m, d] = [Number(named[3]), MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1, Number(named[2])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [y, m, d] = [Number(us[3]), Number(us[1]), Number(us[2])];
  else return undefined;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1]} ${d}, ${y}`;
}

export const today = (now: Date) => now.toISOString().slice(0, 10);

export function markAt(text: string, start: number, end: number, label: string, tone: Tone, extra: { value?: number; date?: string } = {}): DocumentMark {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return { label, tone, start, end, quote: text.slice(start, end), ...(extra.value !== undefined ? { value: extra.value } : {}), ...(extra.date ? { date: extra.date } : {}) };
}

export function sentences(text: string): { start: number; end: number; text: string }[] {
  return [...text.matchAll(/\S[^\n]*?(?:[.!?](?=\s|$)|$)/gm)].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
}

export function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function inOrder(marks: DocumentMark[]): DocumentMark[] {
  const sorted = [...marks].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: DocumentMark[] = [];
  for (const m of sorted) if (out.every((p) => p.end <= m.start || m.end <= p.start)) out.push(m);
  return out;
}
