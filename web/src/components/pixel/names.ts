
export type Outfit = "base" | "guardian" | "payments" | "savings" | "advisor" | "research";
export type SpriteName = "customer" | "orchestrator" | "guardian" | "payments" | "savings" | "advisor" | "research" | "evaluator" | "skillgate";
export type SkillName = "bank" | "imessage" | "sec" | "fdic" | "cfpb" | "treasury" | "kb" | "db" | "scan" | "pause";
export type SpriteState = "idle" | "working";
export type StageObject = "customer" | "skillgate" | "evaluator";

export const OUTFITS: Outfit[] = ["base", "guardian", "payments", "savings", "advisor", "research"];
export const SPRITE_NAMES: SpriteName[] = ["orchestrator", "guardian", "payments", "savings", "advisor", "research", "customer", "skillgate", "evaluator"];
export const SKILL_NAMES: SkillName[] = ["bank", "imessage", "sec", "fdic", "cfpb", "treasury", "kb", "db", "scan", "pause"];

const ROLE_OUTFIT: Record<string, Outfit> = {
  base: "base",
  orchestrator: "base",
  routing: "base",
  router: "base",
  guardian: "guardian",
  payments: "payments",
  savings: "savings",
  advisor: "advisor",
  research: "research",
  "research analyst": "research",
};

export function outfitOf(name: string | undefined): Outfit {
  return (name && ROLE_OUTFIT[name.toLowerCase()]) || "base";
}

export function objectOf(name: string | undefined): StageObject | null {
  return name === "customer" || name === "skillgate" || name === "evaluator" ? name : null;
}
