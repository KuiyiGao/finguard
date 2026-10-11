import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { serveWeb } from "./static.ts";

test("the built web app is served with client routes falling back to index.html", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "steward-dist-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
  fs.writeFileSync(path.join(dist, "assets", "a.js"), "console.log(1)");
  const server = http.createServer((req, res) => {
    if (!serveWeb(dist, new URL(req.url ?? "/", "http://x").pathname, res, req)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const page = await fetch(`${base}/console`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>app/);
    const asset = await fetch(`${base}/assets/a.js`);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
    const zipped = await fetch(`${base}/assets/a.js`, { headers: { "Accept-Encoding": "br" } });
    assert.equal(zipped.headers.get("content-encoding"), "br");
    assert.equal(await zipped.text(), "console.log(1)"); // fetch decodes it
    assert.equal((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status, 404); // never a file outside dist
  } finally {
    server.close();
  }
});
