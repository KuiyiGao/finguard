export type Json = Record<string, any>;
export type Role = "customer" | "operator";
export type Call = (role: Role, method: string, path: string, body?: unknown) => Promise<Json>;

export interface Line {
  label: string;
  text: string;
  tone?: "ok" | "warn" | "bad" | "dim";
}

export interface Step {
  title: string;
  say: string;
  show: string;
  run: (call: Call, memo: Json) => Promise<Line[]>;
}

export interface DirectorEntry {
  n: number;
  title: string;
  lines: Line[];
}

export const INTRO = "Hey, I'm Kuiyi. Our team built FinGuard here at HackNC. It's an AI assistant that can pay bills and move money for you. The catch is it has to check everything first, and if something's risky, it asks you before it does anything. Let me show you.";

export const OUTRO = "That's FinGuard. Thanks!";

export const SCAM = "Grandma it's me, I'm in trouble and need $900 for bail tonight. Please buy gift cards and send me the codes. Don't tell mom.";

const replies = (r: Json): string[] => (Array.isArray(r.replies) ? r.replies : r.reply ? [r.reply] : []).map((t: string) => t.replace(/\s*\[(kb|doc|src):[^\]]+\]/g, ""));

async function ask(call: Call, memo: Json, text: string, inbound?: string): Promise<Line[]> {
  const lines: Line[] = [{ label: "Customer", text: inbound ? `${text} (forwarded: "${inbound.slice(0, 70)}…")` : text, tone: "dim" }];
  const r = await call("customer", "POST", "/api/chat", { text, ...(inbound ? { inbound: { text: inbound } } : {}) });
  for (const t of replies(r)) lines.push({ label: "FinGuard", text: t });
  const a = r.approval as Json | undefined;
  if (r.status === "awaiting_approval" && a?.id) {
    memo.approval = { id: a.id, code: a.code };
    lines.push({ label: "SkillGate", text: `asks for approval: ${a.summary}`, tone: "warn" });
    lines.push({ label: "Code", text: `${a.code}. Approve on the phone, text "YES ${a.code}", or press Next`, tone: "warn" });
  }
  return lines;
}

async function lastReceipt(call: Call): Promise<Line[]> {
  const state = await call("customer", "GET", "/api/state");
  const receipt = (state.receipts as Json[] | undefined)?.at(-1);
  if (!receipt) return [];
  const by = receipt.channel === "imessage" ? "by iMessage" : receipt.channel === "app" ? "in the app" : "by your standing limit";
  return [{ label: "Receipt", text: `${receipt.action}. ${receipt.id}, authorized ${by}`, tone: "ok" }];
}

