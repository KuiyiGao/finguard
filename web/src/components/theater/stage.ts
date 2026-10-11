import type { Turn } from "../../lib/turns.ts";
import type { GateState, SealState } from "../pixel/objects.tsx";
import { outfitOf, type Outfit, type SkillName } from "../pixel/names.ts";
import type { ParticleMode, ParticleTone } from "../particles/engine.ts";
import type { TheaterStep } from "./steps.ts";

export type Spot = "req" | "steward" | "gate" | "src" | "seal";
export type RequestKind = "phone" | "inbound" | "doc" | "review";

export interface Fx {
  mode: ParticleMode;
  tone: ParticleTone;
  from?: Spot;
  to?: Spot;
}

export interface Beat {
  outfit: Outfit;
  focus: Spot;
  fx: Fx;
  gate: GateState;
  seal: SealState;
  req: "idle" | "working" | "sent";
  source?: SkillName;
}

const SPECIALIST = new Set(["guardian", "payments", "savings", "advisor", "research"]);

export function beatsOf(steps: TheaterStep[]): Beat[] {
  let outfit: Outfit = "base";
  let gate: GateState = "open";
  let seal: SealState = "idle";
  let source: SkillName | undefined;
  return steps.map((s, i) => {
    if (s.actor === "orchestrator") outfit = s.action === "route" ? outfitOf(s.specialist) : "base";
    else if (SPECIALIST.has(s.actor)) outfit = outfitOf(s.actor);
    if (s.action === "call" || s.action === "execute" || s.action === "alert" || s.action === "report") source = s.service ?? s.skill ?? source;
    let focus: Spot = "steward";
    let req: Beat["req"] = "idle";
    let fx: Fx = { mode: "idle", tone: "neutral", to: "steward" };
    switch (s.action) {
      case "start":
        if (s.lane === "customer") {
          focus = "req";
          req = "working";
          fx = { mode: "gather", tone: "trusted", from: "req", to: "steward" };
        }
        break;
      case "ask":
        focus = "req";
        req = "sent";
        fx = { mode: "gather", tone: "trusted", from: "req", to: "steward" };
        break;
      case "forward":
        focus = "req";
        req = "sent";
        fx = s.actor === "guardian" ? { mode: "gather", tone: "untrusted", from: "req", to: "steward" } : { mode: "stop", tone: "untrusted", from: "req", to: "steward" };
        break;
      case "route":
        fx = { mode: "burst", tone: "neutral", to: "steward" };
        break;
      case "scope":
        fx = { mode: "idle", tone: "trusted", to: "steward" };
        break;
      case "reject":
        focus = "gate";
        gate = "locked";
        fx = { mode: "stop", tone: "bad", from: "steward", to: "gate" };
        break;
      case "fallback":
        fx = { mode: "idle", tone: "warn", to: "steward" };
        break;
      case "inspect":
        focus = "req";
        fx = { mode: "scan", tone: "untrusted", from: "req" };
        break;
      case "call":
        gate = "checking";
        fx = { mode: "stream", tone: steps[i + 1]?.parcel ? "untrusted" : "trusted", from: "steward", to: "gate" };
        break;
      case "check":
        focus = "gate";
        if (s.verdict === "allow") {
          gate = "allow";
          fx = { mode: "pass", tone: "ok", from: "steward", to: "gate" };
        } else if (s.verdict === "ask") {
          gate = "ask";
          fx = { mode: "idle", tone: "warn", to: "gate" };
        } else if (s.verdict === "deny") {
          gate = "locked";
          fx = { mode: "stop", tone: s.parcel ? "untrusted" : "bad", from: "steward", to: "gate" };
        } else {
          gate = "checking";
          fx = { mode: "stream", tone: "neutral", from: "steward", to: "gate" };
        }
        break;
      case "approve":
        focus = "req";
        if (s.verdict === "allow") {
          gate = "allow";
          fx = { mode: "stream", tone: "ok", from: "req", to: "gate" };
        } else if (s.verdict === "deny") {
          gate = "locked";
          fx = { mode: "stop", tone: "bad", from: "req", to: "gate" };
        } else {
          gate = "ask";
          req = "working";
          fx = { mode: "idle", tone: "warn", to: "req" };
        }
        break;
      case "execute":
        focus = "src";
        fx = s.ok === false ? { mode: "stop", tone: "bad", from: "gate", to: "src" } : s.receiptId ? { mode: "burst", tone: "ok", to: "src" } : { mode: "gather", tone: "trusted", from: "src", to: "steward" };
        break;
      case "alert":
        focus = "src";
        fx = { mode: "stream", tone: "trusted", from: "steward", to: "src" };
        break;
      case "report":
        focus = "src";
        fx = { mode: "gather", tone: "trusted", from: "src", to: "steward" };
        break;
      case "nudge":
        focus = "req";
        req = "working";
        fx = { mode: "stream", tone: "neutral", from: "steward", to: "req" };
        break;
      case "reuse":
        focus = "gate";
        gate = s.verdict === "deny" ? "locked" : "allow";
        fx = s.verdict === "deny" ? { mode: "stop", tone: "bad", from: "req", to: "gate" } : { mode: "pass", tone: "ok", from: "req", to: "gate" };
        break;
      case "evaluate":
        focus = "seal";
        seal = s.ok === false ? "fail" : "pass";
        fx = s.ok === false ? { mode: "stop", tone: "warn", from: "steward", to: "seal" } : { mode: "burst", tone: "ok", to: "seal" };
        break;
      case "repair":
        focus = "seal";
        seal = "repair";
        fx = { mode: "idle", tone: "warn", to: "seal" };
        break;
      case "reply":
        focus = "req";
        req = "sent";
        fx = { mode: "stream", tone: "ok", from: "seal", to: "req" };
        break;
    }
    return { outfit, focus, fx, gate, seal, req, source };
  });
}

export function requestOf(turn: Turn, steps: TheaterStep[]): { kind: RequestKind; label: string } {
  const k = turn.start?.kind;
  if (k === "inbound" || steps.some((s) => s.action === "forward" || s.action === "inspect")) return { kind: "inbound", label: "Forwarded" };
  if (k === "document") return { kind: "doc", label: "Document" };
  if (k === "research") return { kind: "doc", label: "Request" };
  if (k === "review") return { kind: "review", label: "Review" };
  return { kind: "phone", label: "You" };
}

export function sourcesOf(steps: TheaterStep[]): SkillName[] {
  const out: SkillName[] = [];
  for (const s of steps) {
    if (s.action !== "call" && s.action !== "execute" && s.action !== "alert" && s.action !== "report") continue;
    const k = s.service ?? s.skill;
    if (k && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 4);
}

export const SOURCE_SHORT: Record<SkillName, string> = {
  bank: "Bank",
  imessage: "iMessage",
  sec: "SEC",
  fdic: "FDIC",
  cfpb: "CFPB",
  treasury: "Treasury",
  kb: "Knowledge",
  db: "Records",
  scan: "ScamShield",
  pause: "Pause",
};

export function outfitsOf(beats: Beat[]): Outfit[] {
  const out: Outfit[] = [];
  for (const b of beats) if (!out.includes(b.outfit)) out.push(b.outfit);
  return out;
}
