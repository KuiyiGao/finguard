import { formatUsd } from "../../lib/format.ts";

export type ValueUnit = "usd" | "usd_month" | "usd_year" | "pct" | "days" | "score" | "number";

const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatValue(value: number, unit: ValueUnit = "usd"): string {
  switch (unit) {
    case "usd":
      return formatUsd(value);
    case "usd_month":
      return `${formatUsd(value)}/mo`;
    case "usd_year":
      return `${formatUsd(value)}/yr`;
    case "pct":
      return `${plain.format(value)}%`;
    case "days": {
      const d = Math.round(value);
      return `${whole.format(d)} ${d === 1 ? "day" : "days"}`;
    }
    case "score":
      return whole.format(Math.round(value));
    default:
      return plain.format(value);
  }
}

export function compactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000)}k`;
  return `${sign}$${whole.format(abs)}`;
}

function trim(n: number): string {
  return n >= 100 ? whole.format(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function shortDate(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return value;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