/** The demo, in order. Each step calls the running server's API as the customer or the operator would. */
export function directorSteps(): Step[] {
  return [
    {
      title: "Every connection is live",
      say: "So this is all running live right now. The bank data comes from Capital One's test sandbox, and the texts are real.",
      show: "Point at the connections list and the live dot on the phone.",
      run: async (call) => {
        const phones = ((await call("customer", "GET", "/api/imessage/phones")).phones as Json[]) ?? [];
        const h = await call("customer", "GET", "/api/health");
        const active = phones.find((p) => p.active);
        return [
          { label: "Modes", text: Object.entries(h.modes ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") },
          ...(active ? [{ label: "iMessage", text: `${active.label}${active.connected ? ", connected" : ", not connected"}`, tone: active.connected ? ("ok" as const) : ("bad" as const) }] : []),
          { label: "Audit chain", text: `${h.trace?.events} events, ${h.trace?.verified ? "verified" : "not verified"}`, tone: h.trace?.verified ? "ok" : "bad" },
        ];
      },
    },
    {
      title: "FinGuard checks your money on its own and texts you",
      say: "It can check my account on a schedule. Here's one check: it texted me that a bill's due and a free trial is about to charge me.",
      show: "Point at the alerts arriving in iMessage and on the phone.",
      run: async (call) => {
        const r = await call("operator", "POST", "/api/nudges/run");
        return ((r.nudges as Json[]) ?? []).map((n) => ({ label: "Alert", text: n.title }));
      },
    },
    {
      title: "Ask the agent to pay a bill",
      say: "Okay, I'll ask it to pay the electric bill. It doesn't just do it. It shows me where every number came from and asks me for a code first.",
      show: "Point at the approval sheet: where each number came from, the code, and the countdown.",
      run: (call, memo) => ask(call, memo, "Pay my Duke Energy bill"),
    },
    {
      title: "Approve with the one-time code",
      say: "I put in the code, it pays, and I get a receipt.",
      show: "Point at the receipt and the step that just turned to Done.",
      run: async (call, memo) => {
        const a = memo.approval as Json | undefined;
        if (a) {
          const now = (await call("customer", "GET", `/api/approvals/${a.id}`)).approval as Json;
          if (now?.status === "pending") await call("customer", "POST", `/api/approvals/${a.id}`, { approve: true, code: a.code });
          memo.approval = undefined;
          await new Promise((r) => setTimeout(r, 2500));
        }
        return lastReceipt(call);
      },
    },
    {
      title: "A scam text is forwarded",
      say: "Now say my grandma gets this text. She forwards it, and it tells her why it's a scam.",
      show: "Point at the scam signals in the reply.",
      run: (call, memo) => ask(call, memo, "Is this real?", SCAM),
    },
    {
      title: "Push the agent to pay the scammer",
      say: "If she says send it anyway, it still won't. It checks the message again, says no, and never even proposes a payment.",
      show: "Point at the refusal.",
      run: (call, memo) => ask(call, memo, "Send it anyway"),
    },
    {
      title: "Within limits, the agent just does it",
      say: "Moving two hundred bucks into my own savings is under the limit I set, so it just does it. I still get a receipt.",
      show: "Point at the Autopilot meter and the new receipt.",
      run: async (call, memo) => [...(await ask(call, memo, "Move $200 to savings")), ...(await lastReceipt(call))],
    },
    {
      title: "The document agent reads an invoice",
      say: "It reads invoices too. This one switched the bank account, so it gets flagged.",
      show: "Point at the finding about the changed account.",
      run: async (call) => {
        const samples = (await call("customer", "GET", "/api/documents/samples")) as unknown as Json[];
        const invoice = samples.find((d) => d.kind === "invoice") ?? samples[0]!;
        const r = await call("customer", "POST", "/api/documents/review", { text: invoice.text, kind: invoice.kind, name: invoice.name });
        return [{ label: "Document", text: invoice.name, tone: "dim" }, ...(r.finding?.title ? [{ label: "Finding", text: r.finding.title, tone: "warn" as const }] : []), ...replies(r).slice(0, 1).map((t) => ({ label: "FinGuard", text: t }))];
      },
    },
    {
      title: "Research with live public data",
      say: "It can look up a bank or a company with real public data, and it shows where it got it. It won't tell you what stock to buy.",
      show: "Point at the sources.",
      run: async (call) => {
        const r = await call("customer", "POST", "/api/research/brief", { query: "Capital One" });
        return ((r.findings as Json[]) ?? []).slice(0, 4).map((f) => ({ label: "Finding", text: String(f.title ?? f.headline ?? "") }));
      },
    },
    {
      title: "Every step is in a hash-chained audit log",
      say: "And everything it did is saved in a log you can actually check.",
      show: "Point at verified and the event count.",
      run: async (call) => {
        const v = await call("operator", "GET", "/api/audit/verify");
        const s = await call("customer", "GET", "/api/state");
        return [
          { label: "Audit chain", text: `${v.ok ? "verified" : "broken"}, ${v.count ?? "?"} events`, tone: v.ok ? "ok" : "bad" },
          { label: "Receipts", text: `${(s.receipts as Json[] | undefined)?.length ?? 0} today` },
        ];
      },
    },
    {
      title: "On the phone, by iMessage",
      say: "You can do all of this over text, too.",
      show: "Hold up the phone and send help.",
      run: async () => [
        { label: "Text", text: '"help"' },
        { label: "Text", text: '"Pay my Spectrum Internet bill", then "YES" and the code' },
        { label: "Text", text: '"Send $60 to account 55554444" (approved only in the app)' },
      ],
    },
  ];
}

/** Server-side director for the web controls: one step per Next, a clean start on restart. */
export class Director {
  private next = 1;
  private log: DirectorEntry[] = [];
  private memo: Json = {};
  private running?: Promise<DirectorEntry | null>;
  private readonly steps = directorSteps();

  constructor(private readonly call: Call) {}

  view() {
    return { intro: INTRO, outro: OUTRO, steps: this.steps.map((s, i) => ({ n: i + 1, title: s.title, say: s.say, show: s.show })), next: this.next <= this.steps.length ? this.next : null, running: Boolean(this.running), log: this.log };
  }

  async restart(): Promise<void> {
    await this.call("operator", "POST", "/api/demo/reset", { consent: true });
    this.next = 1;
    this.log = [];
    this.memo = {};
  }

  step(): Promise<DirectorEntry | null> {
    this.running ??= (async () => {
      const step = this.steps[this.next - 1];
      if (!step) return null;
      const n = this.next++;
      let lines: Line[];
      try {
        lines = await step.run(this.call, this.memo);
      } catch (err) {
        lines = [{ label: "Problem", text: err instanceof Error ? err.message : String(err), tone: "bad" }];
      }
      const entry = { n, title: step.title, lines };
      this.log.push(entry);
      return entry;
    })().finally(() => (this.running = undefined));
    return this.running;
  }
}
