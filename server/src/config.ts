import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  port: number;
  dataDir: string;
  policyFile: string;
  skillsDir: string;
  nessieMode: "live" | "mock";
  webDist: string;
  nessieBaseUrl: string;
  ragMode: "live" | "mock";
  agentMode: "replay" | "claude" | "gemini"; // claude/gemini: model brain when its key is set, rules otherwise
  geminiModel: string;
  scamLlm: "gemini" | "off"; // Gemini second opinion on ScamShield message checks; default gemini when GEMINI_API_KEY is set
  scamLlmModel: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmServerFallback: boolean;
  secret: (name: SecretName) => string | undefined;
  gateLlm: boolean;
  spectrumProvider: "imessage" | "terminal" | "off";
  approvalTtlSeconds: number;
  autopilotMinutes: number;
}

export type SecretName = "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "SEC_USER_AGENT"; // SEC_USER_AGENT holds a contact email: kept out of serialized config like a key

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    dataDir: env.DATA_DIR ?? path.join(SERVER_ROOT, "data"),
    policyFile: env.POLICY_FILE ?? path.join(SERVER_ROOT, "policy", "default.json"),
    skillsDir: env.SKILLS_DIR ?? path.join(SERVER_ROOT, "skills"),
    nessieMode: pick(env.NESSIE_MODE, ["live", "mock"] as const, "mock"),
    webDist: env.WEB_DIST ?? path.join(SERVER_ROOT, "..", "web", "dist"),
    nessieBaseUrl: env.NESSIE_BASE_URL ?? "https://prod-api.nessieisreal.com",
    ragMode: pick(env.RAG_MODE, ["live", "mock"] as const, "mock"),
    agentMode: pick(env.AGENT_MODE, ["replay", "claude", "gemini"] as const, "replay"),
    geminiModel: env.GEMINI_MODEL || "gemini-3.5-flash-lite", // 2.5 models serve only earlier users since Sep 2026
    scamLlm: pick(env.SCAM_LLM, ["gemini", "off"] as const, env.GEMINI_API_KEY ? "gemini" : "off"),
    scamLlmModel: env.SCAM_LLM_MODEL || "gemini-3.5-flash-lite", // about 1 s; the check has a 4 s timeout
    llmModel: env.LLM_MODEL || "claude-sonnet-5-5",
    llmTimeoutMs: positive(env.LLM_TIMEOUT_MS, 20000),
    llmServerFallback: env.LLM_SERVER_FALLBACK !== "off",
    secret: (name) => env[name] || undefined,
    gateLlm: env.GATE_LLM === "on",
    spectrumProvider: pick(env.SPECTRUM_PROVIDER, ["imessage", "terminal", "off"] as const, "off"),
    approvalTtlSeconds: Number(env.APPROVAL_TTL_SECONDS ?? 120),
    autopilotMinutes: Math.max(0, Number(env.AUTOPILOT_MINUTES ?? 0) || 0),
  };
}
