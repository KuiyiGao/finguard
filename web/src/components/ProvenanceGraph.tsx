import type { FieldProvenance, Origin, OriginKind } from "@contracts";
import { accountName, amountOf, formatUsd, ORIGIN_LABEL } from "../lib/format.ts";

const COLOR: Record<OriginKind | "missing", string> = {
  user: "var(--origin-user)",
  system: "var(--origin-system)",
  inbound_message: "var(--origin-inbound)",
  tool_text: "var(--origin-tooltext)",
  skill_text: "var(--origin-skill)",
  kb: "var(--origin-kb)",
  missing: "var(--ask)",
};

function sourceName(o: Origin): string {
  if (o.source.startsWith("policy:own")) return "your accounts";
  if (o.source.startsWith("policy:payee")) return "saved payees";
  if (o.source.startsWith("message:tap")) return "your tap";
  if (o.source.startsWith("message:")) return "your message";
  if (o.source.startsWith("inbound:")) return o.source.slice(8);
  const m = o.source.match(/\.(\w+)#/);
  return m ? m[1]! : o.source;
}

const FIELD: Record<string, string> = { from_account: "From", to_account: "To", amount: "Amount", bill_id: "Bill", subscription_id: "Subscription" };

function shown(p: FieldProvenance): string {
  if (p.field === "amount") return formatUsd(amountOf(p.value) ?? 0);
  if (p.value.startsWith("acct-")) return accountName(p.value);
  return p.value.length > 16 ? `${p.value.slice(0, 15)}…` : p.value;
}

const ROW = 40;
const W = 560;
const NODE_W = 200;

export function ProvenanceGraph({ provenance }: { provenance: FieldProvenance[] }) {
  if (provenance.length === 0) return null;
  const sources: { key: string; kind: OriginKind | "missing"; label: string; sub: string }[] = [];
  const edges: { from: number; to: number; kind: OriginKind | "missing"; trusted: boolean }[] = [];
  provenance.forEach((p, fi) => {
    const origins = p.origins.length ? p.origins : null;
    if (!origins) {
      let i = sources.findIndex((s) => s.key === "missing");
      if (i < 0) i = sources.push({ key: "missing", kind: "missing", label: "Not found anywhere", sub: "needs your confirmation" }) - 1;
      edges.push({ from: i, to: fi, kind: "missing", trusted: false });
      return;
    }
    for (const o of origins) {
      const key = `${o.kind}:${sourceName(o)}`;
      let i = sources.findIndex((s) => s.key === key);
      if (i < 0) i = sources.push({ key, kind: o.kind, label: ORIGIN_LABEL[o.kind], sub: sourceName(o) }) - 1;
      if (!edges.some((e) => e.from === i && e.to === fi)) edges.push({ from: i, to: fi, kind: o.kind, trusted: o.trusted });
    }
  });
  const rows = Math.max(sources.length, provenance.length);
  const H = rows * ROW + 8;
  const y = (i: number, n: number) => 4 + (rows - n) * (ROW / 2) + i * ROW + ROW / 2;

  return (
    <svg className="prov-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Where each value of this action came from">
      {edges.map((e, i) => {
        const y1 = y(e.from, sources.length);
        const y2 = y(e.to, provenance.length);
        return (
          <path
            key={i}
            d={`M ${NODE_W} ${y1} C ${NODE_W + 80} ${y1}, ${W - NODE_W - 80} ${y2}, ${W - NODE_W} ${y2}`}
            fill="none"
            stroke={COLOR[e.kind]}
            strokeWidth={2}
            strokeDasharray={e.trusted ? undefined : "5 4"}
          />
        );
      })}
      {sources.map((s, i) => (
        <g key={s.key} transform={`translate(0 ${y(i, sources.length) - 16})`}>
          <rect width={NODE_W} height={32} rx={8} fill="var(--surface-2)" stroke={COLOR[s.kind]} strokeWidth={1.5} />
          <text x={10} y={14} fontSize={11.5} fontWeight={700} fill={COLOR[s.kind]}>
            {s.label}
          </text>
          <text x={10} y={26} fontSize={10.5} fill="var(--text-3)">
            {s.sub.length > 30 ? `${s.sub.slice(0, 29)}…` : s.sub}
          </text>
        </g>
      ))}
      {provenance.map((p, i) => {
        const tone = p.status === "trusted" ? "var(--allow)" : p.status === "untrusted_only" ? "var(--deny)" : "var(--ask)";
        return (
          <g key={p.field} transform={`translate(${W - NODE_W} ${y(i, provenance.length) - 16})`}>
            <rect width={NODE_W} height={32} rx={8} fill="var(--surface)" stroke={tone} strokeWidth={p.status === "trusted" ? 1.5 : 2.5} />
            <text x={10} y={14} fontSize={10.5} fill="var(--text-3)">
              {FIELD[p.field] ?? p.field}
            </text>
            <text x={10} y={27} fontSize={12.5} fontWeight={700} fill="var(--text)">
              {shown(p)}
            </text>
            <text x={NODE_W - 10} y={21} fontSize={10.5} fontWeight={700} textAnchor="end" fill={tone}>
              {p.status === "trusted" ? "trusted" : p.status === "untrusted_only" ? "untrusted only" : "not found"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
