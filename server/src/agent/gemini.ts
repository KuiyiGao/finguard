import { performance } from "node:perf_hooks";
import type { Metrics } from "../metrics.ts";
import { LlmError, retryAfterMs, sleeper, type Conversation, type ModelStep, type Provider, type StartRequest, type ToolOutput } from "./llm.ts";

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

export function geminiShape(model: string): { maxTokens: number; minTokens: number; generation: Record<string, unknown> } {
  if (/^gemini-(3\.5-flash-lite|3\.6-flash|3-flash-preview)/.test(model)) return { maxTokens: 2048, minTokens: 512, generation: { thinkingConfig: { thinkingLevel: "MINIMAL" } } };
  if (/^gemini-3/.test(model)) return { maxTokens: 4096, minTokens: 2048, generation: { thinkingConfig: { thinkingLevel: "LOW" } } };
  if (/^gemini-2\.5-flash/.test(model)) return { maxTokens: 2048, minTokens: 512, generation: { thinkingConfig: { thinkingBudget: 0 } } };
  return { maxTokens: 2048, minTokens: 512, generation: {} };
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}
export interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  modelVersion?: string;
}

export interface GeminiCallOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  metrics?: Metrics;
  metricPrefix?: string;
  fallbackModel?: string;
}

export function redactKey(text: string, key: string | undefined): string {
  return key ? text.split(key).join("[redacted]") : text;
}

export function responseText(res: GeminiResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text!)
    .join("")
    .trim();
}

