import type { FieldProvenance, Origin, OriginKind } from "../types.ts";
import { accountNumbersIn, amountsIn, digits, parseAmount } from "../util.ts";

const TRUSTED: ReadonlySet<OriginKind> = new Set(["user", "system"]);

export interface Sighting {
  turnId: string;
  origin: Origin;
  text?: string;
  value?: string | number;
  kinds?: FieldKind[];
}

export type FieldKind = "amount" | "account" | "id" | "text";

function fieldKind(field: string): FieldKind {
  if (field === "amount" || field.endsWith("_amount")) return "amount";
  if (field.includes("account")) return "account";
  if (field.endsWith("_id")) return "id";
  return "text";
}

function sameAccount(a: string, b: string): boolean {
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 4 && (a.endsWith(b) || b.endsWith(a));
}

function excerpt(text: string, needle: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(needle.toLowerCase()));
  const start = Math.max(0, at - 30);
  return (start > 0 ? "..." : "") + text.slice(start, start + 80).trim() + (start + 80 < text.length ? "..." : "");
}

function locate(field: string, value: unknown, s: Sighting): string | null {
  const kind = fieldKind(field);
  if (s.kinds && !s.kinds.includes(kind)) return null;
  if (kind === "amount") {
    const target = parseAmount(value);
    if (target === null) return null;
    const close = (n: number) => Math.abs(n - target) < 0.005;
    if (s.value !== undefined) return close(Number(parseAmount(s.value))) ? String(s.value) : null;
    const hit = s.text ? amountsIn(s.text).find(close) : undefined;
    return hit === undefined ? null : excerpt(s.text!, String(hit).split(".")[0]!);
  }
  const raw = String(value);
  if (kind === "account" && digits(raw).length >= 4) {
    const want = digits(raw);
    if (s.value !== undefined) return String(s.value) === raw || sameAccount(digits(s.value), want) ? String(s.value) : null;
    const hit = s.text ? accountNumbersIn(s.text).find((c) => sameAccount(c, want)) : undefined;
    return hit === undefined ? null : excerpt(s.text!, hit.slice(-4));
  }
  if (s.value !== undefined) return String(s.value).toLowerCase() === raw.toLowerCase() ? String(s.value) : null;
  return s.text && raw && s.text.toLowerCase().includes(raw.toLowerCase()) ? excerpt(s.text, raw) : null;
}

export class ProvenanceLedger {
  private sightings: Sighting[] = [];
  private turns: string[] = [];

  constructor(private readonly windowTurns = 5) {}

  addText(turnId: string, kind: OriginKind, source: string, text: string): void {
    this.add({ turnId, origin: { kind, source, trusted: TRUSTED.has(kind) }, text });
  }

  addValue(turnId: string, kind: OriginKind, source: string, value: string | number): void {
    this.add({ turnId, origin: { kind, source, trusted: TRUSTED.has(kind) }, value });
  }

  reset(): void {
    this.sightings = [];
    this.turns = [];
  }

  recent(): Sighting[] {
    const window = new Set(this.turns.slice(-this.windowTurns));
    return this.sightings.filter((s) => window.has(s.turnId));
  }

  texts(kind: OriginKind): string[] {
    return this.recent()
      .filter((s) => s.origin.kind === kind && s.text)
      .map((s) => s.text!);
  }

  trace(field: string, value: unknown, extra: Sighting[] = [], vouches: (s: Sighting) => boolean = () => true): FieldProvenance {
    const origins: Origin[] = [];
    for (const s of [...extra, ...this.recent()].filter((x) => !x.origin.trusted || vouches(x))) {
      const found = locate(field, value, s);
      if (found !== null && !origins.some((o) => o.source === s.origin.source)) origins.push({ ...s.origin, excerpt: found });
    }
    const status = origins.some((o) => o.trusted) ? "trusted" : origins.length ? "untrusted_only" : "not_found";
    return { field, value: String(value), status, origins };
  }

  private add(s: Sighting): void {
    if (!this.turns.includes(s.turnId)) this.turns.push(s.turnId);
    this.sightings.push(s);
  }
}
