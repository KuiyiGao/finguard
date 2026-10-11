import type { RunOutcome } from "../policy/run.ts";
import { RULE_ORDER, signalText } from "../findings/normalize.ts";
import type { ScamAssessment } from "../types.ts";

export function explainAssessment(a: ScamAssessment): string {
  const flags = a.redFlags.slice(0, 3).map((f) => signalText(f.signal).phrase);
  const kinds = a.typologies.map((t) => t.name.toLowerCase());
  if (a.risk === "high")
    return `This looks like a scam${kinds.length ? ` (${kinds.join("; ")})` : ""}: ${flags.join(", ")}. ${a.advice.join(" ")}`.trim();
  if (a.risk === "medium") return `Be careful: ${flags.join(", ")}. ${a.advice[0] ?? ""}`.trim();
  return "I see no strong warning signs in this message. If it asks for money, check with the sender on a number you already know.";
}

export function explainOutcome(o: RunOutcome): string | null {
  switch (o.status) {
    case "executed":
      return o.receipt ? `Done: ${o.receipt.action}. Receipt ${o.receipt.id}.` : null;
    case "denied": {
      const why = o.decision.reasons
        .filter((r) => r.verdict === "deny")
        .sort((a, b) => RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule))
        .map((r) => r.message);
      const advice = o.decision.scam?.risk === "high" ? ` ${o.decision.scam.advice[0] ?? ""}` : "";
      return `I did not do it. ${why.slice(0, 2).join(" ")}${advice}`.trim();
    }
    case "not_approved":
      return o.approval.status === "expired" ? "The approval request expired, so nothing was sent." : "You declined, so nothing was sent.";
    case "blocked":
      return `I stopped before it ran: ${o.error}`;
    case "failed":
      return `The bank did not complete it: ${o.error}`;
  }
}
