import type { Area, AreaSummary, EvidenceOrigin, Finding } from "@contracts";
import {
  BookOpen,
  Calculator,
  FileText,
  HandCoins,
  Info,
  Landmark,
  MessageSquareWarning,
  OctagonX,
  PiggyBank,
  ReceiptText,
  Repeat,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  TriangleAlert,
  User,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export { AREA_TITLES } from "../../lib/normalize.ts";

export const AREA_ICON: Record<Area, LucideIcon> = {
  everyday: Wallet,
  bills: ReceiptText,
  subscriptions: Repeat,
  investments: TrendingUp,
  loans: HandCoins,
  contracts: ScrollText,
  protection: ShieldCheck,
};

export const TONE: Record<Finding["tone"], { cls: "ok" | "info" | "warn" | "bad"; label: string; icon: LucideIcon }> = {
  save: { cls: "ok", label: "Saving", icon: PiggyBank },
  info: { cls: "info", label: "Info", icon: Info },
  warn: { cls: "warn", label: "Heads-up", icon: TriangleAlert },
  block: { cls: "bad", label: "Stop", icon: OctagonX },
};

export const STATUS: Record<AreaSummary["status"], { cls: "ok" | "warn" | "bad"; label: string }> = {
  ok: { cls: "ok", label: "All good" },
  attention: { cls: "warn", label: "Review" },
  blocked: { cls: "bad", label: "Blocked" },
};

export const ORIGIN: Record<EvidenceOrigin, { label: string; icon: LucideIcon }> = {
  bank_record: { label: "Bank record", icon: Landmark },
  user: { label: "You said", icon: User },
  policy: { label: "Your settings", icon: SlidersHorizontal },
  calculation: { label: "Calculation", icon: Calculator },
  reference: { label: "Reference", icon: BookOpen },
  document: { label: "Document", icon: FileText },
  message: { label: "Forwarded message", icon: MessageSquareWarning },
};
