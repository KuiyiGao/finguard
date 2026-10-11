import "../src/env.ts";
import { personaSetup } from "../src/demo/personas.ts";
import { NESSIE_MERCHANT_IDS, SEED_CUSTOMER, seedCustomers } from "../src/bank/aliases.ts";

const BASE = process.env.NESSIE_BASE_URL ?? "https://prod-api.nessieisreal.com";
const KEY = process.env.NESSIE_API_KEY;
const reset = process.argv.includes("--reset");
type Row = Record<string, unknown>;

async function nessie(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = new URL(path, BASE);
  url.searchParams.set("key", KEY!);
  const res = await fetch(url, {
    method, redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.split(KEY!).join("[key]").slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const created = (r: unknown) => ((r as Row)?.objectCreated ?? r) as Row;
const list = async (path: string) => {
  const r = await nessie("GET", path);
  return Array.isArray(r) ? (r as Row[]) : [];
};

if (!KEY) {
  console.error("NESSIE_API_KEY is not set (release/.env or the shell).");
  process.exit(1);
}

const { household } = personaSetup("maya", new Date());
const customers = await list("/customers");
let customer = seedCustomers(customers)[0];
if (!customer) {
  customer = created(await nessie("POST", "/customers", {
    ...SEED_CUSTOMER, address: { street_number: "1", street_name: "Demo Street", city: "Chapel Hill", state: "NC", zip: "27514" },
  }));
  console.log(`customer created: ${customer._id}`);
} else console.log(`customer found: ${customer._id}`);

let accounts = await list(`/customers/${customer._id}/accounts`);
if (reset) {
  for (const a of accounts) await nessie("DELETE", `/accounts/${a._id}`);
  if (accounts.length) console.log(`reset: deleted ${accounts.length} account(s) and their records`);
  accounts = [];
}

const merchantUuid = new Map<string, string>();
const byName = new Map(Object.entries(NESSIE_MERCHANT_IDS));
for (const a of accounts) for (const p of await list(`/accounts/${a._id}/purchases`)) {
  const id = String(p.merchant_id ?? "");
  if (!id || [...merchantUuid.values()].includes(id)) continue;
  const m = (await nessie("GET", `/merchants/${id}`).catch(() => null)) as Row | null;
  const demoId = m && byName.get(String(m.name));
  if (demoId) merchantUuid.set(demoId, id);
}
for (const m of household.merchants) {
  if (merchantUuid.has(m._id)) continue;
  const r = created(await nessie("POST", "/merchants", {
    name: m.name, category: m.category[0] ?? "Other", // prod-api takes one category string
    address: { street_number: "1", street_name: "Demo Street", city: "Chapel Hill", state: "NC", zip: "27514" },
    geocode: { lat: 35.9132, lng: -79.0558 },
  }));
  merchantUuid.set(m._id, String(r._id));
}
console.log(`merchants ready: ${[...merchantUuid.keys()].join(", ")}`);

const accountUuid = new Map<string, string>();
for (const a of household.accounts) {
  const existing = accounts.find((x) => x.type === a.type);
  if (existing) {
    accountUuid.set(a._id, String(existing._id));
    continue;
  }
  const r = created(await nessie("POST", `/customers/${customer._id}/accounts`, {
    type: a.type, nickname: a.nickname, rewards: 0, balance: a.balance,
  }));
  accountUuid.set(a._id, String(r._id));
  console.log(`account created: ${a.type} "${a.nickname}" $${a.balance}`);
}

for (const b of household.bills) {
  const account = accountUuid.get(b.account_id)!;
  const bills = await list(`/accounts/${account}/bills`);
  if (bills.some((x) => x.nickname === b._id)) continue;
  await nessie("POST", `/accounts/${account}/bills`, {
    status: "pending", payee: b.payee, nickname: b._id, payment_date: b.payment_date,
    recurring_date: Number(b.payment_date.slice(8, 10)), payment_amount: b.payment_amount,
  });
  console.log(`bill created: ${b._id} ${b.payee} $${b.payment_amount} due ${b.payment_date}`);
}
const checking = accountUuid.get("acct-checking")!;
if ((await list(`/accounts/${checking}/purchases`)).length === 0) {
  let n = 0;
  for (const p of household.purchases) {
    await nessie("POST", `/accounts/${accountUuid.get(p.payer_id) ?? checking}/purchases`, {
      merchant_id: merchantUuid.get(p.merchant_id), medium: "balance", purchase_date: p.purchase_date,
      amount: p.amount, status: "completed", description: p.description,
    });
    n++;
  }
  console.log(`purchases created: ${n}`);
}

for (const [demo, uuid] of accountUuid) {
  const a = (await nessie("GET", `/accounts/${uuid}`)) as Row;
  const bills = await list(`/accounts/${uuid}/bills`);
  const purchases = await list(`/accounts/${uuid}/purchases`);
  console.log(`${demo}: ${a.type} "${a.nickname}" balance $${a.balance}, ${bills.length} bills, ${purchases.length} purchases`);
}

console.log("\nTo pin the household, add this line to release/.env:");
console.log(`NESSIE_CUSTOMER_ID=${customer._id}`);
