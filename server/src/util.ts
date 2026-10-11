import { createHash, randomInt, randomUUID } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function approvalCode(): string {
  return String(randomInt(1000, 10000));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function amountsIn(text: string): number[] {
  return [...text.replace(/,(?=\d{3})/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

export function accountNumbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d-]{2,}\d/g)].map((m) => digits(m[0])).filter((d) => d.length >= 4);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(amount: number): string {
  return usd.format(amount);
}
