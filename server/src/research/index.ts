import type { ExtensionLookup } from "../policy/gate.ts";
import type { SkillManifest, SkillRecord } from "../types.ts";
import { canonicalJson, sha256 } from "../util.ts";
import { RESEARCH_HOSTS, RESEARCH_TOOLS } from "./tools.ts";

export { createResearchAdapters, moneyText, RESEARCH_HOSTS, RESEARCH_TOOL_NAMES, RESEARCH_TOOLS, SAMPLE_LABEL, type ResearchOptions } from "./tools.ts";

export const RESEARCH_SKILL = "research";

export const RESEARCH_MANIFEST: Readonly<SkillManifest> = Object.freeze({
  name: RESEARCH_SKILL,
  description:
    "Public-data research: SEC filings and reported financials, Treasury average interest rates, the FDIC bank registry and CFPB complaint counts. It reads public data only: it cannot see your accounts, move money or change anything.",
  publisher: "FinGuard (first-party skill pack)",
  capabilities: Object.freeze([Object.freeze({ capability: "research.read", approval: "never" })]) as SkillManifest["capabilities"],
});

export function researchPack(o: { secLive: boolean }) {
  return {
    manifest: RESEARCH_MANIFEST,
    sha256: manifestHash(),
    hosts: [...new Set(Object.values(RESEARCH_HOSTS).flat())],
    summary: "This skill may only read public data.",
    effects: ["read"],
    moneyFields: [],
    tools: Object.values(RESEARCH_TOOLS).map((t) => ({
      name: t.name,
      description: t.description,
      effect: t.effect,
      capability: t.capability,
      inputSchema: t.inputSchema,
      hosts: t.name.startsWith("research.sec_") ? RESEARCH_HOSTS.sec : t.name === "research.treasury_rates" ? RESEARCH_HOSTS.treasury : t.name === "research.fdic_bank" ? RESEARCH_HOSTS.fdic : RESEARCH_HOSTS.cfpb,
      mode: t.name.startsWith("research.sec_") ? (o.secLive ? "live" : "cached sample (set SEC_USER_AGENT for live SEC data)") : "live",
    })),
  };
}

function manifestHash(): string {
  return sha256(canonicalJson(RESEARCH_MANIFEST));
}

const PINNED = manifestHash();

export function researchExtensions(base?: ExtensionLookup): ExtensionLookup {
  const record: SkillRecord = { manifest: RESEARCH_MANIFEST as SkillManifest, sha256: PINNED, status: "approved", approvedAt: new Date().toISOString() };
  return {
    record: (name) => (name === RESEARCH_SKILL ? record : base?.record(name)),
    currentHash: (name) => (name === RESEARCH_SKILL ? manifestHash() : base?.currentHash(name)),
  };
}
