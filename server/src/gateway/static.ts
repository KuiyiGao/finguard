import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import zlib from "node:zlib";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);

const cache = new Map<string, { mtimeMs: number; br: Buffer; gzip: Buffer }>();

function compressed(file: string, mtimeMs: number) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const entry = {
    mtimeMs,
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
    gzip: zlib.gzipSync(raw, { level: 9 }),
  };
  cache.set(file, entry);
  return entry;
}

export function serveWeb(dist: string, pathname: string, res: ServerResponse, req?: IncomingMessage): boolean {
  const root = path.resolve(dist);
  const index = path.join(root, "index.html");
  if (!fs.existsSync(index)) return false;
  let file: string;
  try {
    file = path.resolve(root, "." + decodeURIComponent(pathname));
  } catch {
    return false;
  }
  const found = file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
  if (!found && path.extname(pathname)) return false;
  const target = found ? file : index;
  const ext = path.extname(target);
  const headers: Record<string, string> = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": target !== index && pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    Vary: "Accept-Encoding",
  };
  const accepts = String(req?.headers["accept-encoding"] ?? "");
  const encoding = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : null;
  if (!encoding) {
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
    return true;
  }
  const body = compressed(target, fs.statSync(target).mtimeMs)[encoding];
  res.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": String(body.length) });
  res.end(req?.method === "HEAD" ? undefined : body);
  return true;
}
