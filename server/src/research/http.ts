
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_BYTES = 30 * 1024 * 1024;

export class ResearchError extends Error {}

export interface PublicDataOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  body: unknown;
}

export class PublicDataClient {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    readonly sourceName: string,
    readonly hosts: readonly string[],
    private readonly o: PublicDataOptions = {},
  ) {}

  assertAllowed(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ResearchError(`${this.sourceName}: "${url.slice(0, 80)}" is not a valid URL.`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !this.hosts.includes(parsed.hostname))
      throw new ResearchError(`${this.sourceName}: host ${parsed.host || "(none)"} is not on this tool's allowlist (${this.hosts.join(", ")}), so nothing was requested.`);
    return parsed;
  }

  async getJson(url: string, headers: Record<string, string> = {}): Promise<{ body: unknown; cached: boolean }> {
    const target = this.assertAllowed(url).toString();
    const now = (this.o.now ?? Date.now)();
    const hit = this.cache.get(target);
    if (hit && now - hit.at < (this.o.ttlMs ?? DEFAULT_TTL_MS)) return { body: hit.body, cached: true };

    const timeoutMs = this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ResearchError(`${this.sourceName} did not answer within ${Math.round(timeoutMs / 100) / 10} s.`));
      }, timeoutMs);
    });
    try {
      const request = (async () => {
        let res: Response;
        try {
          res = await (this.o.fetch ?? globalThis.fetch)(target, { headers: { Accept: "application/json", ...headers }, signal: controller.signal, redirect: "error" });
        } catch (err) {
          if (controller.signal.aborted) throw new ResearchError(`${this.sourceName} did not answer within ${Math.round(timeoutMs / 100) / 10} s.`);
          throw new ResearchError(`${this.sourceName} could not be reached (${err instanceof Error ? err.message : String(err)}).`);
        }
        if (res.status === 403 && /sec\.gov$/.test(new URL(target).hostname))
          throw new ResearchError(`${this.sourceName} refused the request (HTTP 403). SEC requires a User-Agent with a real contact email: set SEC_USER_AGENT.`);
        if (res.status === 429) throw new ResearchError(`${this.sourceName} is rate limiting requests (HTTP 429); try again in a minute.`);
        if (res.status < 200 || res.status >= 300) throw new ResearchError(`${this.sourceName} returned HTTP ${res.status}.`);
        const length = Number(res.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) throw new ResearchError(`${this.sourceName} sent a response larger than ${MAX_BYTES / 1024 / 1024} MB.`);
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new ResearchError(`${this.sourceName} sent a response larger than ${MAX_BYTES / 1024 / 1024} MB.`);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ResearchError(`${this.sourceName} returned something that is not JSON.`);
        }
      })();
      const body = await Promise.race([request, timedOut]);
      this.cache.set(target, { at: now, body });
      return { body, cached: false };
    } finally {
      clearTimeout(timer);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
