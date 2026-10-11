import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Row = { api: string; purpose: string; status: "ok" | "fail" | "missing"; ms?: number; detail: string; needs?: string };

const env = process.env;
const TIMEOUT = 12000;

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; ms: number; body: unknown }> {
  const started = performance.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), redirect: "follow" });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
  }
  return { status: res.status, ms: Math.round(performance.now() - started), body };
}

function scrub(text: string): string {
  let out = text;
  for (const [k, v] of Object.entries(env)) if (v && v.length > 8 && /KEY|SECRET|TOKEN/.test(k)) out = out.split(v).join("[redacted]");
  return out.slice(0, 140);
}

async function check(api: string, purpose: string, needs: string[], run: () => Promise<{ ok: boolean; ms: number; detail: string }>): Promise<Row> {
  const absent = needs.filter((k) => !env[k]);
  if (absent.length) return { api, purpose, status: "missing", detail: `set ${absent.join(", ")}`, needs: absent.join(", ") };
  try {
    const r = await run();
    return { api, purpose, status: r.ok ? "ok" : "fail", ms: r.ms, detail: scrub(r.detail) };
  } catch (e) {
    return { api, purpose, status: "fail", detail: scrub(e instanceof Error ? `${e.name}: ${e.message}` : String(e)) };
  }
}

const checks: Promise<Row>[] = [
  check("Capital One Nessie", "live bank accounts, bills, purchases", ["NESSIE_API_KEY"], async () => {
    const r = await call(`https://prod-api.nessieisreal.com/accounts?key=${encodeURIComponent(env.NESSIE_API_KEY!)}`);
    return { ok: r.status === 200, ms: r.ms, detail: r.status === 200 && Array.isArray(r.body) ? `${r.body.length} accounts visible to this key` : `HTTP ${r.status}` };
  }),
  check("Claude (Anthropic)", "agent brain (AGENT_MODE=claude)", ["ANTHROPIC_API_KEY"], async () => {
    const r = await call("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with the word ready." }] }),
    });
    const text = (r.body as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";
    return { ok: r.status === 200, ms: r.ms, detail: r.status === 200 ? `model replied "${text.trim()}"` : `HTTP ${r.status}` };
  }),
  check("Gemini", "Gemini brain and embeddings (MLH prize)", ["GEMINI_API_KEY"], async () => {
    const r = await call("https://generativelanguage.googleapis.com/v1beta/models?pageSize=50", { headers: { "x-goog-api-key": env.GEMINI_API_KEY! } });
    const models = ((r.body as { models?: { name: string }[] })?.models ?? []).map((m) => m.name.replace("models/", ""));
    return { ok: r.status === 200, ms: r.ms, detail: r.status === 200 ? `${models.length} models, e.g. ${models.filter((m) => /flash|embedding/.test(m)).slice(0, 3).join(", ")}` : `HTTP ${r.status}` };
  }),
  check("Photon Spectrum", "iMessage approvals and alerts", ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET"], async () => ({
    ok: true,
    ms: 0,
    detail: "credentials present; run the Photon connectivity check for a live send",
  })),
  check("Alpaca (paper)", "paper trading account for guarded orders", ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"], async () => {
    const r = await call("https://paper-api.alpaca.markets/v2/account", { headers: { "APCA-API-KEY-ID": env.APCA_API_KEY_ID!, "APCA-API-SECRET-KEY": env.APCA_API_SECRET_KEY! } });
    const b = r.body as { status?: string; buying_power?: string };
    return { ok: r.status === 200, ms: r.ms, detail: r.status === 200 ? `paper account ${b.status}, buying power $${b.buying_power}` : `HTTP ${r.status}` };
  }),
  check("Google Safe Browsing", "link reputation in forwarded messages", ["GOOGLE_SAFE_BROWSING_KEY"], async () => {
    const r = await call(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(env.GOOGLE_SAFE_BROWSING_KEY!)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "steward-hacknc", clientVersion: "0.1" },
        threatInfo: { threatTypes: ["MALWARE", "SOCIAL_ENGINEERING"], platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"], threatEntries: [{ url: "http://malware.testing.google.test/testing/malware/" }] },
      }),
    });
    const matches = (r.body as { matches?: unknown[] })?.matches?.length ?? 0;
    return { ok: r.status === 200 && matches > 0, ms: r.ms, detail: r.status === 200 ? `Google's test URL flagged: ${matches > 0}` : `HTTP ${r.status}` };
  }),
  check("SEC EDGAR", "company filings and XBRL facts for research", ["SEC_USER_AGENT"], async () => {
    const r = await call("https://data.sec.gov/submissions/CIK0000320193.json", { headers: { "User-Agent": env.SEC_USER_AGENT! } });
    const b = r.body as { name?: string; filings?: { recent?: { form?: string[] } } };
    return { ok: r.status === 200, ms: r.ms, detail: r.status === 200 ? `${b.name}: ${b.filings?.recent?.form?.length ?? 0} recent filings` : `HTTP ${r.status} (SEC needs a User-Agent with a real contact email)` };
  }),
  check("FDIC BankFind", "is a bank real and insured (scam checks)", [], async () => {
    const r = await call("https://api.fdic.gov/banks/institutions?search=NAME%3A%22Capital%20One%22&fields=NAME,CERT,ACTIVE&limit=3");
    const rows = ((r.body as { data?: { data: { NAME: string; ACTIVE: number } }[] })?.data ?? []).map((d) => `${d.data.NAME}${d.data.ACTIVE ? "" : " (inactive)"}`);
    return { ok: r.status === 200 && rows.length > 0, ms: r.ms, detail: r.status === 200 ? rows.join("; ") : `HTTP ${r.status}` };
  }),
  check("CFPB complaints", "real complaint counts by product and issue", [], async () => {
    const r = await call("https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/?search_term=gift%20card&size=1&no_aggs=true");
    const total = (r.body as { hits?: { total?: { value?: number } } })?.hits?.total?.value;
    return { ok: r.status === 200, ms: r.ms, detail: r.status === 200 ? `${total} complaints mention "gift card"` : `HTTP ${r.status}` };
  }),
  check("Treasury FiscalData", "current Treasury rates for savings and loan comparisons", [], async () => {
    const r = await call("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/avg_interest_rates?sort=-record_date&page%5Bsize%5D=1&filter=security_desc:eq:Treasury%20Bills");
    const d = (r.body as { data?: { record_date: string; avg_interest_rate_amt: string }[] })?.data?.[0];
    return { ok: r.status === 200 && Boolean(d), ms: r.ms, detail: d ? `Treasury bills averaged ${d.avg_interest_rate_amt}% (${d.record_date})` : `HTTP ${r.status}` };
  }),
];

const rows = await Promise.all(checks);
const width = Math.max(...rows.map((r) => r.api.length));
for (const r of rows) {
  const mark = r.status === "ok" ? "ok     " : r.status === "missing" ? "missing" : "FAIL   ";
  console.log(`${mark}  ${r.api.padEnd(width)}  ${r.ms !== undefined ? `${String(r.ms).padStart(5)} ms` : "        "}  ${r.detail}`);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "eval", "live-check.json"), JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2) + "\n");
console.log(`\n${rows.filter((r) => r.status === "ok").length} ok, ${rows.filter((r) => r.status === "fail").length} failing, ${rows.filter((r) => r.status === "missing").length} waiting for a key. Wrote eval/live-check.json`);
