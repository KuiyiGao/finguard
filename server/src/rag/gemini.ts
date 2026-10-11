import { performance } from "node:perf_hooks";
import type { Metrics } from "../metrics.ts";
import { normalize, type RemoteEmbedder } from "./hybrid.ts";

export const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiEmbedderOptions {
  apiKey: string;
  model?: string;
  dims?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  metrics?: Metrics;
}

export class GeminiEmbedder implements RemoteEmbedder {
  readonly model: string;
  private readonly dims: number;

  constructor(private readonly o: GeminiEmbedderOptions) {
    this.dims = o.dims ?? 768;
    this.model = `${o.model ?? "gemini-embedding-2"}@${this.dims}`;
  }

  private format(text: string, kind: "document" | "query"): string {
    if (kind === "query") return `task: search result | query: ${text}`;
    const [title, ...rest] = text.split("\n");
    return `title: ${title} | text: ${rest.join("\n").trim()}`;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]> {
    const name = this.model.split("@")[0]!;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100);
      const started = performance.now();
      try {
        const res = await (this.o.fetch ?? globalThis.fetch)(`${GEMINI_EMBED_URL}/${name}:batchEmbedContents`, {
          method: "POST",
          headers: { "x-goog-api-key": this.o.apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            requests: batch.map((t) => ({ model: `models/${name}`, content: { parts: [{ text: this.format(t, kind) }] }, outputDimensionality: this.dims })),
          }),
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000),
        });
        if (!res.ok) throw new Error(`Gemini embeddings HTTP ${res.status}`);
        const body = (await res.json()) as { embeddings?: { values?: number[] }[] };
        const vectors = (body.embeddings ?? []).map((e) => normalize(Float32Array.from(e.values ?? [])));
        if (vectors.length !== batch.length || vectors.some((v) => v.length === 0)) throw new Error("Gemini embeddings: unexpected response shape");
        out.push(...vectors);
      } finally {
        this.o.metrics?.observe("rag.embed.remote", performance.now() - started);
      }
    }
    return out;
  }
}
