import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runTurn } from "../agent/turn.ts";
import type { Services } from "../services.ts";
import { replyCitations } from "../findings/normalize.ts";
import type { ApprovalChannel, AuthorizationReceipt, Nudge, TraceEvent } from "../types.ts";
import { newId } from "../util.ts";
import { appUrl } from "./address.ts";
import { BoundApprovalChannel, firstSentence, type UnmatchedReply } from "./approval-channel.ts";

export { appUrl };
import { connectSpectrum, type SpectrumApprovalTransport } from "./spectrum.ts";

export interface ImessageLink {
  handle: string;
  stop(): Promise<void>;
}

const NUDGE_REPEAT_MS = 6 * 3600_000;
const NUDGE_BATCH_MS = 3000;
const APP_ONLY_TOOLS = new Set(["bank.transfer"]);

const UNMATCHED: Record<UnmatchedReply, string> = {
  none_waiting: "No approval is waiting.",
  several_waiting: "Several approvals are waiting. Reply YES, the code and its ID.",
  wrong_code: "That code doesn't match. Reply YES and the code, or NO.",
};

export async function startImessage(
  s: Services,
  opts: { env?: NodeJS.ProcessEnv; connect?: typeof connectSpectrum } = {},
): Promise<ImessageLink | undefined> {
  if (s.config.spectrumProvider !== "imessage") return undefined;
  const env = opts.env ?? process.env;
  const handle = env.STEWARD_USER_HANDLE || env.SPECTRUM_RECIPIENT_ID;
  if (!handle) {
    s.log("imessage: STEWARD_USER_HANDLE is not set; iMessage stays off");
    return undefined;
  }
  const masked = `the handle ending ${handle.slice(-2)}`; // logs never carry the customer's number
  const linkBase = () => appUrl(env, s.config.port);
  let transport: SpectrumApprovalTransport;
  try {
    transport = await (opts.connect ?? connectSpectrum)({ route: { recipientId: handle, conversationId: "" }, env });
  } catch (err) {
    s.log(`imessage: ${err instanceof Error ? err.message : String(err)} iMessage stays off.`);
    return undefined;
  }
  let failures = 0;
  const text = async (body: string): Promise<boolean> => {
    try {
      await channel.notify(body);
      failures = 0;
      return true;
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).split(handle).join("<handle>").slice(0, 200);
      if (failures++ === 0) s.log(`imessage: sending to ${masked} failed (${why}); check that it is registered under Users in the Photon dashboard`);
      return false;
    }
  };
  const channel = new BoundApprovalChannel({
    route: transport.route,
    transport,
    abstainOnFailure: true,
    onUnmatched: (why) => void text(UNMATCHED[why]),
    link: (request) => {
      const base = linkBase();
      return base ? `${base}/app#approval/${request.id}` : undefined;
    },
  });

  const ownTurns = new Set<string>();
  const receipts = new Map<string, string>();
  const imessage: ApprovalChannel = {
    name: channel.name,
    ask: (request, context) => {
      if (!context || !ownTurns.has(context.turnId) || !APP_ONLY_TOOLS.has(context.tool)) return channel.ask(request);
      void text([`FinGuard: ${firstSentence(request.summary)}`, "Approve or decline it in the FinGuard app. Payments to others can't be approved by text."].join("\n"));
      return Promise.resolve("expired"); // abstain: only the app's answer counts
    },
    notify: (body) => channel.notify(body),
    withdraw: (id) => channel.withdraw(id),
  };
  const sentFile = path.join(s.config.dataDir, `imessage-nudges-${createHash("sha256").update(handle).digest("hex").slice(0, 8)}.json`);
  const sent = new Map<string, number>(Object.entries(readJson(sentFile)));
  let batch: Nudge[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    flushTimer = undefined;
    const now = Date.now();
    const fresh = batch.filter((n) => now - (sent.get(`${n.kind}:${n.title}`) ?? 0) > NUDGE_REPEAT_MS);
    batch = [];
    if (!fresh.length) return;
    void text(["FinGuard", ...fresh.map((n) => `• ${n.title}.${replyHint(n)}`)].join("\n")).then((ok) => {
      if (!ok) return;
      for (const n of fresh) sent.set(`${n.kind}:${n.title}`, now);
      for (const [k, at] of sent) if (now - at > NUDGE_REPEAT_MS) sent.delete(k);
      if (s.persist) writeJson(sentFile, Object.fromEntries(sent));
    });
  };
  const onEvent = (e: TraceEvent) => {
    if (e.type === "receipt_issued" && e.turnId && ownTurns.has(e.turnId)) {
      receipts.set(e.turnId, (e.data as AuthorizationReceipt).callId);
    } else if (e.type === "agent_reply" && e.turnId && ownTurns.has(e.turnId)) {
      const d = e.data as { text?: unknown; citations?: { title: string; url?: string }[] };
      const reply = String(d.text ?? "");
      const cited = (d.citations ?? []).filter((c) => c.url);
      const sources = cited.map((c) => `Source: ${c.title} ${c.url}`);
      const callId = receipts.get(e.turnId);
      const base = linkBase();
      const evidence = base && callId ? [`Receipt: ${base}/app#activity/${callId}`] : [];
      const words = breakLinks(replyCitations(reply).text, [...cited.map((c) => c.url!), ...(base ? [base] : [])]);
      if (reply && !reply.startsWith("This needs your approval")) void text([words, ...sources, ...evidence].join("\n"));
    } else if (e.type === "nudge_sent") {
      batch.push(e.data as Nudge);
      flushTimer ??= setTimeout(flush, NUDGE_BATCH_MS);
    }
  };

  let detach = () => {};
  let unsubscribe = () => {};
  const attach = () => {
    detach();
    unsubscribe();
    detach = s.gate.attachChannel(imessage);
    unsubscribe = s.trace.subscribe(onEvent);
  };
  const onReset = () => {
    sent.clear();
    if (s.persist) writeJson(sentFile, {});
    attach();
  };
  attach();
  s.events.on("reset", onReset);

  const stopChat = transport.onText(({ text: words }) => {
    if (s.gate.pendingApprovals().some((a) => new RegExp(`(^|\\D)${a.code}(\\D|$)`).test(words)))
      return void text("To approve, reply YES and the code on its own, or NO.");
    if (HELP.test(words)) return void helpText(s).then(text);
    const turnId = newId("turn");
    ownTurns.add(turnId);
    void (async () => {
      let { text: said, inbound } = splitForwarded(words.slice(0, 2000));
      if (!inbound) {
        const risk = await s.scam.assessMessage(said, `imessage:${turnId}`).then((a) => a.risk, () => "low");
        if (risk !== "low") [said, inbound] = ["Is this real?", said];
      }
      await runTurn(s, { turnId, text: said, ...(inbound ? { inbound: { text: inbound } } : {}), source: "imessage" });
    })()
      .catch((err) => s.log(`imessage: turn ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() =>
        setTimeout(() => {
          ownTurns.delete(turnId);
          receipts.delete(turnId);
        }, 60_000).unref(),
      );
  });

  s.log(`imessage: connected; approvals, chat and nudges for ${masked}${linkBase() ? `; evidence links to ${linkBase()}` : ""}`);
  return {
    handle,
    async stop() {
      if (flushTimer) clearTimeout(flushTimer);
      stopChat();
      s.events.off("reset", onReset);
      unsubscribe();
      detach();
      channel.close();
      await transport.close().catch(() => undefined);
    },
  };
}

function replyHint(n: Nudge): string {
  if (n.kind === "bill_due") return ` Reply "pay my ${n.title.split(" $")[0]} bill".`;
  if ((n.kind === "trial_ending" || n.kind === "subscription_renewing") && n.action) return ` Reply "${n.action.label.toLowerCase()}".`;
  if (n.kind === "safe_to_save" && n.action) return ` Reply "${n.action.label.toLowerCase()} to savings".`;
  return "";
}

const LEAD = String.raw`(?:is (?:this|it|that) (?:real|legit|a scam|safe)|check (?:this|it)(?: (?:message|text))?)(?:\s*[?:!.\-–—]+|\s*\n)|(?:legit|real|scam|safe)\s*\?+|(?:fwd?|forwarded(?: (?:message|text))?)\s*:`;
const FORWARD_LEAD = new RegExp(String.raw`^\s*((?:(?:i )?got this(?: (?:text|message))?[,:.!]?\s*)?(?:${LEAD}))\s*([\s\S]{12,})$`, "i");
const QUOTED = /[“"]([^”"]{24,})[”"]/;
const HELP = /^\s*(help|menu|commands|options|\?|what can (you|i) do( here)?\??)\s*[.!?]*\s*$/i;

async function helpText(s: Services): Promise<string> {
  const result = await s.tools.get("bank.list_bills")?.run({}).catch(() => undefined);
  const bills = result?.ok && Array.isArray(result.data) ? (result.data as { payee?: unknown; status?: unknown }[]) : [];
  const payee = bills.find((b) => b.status !== "paid" && typeof b.payee === "string")?.payee ?? "Duke Energy";
  return [
    "FinGuard by text:",
    `• "Pay my ${String(payee)} bill"`,
    '• "Move $200 to savings"',
    '• "Cancel Paramount+"',
    '• "Is this real?" with the text',
    '• "Pause"',
  ].join("\n");
}

export function breakLinks(text: string, allowed: string[]): string {
  const host = (u: string) => u.replace(/^https?:\/\//i, "").split(/[/?#]/)[0]!.toLowerCase();
  const ok = new Set(allowed.map(host));
  return text.replace(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s)]*)?/gi, (m) => (ok.has(host(m)) ? m : m.replace(/\./g, "[.]")));
}

export function splitForwarded(text: string): { text: string; inbound?: string } {
  const lead = FORWARD_LEAD.exec(text);
  if (lead) return { text: lead[1]!.trim(), inbound: lead[2]!.trim().replace(/^['‘’“”"]+|['‘’“”"]+$/g, "").trim() };
  const quoted = QUOTED.exec(text);
  if (quoted) {
    const rest = (text.slice(0, quoted.index) + text.slice(quoted.index + quoted[0].length)).trim();
    return { text: rest || "Is this real?", inbound: quoted[1]!.trim() };
  }
  return { text };
}

function readJson(file: string): Record<string, number> {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(data).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
}

function writeJson(file: string, data: Record<string, number>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
  }
}
