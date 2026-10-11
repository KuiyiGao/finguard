import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { directorSteps, type Call, type Json, type Line } from "../src/demo/director.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const DEMO_PORT = Number(arg("port") ?? 8788);
const BASE = (arg("base") ?? `http://localhost:${DEMO_PORT}`).replace(/\/+$/, "");
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FROM = Number(arg("from") ?? 1);
const AUTO = arg("auto") ? Number(arg("auto")) * 1000 : 0;
const NOTES = process.argv.includes("--notes");
const PHONE = arg("phone");

const c = { dim: "\x1b[2m", bold: "\x1b[1m", teal: "\x1b[36m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", off: "\x1b[0m" };
const TONE: Record<string, string> = { ok: c.green, warn: c.amber, bad: c.red, dim: c.dim };

const call: Call = async (role, method, urlPath, body) => {
  const res = await fetch(BASE + urlPath, { method, headers: { "X-Demo-Role": role, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Json;
  if (res.status >= 400) throw new Error(`${method} ${urlPath}: ${res.status} ${data.error ?? ""}`);
  return data;
};
const print = (lines: Line[]) => {
  for (const l of lines) console.log(`  ${TONE[l.tone ?? ""] ?? c.teal}${l.label}${c.off} ${l.text}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const next = async (prompt: string) => (AUTO ? sleep(AUTO) : rl.question(`${c.dim}  ${prompt} ›${c.off} `).then(() => undefined));
const up = () => fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

let server: ChildProcess | undefined;
if (!(await up())) {
  if (arg("base")) throw new Error(`No FinGuard server at ${BASE}.`);
  const dataDir = path.join(SERVER_ROOT, "data-demo");
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, "server.log"), "a");
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(DEMO_PORT), DATA_DIR: dataDir, FINGUARD_INSTANCE: "demo", ...(PHONE ? { IMESSAGE_DEMO_PHONE: PHONE } : {}) },
    stdio: ["ignore", log, log],
  });
  process.on("exit", () => server?.kill());
  process.on("SIGINT", () => process.exit(0));
  process.stdout.write(`${c.dim}Starting the demo server on port ${DEMO_PORT}${c.off}`);
  for (let i = 0; i < 90 && !(await up()); i++) {
    await sleep(1000);
    process.stdout.write(".");
  }
  console.log("");
  if (!(await up())) throw new Error(`The demo server did not start; see ${path.join(dataDir, "server.log")}.`);
  await sleep(4000);
}

const steps = directorSteps();
const clean = async (label: string) => {
  await call("operator", "POST", "/api/director/restart");
  print([{ label, text: "fresh audit chain, consent recorded, alerts cleared", tone: "ok" }]);
};
const health = await call("customer", "GET", "/api/health");
console.log(`\n${c.bold}FinGuard demo${c.off} ${c.dim}${BASE}, ${steps.length} steps. The Next button on ${BASE}/ runs the same steps.${c.off}`);
console.log(`  Desktop ${BASE}/   Phone ${health.phoneUrl ?? `${BASE}/app`}\n`);
for (let round = 1; ; round++) {
  if (round > 1 || FROM === 1) await clean("Ready");
  const memo: Json = {};
  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    if (round === 1 && n < FROM) continue;
    console.log(`${c.bold}${c.teal}${n}. ${step.title}${c.off}`);
    if (NOTES) console.log(`  ${c.amber}Say${c.off} ${step.say}\n  ${c.dim}${step.show}${c.off}`);
    await next("Enter to run");
    try {
      print(await step.run(call, memo));
    } catch (err) {
      print([{ label: "Problem", text: err instanceof Error ? err.message : String(err), tone: "bad" }]);
    }
    console.log("");
  }
  await next("Enter to clean up for the next round");
  await clean("Cleaned");
  if (AUTO) break;
  const again = await rl.question(`${c.dim}  Enter for another round, or type q to quit ›${c.off} `);
  if (again.trim().toLowerCase().startsWith("q")) break;
}
console.log(`${c.green}Done.${c.off}${server ? " The demo server stops now." : ""}\n`);
rl.close();
server?.kill();
process.exit(0);
