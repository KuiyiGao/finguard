import type { IncomingMessage, ServerResponse } from "node:http";

export type Role = "customer" | "operator";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  role: Role;
}

export interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  roles: Role[];
  handle: (ctx: Ctx) => unknown;
}

export function route(method: string, path: string, roles: Role[], handle: Route["handle"]): Route {
  const pattern = new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
  return { method, path, pattern, roles, handle };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

const MAX_BODY = 64 * 1024;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body is larger than 64 KB.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
  }
  throw new HttpError(400, "Request body must be a JSON object.");
}

export function roleOf(req: IncomingMessage, url: URL): Role {
  const raw = (req.headers["x-demo-role"] as string | undefined) ?? url.searchParams.get("role") ?? "customer";
  if (raw === "customer" || raw === "operator") return raw;
  throw new HttpError(400, "X-Demo-Role must be customer or operator.");
}
