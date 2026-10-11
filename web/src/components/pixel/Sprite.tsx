import { BookOpen, Check, Coins, Database, FileText, Landmark, MessageCircle, Pause, PiggyBank, Scale, ScanSearch, Search, Send, Shield, ShieldCheck, TriangleAlert, Waypoints, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { BRAND } from "../../lib/brand.ts";
import { objectOf, outfitOf, type Outfit, type SkillName, type SpriteName, type SpriteState } from "./names.ts";
import { StageObjectIcon } from "./objects.tsx";
import "./mark.css";

export type { Outfit, SkillName, SpriteName, SpriteState, StageObject } from "./names.ts";
export { objectOf, OUTFITS, outfitOf, SKILL_NAMES, SPRITE_NAMES } from "./names.ts";
export { GateRing, Phone, Seal, gateFor, sealFor, StageObjectIcon, type GateState, type PhoneState, type SealState } from "./objects.tsx";
export type SpriteStatus = "ok" | "warn" | "bad";

export const SPRITE_LABEL: Record<SpriteName, string> = {
  customer: "Customer",
  orchestrator: "Orchestrator",
  guardian: "Guardian",
  payments: "Payments",
  savings: "Savings",
  advisor: "Advisor",
  research: "Research",
  evaluator: "Evaluator",
  skillgate: "SkillGate",
};

export const OUTFIT_LABEL: Record<Outfit, string> = {
  base: "Routing",
  guardian: "Guardian",
  payments: "Payments",
  savings: "Savings",
  advisor: "Advisor",
  research: "Research",
};

export const OUTFIT_GLYPH: Record<Outfit, LucideIcon> = {
  base: Waypoints,
  guardian: Shield,
  payments: Send,
  savings: PiggyBank,
  advisor: BookOpen,
  research: Search,
};

export const OUTFIT_PROPS: Record<Outfit, string> = {
  base: "Waypoints glyph, slate ring",
  guardian: "Shield glyph, indigo ring",
  payments: "Send glyph, sky ring",
  savings: "PiggyBank glyph, green ring",
  advisor: "BookOpen glyph, gold ring",
  research: "Search glyph, violet ring",
};

export const SKILL_LABEL: Record<SkillName, string> = {
  bank: "Bank (Capital One Nessie)",
  imessage: "iMessage (Photon)",
  sec: "SEC filings",
  fdic: "FDIC bank registry",
  cfpb: "CFPB complaints",
  treasury: "Treasury rates",
  kb: "Knowledge base",
  db: "Findings database",
  scan: "ScamShield check",
  pause: "Pause all money movement",
};

const SKILL_GLYPH: Record<SkillName, LucideIcon> = {
  bank: Landmark,
  imessage: MessageCircle,
  sec: FileText,
  fdic: ShieldCheck,
  cfpb: Scale,
  treasury: Coins,
  kb: BookOpen,
  db: Database,
  scan: ScanSearch,
  pause: Pause,
};

const STATUS_WORD: Record<SpriteStatus, string> = { ok: "passed", warn: "needs attention", bad: "stopped" };
const STATUS_ICON = { ok: Check, warn: TriangleAlert, bad: X } as const;

function useSwap(outfit: Outfit) {
  const [s, setS] = useState({ cur: outfit, prev: null as Outfit | null, n: 0 });
  if (s.cur !== outfit) setS({ cur: outfit, prev: s.cur, n: s.n + 1 });
  useEffect(() => {
    if (!s.prev) return;
    const t = window.setTimeout(() => setS((x) => ({ ...x, prev: null })), 420);
    return () => window.clearTimeout(t);
  }, [s.n, s.prev]);
  return s;
}

export interface StewardProps {
  outfit?: Outfit;
  state?: SpriteState;
  size?: number;
  status?: SpriteStatus;
  label?: string;
  aura?: boolean;
  className?: string;
}

export function StewardMark({ outfit = "base", state = "idle", size, status, label, className = "" }: StewardProps) {
  const swap = useSwap(outfit);
  const Glyph = OUTFIT_GLYPH[outfit];
  const Prev = swap.prev ? OUTFIT_GLYPH[swap.prev] : null;
  const StatusIcon = status ? STATUS_ICON[status] : null;
  const spoken = label ?? `${BRAND}, ${OUTFIT_LABEL[outfit].toLowerCase()}`;
  const style = size ? ({ "--mk-size": `${size}px` } as CSSProperties) : undefined;
  return (
    <span className={`mk mk-${state} mk-o-${outfit}${status ? ` mk-s-${status}` : ""} ${className}`} style={style} role="img" aria-label={status ? `${spoken}, ${STATUS_WORD[status]}` : spoken} data-outfit={outfit}>
      <span className="mk-halo" aria-hidden />
      <svg className="mk-ring" viewBox="0 0 48 48" aria-hidden focusable="false">
        <circle cx="24" cy="24" r="22.5" pathLength={100} />
      </svg>
      <span key={swap.n} className={`mk-core${swap.n ? " mk-pop" : ""}`} aria-hidden>
        {Prev && <Prev className="mk-glyph mk-out" strokeWidth={1.75} />}
        <Glyph className={`mk-glyph${swap.n ? " mk-in" : ""}`} strokeWidth={1.75} />
      </span>
      {StatusIcon && (
        <span className="mk-dot" aria-hidden>
          <StatusIcon strokeWidth={3.5} />
        </span>
      )}
    </span>
  );
}

export function FinGuard(props: StewardProps) {
  return <StewardMark {...props} />;
}

export const Steward = FinGuard;

export function StewardGlyph({ outfit = "base", size = 14, className = "" }: { outfit?: Outfit; size?: number; className?: string }) {
  const Glyph = OUTFIT_GLYPH[outfit];
  return <Glyph className={`mk-inline ${className}`} size={size} strokeWidth={2} aria-hidden />;
}

export function Sprite({
  name,
  state = "idle",
  size,
  status,
  label,
  className = "",
}: {
  name: SpriteName;
  state?: SpriteState;
  size?: number;
  status?: SpriteStatus;
  label?: string;
  className?: string;
}) {
  const object = objectOf(name);
  const spoken = label ?? SPRITE_LABEL[name] ?? name;
  if (object) return <StageObjectIcon kind={object} state={state} status={status} size={size} label={status ? `${spoken}, ${STATUS_WORD[status]}` : spoken} className={className} />;
  return <StewardMark outfit={outfitOf(name)} state={state} size={size} status={status} label={label ?? `${BRAND}, ${spoken.toLowerCase()}`} className={className} />;
}

export function SkillIcon({ name, size = 16, title, className = "" }: { name: SkillName; size?: number; title?: string; className?: string }) {
  const Icon = SKILL_GLYPH[name];
  const label = title ?? SKILL_LABEL[name];
  return (
    <span className={`sk-icon ${className}`} style={{ "--sk-size": `${size}px` } as CSSProperties} role="img" aria-label={label} title={label}>
      <Icon aria-hidden strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  );
}

export function skillForTool(tool: string): SkillName {
  const t = tool.toLowerCase();
  if (t.startsWith("bank.") || t.startsWith("subscriptions.") || t.includes("nessie")) return "bank";
  if (t.includes("alert") || t.includes("imessage") || t.includes("photon") || t.includes("notify")) return "imessage";
  if (t.includes("check_message") || t.includes("scam")) return "scan";
  if (t.includes("pause")) return "pause";
  if (t.includes("knowledge") || t.startsWith("kb") || t.includes("rag")) return "kb";
  if (t.includes("sec") || t.includes("edgar") || t.includes("filing")) return "sec";
  if (t.includes("fdic") || t.includes("institution") || t.includes("bank_registry")) return "fdic";
  if (t.includes("cfpb") || t.includes("complaint")) return "cfpb";
  if (t.includes("treasury") || t.includes("rate") || t.includes("yield") || t.includes("fiscal")) return "treasury";
  return "db";
}
