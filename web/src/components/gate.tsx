import type { Decision, FieldProvenance, OriginKind, Reason, Verdict } from "@contracts";
import { BookOpen, CircleCheck, CircleQuestionMark, Clock, FileText, Landmark, MessageSquareWarning, Puzzle, ShieldCheck, ShieldX, User, type LucideIcon } from "lucide-react";
import { prettyId } from "../lib/describe.ts";
import { accountName, amountOf, formatUsd, ORIGIN_LABEL, RULE_LABEL, shortHash, VERDICT_LABEL } from "../lib/format.ts";
import { RULE_ORDER } from "../lib/normalize.ts";

const VERDICT_ICON: Record<Verdict, LucideIcon> = { allow: ShieldCheck, ask: Clock, deny: ShieldX };
const RULE_ICON: Record<Verdict, LucideIcon> = { allow: CircleCheck, ask: Clock, deny: ShieldX };
const ORIGIN_ICON: Record<OriginKind, LucideIcon> = {
  user: User,
  system: Landmark,
  inbound_message: MessageSquareWarning,
  tool_text: FileText,
  skill_text: Puzzle,
  kb: BookOpen,
};

export function VerdictBadge({ verdict, large = false, label }: { verdict: Verdict; large?: boolean; label?: string }) {
  const Icon = VERDICT_ICON[verdict];
  return (
    <span className={`badge badge-${verdict}${large ? " badge-lg" : ""}`}>
      <Icon aria-hidden /> {label ?? VERDICT_LABEL[verdict]}
    </span>
  );
}

export function OriginChip({ origin, title }: { origin: OriginKind | "missing"; title?: string }) {
  if (origin === "missing")
    return (
      <span className="chip chip-missing" title={title}>
        <CircleQuestionMark aria-hidden /> Not found anywhere
      </span>
    );
  const Icon = ORIGIN_ICON[origin];
  return (
    <span className={`chip chip-${origin}`} title={title}>
      <Icon aria-hidden /> {ORIGIN_LABEL[origin]}
    </span>
  );
}

export function sortReasons(reasons: Reason[]): Reason[] {
  const order: Record<Verdict, number> = { deny: 0, ask: 1, allow: 2 };
  return [...reasons].sort((a, b) => order[a.verdict] - order[b.verdict] || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
}

export function RuleList({ reasons, compact = false }: { reasons: Reason[]; compact?: boolean }) {
  const sorted = sortReasons(reasons);
  const shown = compact ? sorted.filter((r) => r.verdict !== "allow").slice(0, 3) : sorted;
  return (
    <ul className="rules">
      {shown.map((r, i) => {
        const Icon = RULE_ICON[r.verdict];
        return (
          <li key={i} className={`rule rule-${r.verdict}`}>
            <Icon className="rule-icon" aria-label={VERDICT_LABEL[r.verdict]} />
            <span>
              {!compact && <span className="rule-name">{RULE_LABEL[r.rule]}</span>}
              <span className="rule-text">{r.message}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function fieldLabel(field: string): string {
  const known = ({ from_account: "From", to_account: "To", amount: "Amount", bill_id: "Bill", subscription_id: "Subscription", payee_name: "Payee" } as Record<string, string>)[field];
  if (known) return known;
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function fieldDisplay(field: string, value: string): string {
  if (field === "amount") return formatUsd(amountOf(value) ?? 0);
  if (value.startsWith("acct-")) return accountName(value);
  if (field === "bill_id" || field === "subscription_id") return prettyId(value);
  return value;
}

export function ProvenanceList({ provenance, showExcerpts = true }: { provenance: FieldProvenance[]; showExcerpts?: boolean }) {
  if (provenance.length === 0) return null;
  return (
    <div className="prov">
      {provenance.map((p) => {
        const kinds = [...new Set(p.origins.map((o) => o.kind))];
        const untrusted = p.origins.find((o) => !o.trusted);
        return (
          <div className="prov-row" key={p.field}>
            <span className="prov-field">{fieldLabel(p.field)}</span>
            <span className="prov-value num">{fieldDisplay(p.field, p.value)}</span>
            {kinds.length === 0 ? <OriginChip origin="missing" /> : kinds.map((k) => <OriginChip key={k} origin={k} title={p.origins.filter((o) => o.kind === k).map((o) => o.source).join(", ")} />)}
            {showExcerpts && p.status === "untrusted_only" && untrusted?.excerpt && <span className="prov-excerpt">“{untrusted.excerpt}”</span>}
          </div>
        );
      })}
    </div>
  );
}

export function DecisionMeta({ decision }: { decision: Decision }) {
  return (
    <span className="faint num" style={{ fontSize: 12 }}>
      reviewed in {decision.latencyMs} ms, call {shortHash(decision.callId.replace(/^call_/, ""), 6)}
    </span>
  );
}
