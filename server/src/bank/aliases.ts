import { seedHousehold } from "../../mock-nessie/seed.ts";

type Row = Record<string, unknown>;
export type RawRequest = (path: string, method?: string, body?: unknown, executionId?: string) => Promise<unknown>;

const ACCOUNT_IDS: Record<string, string> = { Checking: "acct-checking", Savings: "acct-savings" };
export const NESSIE_MERCHANT_IDS: Record<string, string> = {
  StreamPlus: "stream", MusicBox: "music", "Demo Internet": "internet", "Demo Groceries": "groceries",
  ...Object.fromEntries(seedHousehold().merchants.map((m) => [m.name, m._id])),
};
export const SEED_CUSTOMER = { first_name: "Demo", last_name: "Household" };
export function seedCustomers(customers: unknown): Row[] {
  return (Array.isArray(customers) ? (customers as Row[]) : [])
    .filter((c) => c && c.first_name === SEED_CUSTOMER.first_name && c.last_name === SEED_CUSTOMER.last_name && typeof c._id === "string")
    .sort((a, b) => (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0));
}
export const NESSIE_PAYEE_NAMES: Record<string, string> = { "Demo Internet": "Spectrum Internet" };
const DEMO_ID = /^[a-z][\w-]{0,60}$/;
const TTL_MS = 30_000;

export function createNessieAliases(raw: RawRequest, { customerId, log = () => {} }: { customerId?: string; log?: (line: string) => void } = {}) {
  let cache: { at: number; toUuid: Map<string, string>; toDemo: Map<string, string> } | undefined;
  let household: Promise<string | undefined> | undefined;
  const merchants = new Map<string, Promise<string | null>>();

  function selectedCustomer(): Promise<string | undefined> {
    if (customerId) return Promise.resolve(customerId);
    household ??= findHousehold().catch((error) => {
      household = undefined;
      throw error;
    });
    return household;
  }

  async function findHousehold(): Promise<string | undefined> {
    const found = seedCustomers(await raw("/customers"));
    const named = `${SEED_CUSTOMER.first_name} ${SEED_CUSTOMER.last_name}`;
    if (!found.length) log(`bank: NESSIE_CUSTOMER_ID is not set and no sandbox customer is named ${named}; reading every account under this key. Run npm run nessie:seed, then set NESSIE_CUSTOMER_ID`);
    else if (found.length > 1) log(`bank: NESSIE_CUSTOMER_ID is not set and ${found.length} sandbox customers are named ${named}; using ${String(found[0]!._id)}, the lowest id. Set NESSIE_CUSTOMER_ID to choose`);
    return found[0] ? String(found[0]._id) : undefined;
  }

  async function maps(accounts?: unknown) {
    if (cache && Date.now() - cache.at < TTL_MS) return cache;
    return load(accounts).catch(() => ({ at: 0, toUuid: new Map<string, string>(), toDemo: new Map<string, string>() }));
  }

  async function load(listed?: unknown) {
    const toUuid = new Map<string, string>(), toDemo = new Map<string, string>();
    const add = (demo: string, uuid: string) => {
      if (toUuid.has(demo) || toDemo.has(uuid)) return;
      toUuid.set(demo, uuid);
      toDemo.set(uuid, demo);
    };
    const accounts = listed ?? (await raw("/accounts"));
    const customer = await selectedCustomer();
    for (const a of Array.isArray(accounts) ? (accounts as Row[]) : []) {
      if (customer && a.customer_id !== customer) continue;
      const demo = ACCOUNT_IDS[String(a.type)];
      if (demo) add(demo, String(a._id));
    }
    let complete = true;
    for (const uuid of [...toDemo.keys()]) {
      const bills = await raw(`/accounts/${uuid}/bills`).catch(() => {
        complete = false;
        return [];
      });
      for (const b of Array.isArray(bills) ? (bills as Row[]) : []) {
        const nick = String(b.nickname ?? "");
        if (DEMO_ID.test(nick) && b.status !== "completed") add(nick, String(b._id));
      }
    }
    cache = { at: complete ? Date.now() : 0, toUuid, toDemo };
    return cache;
  }

  function merchantDemoId(uuid: string): Promise<string | null> {
    let known = merchants.get(uuid);
    if (!known) {
      known = raw(`/merchants/${uuid}`).then(
        (m) => {
          const name = String((m as Row | null)?.name);
          return Object.hasOwn(NESSIE_MERCHANT_IDS, name) ? NESSIE_MERCHANT_IDS[name]! : null;
        },
        () => {
          merchants.delete(uuid);
          return null;
        },
      );
      merchants.set(uuid, known);
    }
    return known;
  }

  async function toDemoRow(row: Row, toDemo: Map<string, string>): Promise<Row> {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === "string" && toDemo.has(v) ? toDemo.get(v) : v;
    if (typeof row._id === "string" && out._id !== row._id) out.nessie_id = row._id;
    if (typeof row.payee === "string" && Object.hasOwn(NESSIE_PAYEE_NAMES, row.payee)) out.payee = NESSIE_PAYEE_NAMES[row.payee]!;
    if (typeof row.merchant_id === "string") {
      const demo = await merchantDemoId(row.merchant_id);
      if (demo) {
        out.merchant_id = demo;
        if (demo === "fee" && typeof row._id === "string") Object.assign(out, { _id: "p-fee", nessie_id: row._id });
      }
    }
    return out;
  }

  return {
    selectedCustomer,
    async request(path: string, method = "GET", body?: unknown, executionId?: string): Promise<unknown> {
      const listed = method === "GET" && path === "/accounts" ? await raw(path) : undefined;
      const { toUuid, toDemo } = await maps(listed);
      const livePath = path.split("/").map((seg) => toUuid.get(seg) ?? seg).join("/");
      const liveBody = body && typeof body === "object" && !Array.isArray(body)
        ? Object.fromEntries(Object.entries(body as Row).map(([k, v]) => [k, typeof v === "string" ? toUuid.get(v) ?? v : v]))
        : body;
      const data = listed ?? (await raw(livePath, method, liveBody, executionId));
      if (method !== "GET") cache = undefined; // balances, bills and ids may have changed
      if (Array.isArray(data)) return Promise.all(data.map((r) => (r && typeof r === "object" ? toDemoRow(r as Row, toDemo) : r)));
      if (data && typeof data === "object") {
        const row = data as Row;
        if (row.objectCreated && typeof row.objectCreated === "object") return { ...row, objectCreated: await toDemoRow(row.objectCreated as Row, toDemo) };
        return toDemoRow(row, toDemo);
      }
      return data;
    },
  };
}