export async function generateContent(o: GeminiCallOptions, body: Record<string, unknown>): Promise<GeminiResponse> {
  const key = o.apiKey;
  if (!key) throw new LlmError("no_key", "GEMINI_API_KEY is not set.");
  const prefix = o.metricPrefix ?? "llm";
  const maxRetries = o.maxRetries ?? 2;
  const url = `${GEMINI_URL}/${encodeURIComponent(o.model)}:generateContent`;
  const headers = { "x-goog-api-key": key, "content-type": "application/json" };
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const done = (outcome: string) => {
      o.metrics?.observe(`${prefix}.request`, performance.now() - started);
      o.metrics?.inc(`${prefix}.request.${outcome}`);
    };
    let status: number;
    let retryAfter: string | null = null;
    let text: string;
    try {
      const res = await (o.fetch ?? globalThis.fetch)(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(o.timeoutMs) });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      text = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        done("timeout");
        throw new LlmError("timeout", `No answer from Gemini within ${o.timeoutMs} ms.`);
      }
      done("network");
      if (attempt < maxRetries) {
        await backoff(o, attempt, null, prefix);
        continue;
      }
      throw new LlmError("network", redactKey(`Network error: ${err instanceof Error ? err.message : String(err)}`, key));
    }
    done(String(status));
    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(text) as GeminiResponse;
      } catch {
        throw new LlmError("bad_response", "The Gemini API returned a body that is not JSON.");
      }
    }
    if (RETRYABLE.has(status) && attempt < maxRetries && (await backoff(o, attempt, retryAfter, prefix))) continue;
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } };
      detail = [parsed.error?.status, parsed.error?.message].filter(Boolean).join(": ");
    } catch {
      detail = text.slice(0, 200);
    }
    if (status === 429 && o.fallbackModel && o.fallbackModel !== o.model) {
      o.metrics?.inc(`${prefix}.fallback_model`);
      return generateContent({ ...o, model: o.fallbackModel, fallbackModel: undefined }, body);
    }
    throw new LlmError(`http_${status}`, redactKey(`Gemini API error ${status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, key));
  }
}

async function backoff(o: GeminiCallOptions, attempt: number, retryAfter: string | null, prefix: string): Promise<boolean> {
  const base = o.baseDelayMs ?? 500;
  const max = o.maxDelayMs ?? 8000;
  const exp = base * 2 ** attempt;
  const jittered = exp / 2 + (o.random ?? Math.random)() * (exp / 2);
  const asked = retryAfterMs(retryAfter);
  const wait = asked !== undefined ? Math.max(asked, 0) : Math.min(jittered, max);
  if (wait > max) return false;
  o.metrics?.inc(`${prefix}.retries`);
  await (o.sleep ?? sleeper)(wait);
  return true;
}

export type GeminiOptions = Omit<GeminiCallOptions, "metricPrefix">;

function responseObject(o: ToolOutput): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(o.content);
  } catch {
    value = o.content;
  }
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
  return o.isError && !("error" in obj) ? { error: obj } : obj;
}

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  constructor(private readonly o: GeminiOptions) {}

  get model(): string {
    return this.o.model;
  }

  configured(): boolean {
    return Boolean(this.o.apiKey);
  }

  redact(text: string): string {
    return redactKey(text, this.o.apiKey);
  }

  start(request: StartRequest): Conversation {
    const shape = geminiShape(this.o.model);
    const contents: GeminiContent[] = request.messages.filter((m) => m.text.trim()).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
    const declarations = request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema }));
    const names = new Map<string, string>();
    const fromModel = new Set<string>();
    let calls = 0;
    const body = () => ({
      systemInstruction: { parts: [{ text: request.system }] },
      contents,
      ...(declarations.length ? { tools: [{ functionDeclarations: declarations }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
      generationConfig: {
        maxOutputTokens: Math.max(request.maxTokens ?? shape.maxTokens, shape.minTokens),
        ...shape.generation,
        ...(request.json ? { responseMimeType: "application/json", responseJsonSchema: request.json } : {}),
      },
    });
    const step = async (): Promise<ModelStep> => {
      const res = await generateContent(this.o, body());
      const usage = res.usageMetadata ?? {};
      this.o.metrics?.inc("llm.tokens.input", usage.promptTokenCount ?? 0);
      this.o.metrics?.inc("llm.tokens.output", usage.candidatesTokenCount ?? 0);
      this.o.metrics?.inc("llm.tokens.thinking", usage.thoughtsTokenCount ?? 0);
      this.o.metrics?.inc("llm.tokens.cache_read", usage.cachedContentTokenCount ?? 0);
      const candidate = res.candidates?.[0];
      const blocked = res.promptFeedback?.blockReason;
      if (!candidate) throw blocked ? new LlmError(`refusal:${blocked.toLowerCase()}`, "Gemini blocked the request.") : new LlmError("empty_reply", "Gemini returned no candidate.");
      const finish = candidate.finishReason ?? "STOP";
      if (REFUSALS.has(finish)) throw new LlmError(`refusal:${finish.toLowerCase()}`, "The model declined the request.");
      if (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL") throw new LlmError(finish.toLowerCase(), `Gemini stopped with ${finish}.`);
      const parts = candidate.content?.parts ?? [];
      if (parts.length) contents.push({ role: "model", parts }); // unchanged, thought signatures included
      const toolUses = parts
        .filter((p) => typeof p.functionCall?.name === "string")
        .map((p) => {
          const call = p.functionCall!;
          const given = typeof call.id === "string" && call.id ? call.id : undefined;
          const id = given ?? `gemini_call_${++calls}`;
          names.set(id, call.name!);
          if (given) fromModel.add(id);
          return { id, name: call.name!, input: call.args ?? {} };
        });
      return { text: responseText(res), toolUses, stop: toolUses.length ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
    };
    return {
      next: async (outputs) => {
        if (outputs?.length)
          contents.push({
            role: "user",
            parts: outputs.map((o) => ({ functionResponse: { name: names.get(o.id) ?? "unknown_tool", ...(fromModel.has(o.id) ? { id: o.id } : {}), response: responseObject(o) } })),
          });
        return step();
      },
      say: async (text) => {
        contents.push({ role: "user", parts: [{ text }] });
        return step();
      },
    };
  }
}
