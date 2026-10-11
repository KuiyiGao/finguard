import type { Area } from "../types.ts";
import { accountNumbersIn, formatUsd } from "../util.ts";
import type { Agent, AgentContext, TurnInput } from "./agent.ts";
import { explainAssessment, explainOutcome } from "./explain.ts";
import { answerResearch, researchAskIn } from "../research/agent.ts";

const CHECKING = "acct-checking";
const SAVINGS = "acct-savings";

const HELP =
  "I can check a message you forward me, find ways to save, explain your loans, contracts and investment fees, cancel subscriptions, move money between your accounts, pay bills and send money within the limits you set.";

const AREA_QUESTIONS: [Area, RegExp, string][] = [
  ["loans", /\b(loans?|refinanc\w*|apr|car payment|student debt)\b/, "loans"],
  ["contracts", /\b(contracts?|agreements?|lease|fine print|auto-?renew\w*|membership terms)\b/, "contracts"],
  ["investments", /\b(invest\w*|portfolio|index fund|expense ratio|brokerage|401\(?k\)?|ira|fund fees?)\b/, "investments"],
];

export function amountIn(text: string): number | null {
  const clean = text.replace(/,(?=\d{3})/g, "");
  const dollar = clean.match(/\$\s?(\d+(?:\.\d{1,2})?)/) ?? clean.match(/(\d+(?:\.\d{1,2})?)\s?(dollars|bucks|usd)\b/i);
  if (dollar) return Number(dollar[1]);
  const bare = [...clean.matchAll(/\b\d+(?:\.\d{1,2})?\b/g)].map((m) => m[0]).find((n) => n.includes(".") || n.length < 4);
  return bare ? Number(bare) : null;
}

export function requestIn(text: string): { amount: number; account: string } | null {
  const asked = text.replace(/,(?=\d{3})/g, "").match(/\b(?:move|send|transfer|pay|wire|deposit)\b[^$\d]{0,20}\$\s?(\d+(?:\.\d{1,2})?)/i);
  const amount = asked ? Number(asked[1]) : amountIn(text);
  const account = accountNumbersIn(text).at(-1);
  return amount !== null && account ? { amount, account } : null;
}

const has = (text: string, re: RegExp) => re.test(text);

export type RuleIntent =
  | { kind: "forwarded"; message: string; act: boolean } // a forwarded message: check it, or act on it
  | { kind: "pause" }
  | { kind: "cancel" }
  | { kind: "area"; area: Area; words: string }
  | { kind: "move_own"; from: string; to: string }
  | { kind: "savings" }
  | { kind: "pay_bill" }
  | { kind: "send" }
  | { kind: "balances" }
  | { kind: "research"; query: string; bank: boolean } // public-data research: a company, or "is X bank real?"
  | { kind: "help" };

export function classifyIntent(input: TurnInput, recentInbound: string[]): RuleIntent {
  const text = input.text.trim();
  const lower = text.toLowerCase();
  const asksCheck = has(lower, /\b(real|legit|scam|should i|is this|check)\b/);
  const wantsAction = has(lower, /\b(send|pay|transfer|move|wire|do it|do what it says|go ahead|anyway)\b/);
  const refersBack = has(lower, /\b(it|this|that|what it says|anyway|the invoice|the request|the message)\b/);

  const research = input.inbound ? undefined : researchAskIn(text);
  if (research?.bank) return { kind: "research", ...research };

  const forwarded = input.inbound?.text ?? (asksCheck || (wantsAction && refersBack) ? recentInbound.at(-1) : undefined);
  if (forwarded) return { kind: "forwarded", message: forwarded, act: wantsAction && !asksCheck };

  if (has(lower, /\b(pause|freeze|stop)\b.*\b(all|everything|money|payments|transfers)\b|^pause/)) return { kind: "pause" };
  if (has(lower, /\b(cancel|unsubscribe|stop paying for)\b/)) return { kind: "cancel" };
  const area = AREA_QUESTIONS.find(([, re]) => re.test(lower));
  if (area) return { kind: "area", area: area[0], words: area[2] };
  if (has(lower, /\b(move|transfer|put|send)\b.*\b(to|into)\b.*\bsavings\b/)) return { kind: "move_own", from: CHECKING, to: SAVINGS };
  if (has(lower, /\b(move|transfer|put)\b.*\b(to|into)\b.*\bchecking\b/)) return { kind: "move_own", from: SAVINGS, to: CHECKING };
  if (has(lower, /\b(save|saving|savings|cut|spend less|cheaper|lower my)\b/)) return { kind: "savings" };
  if (has(lower, /\bpay\b.*\bbill\b|\bbill\b.*\bpay\b/)) return { kind: "pay_bill" };
  if (has(lower, /\b(send|pay|transfer|zelle|venmo)\b/) && amountIn(text) !== null) return { kind: "send" };
  if (has(lower, /\b(balance|how much (do i|money)|accounts?)\b/)) return { kind: "balances" };
  if (research) return { kind: "research", ...research };
  return { kind: "help" };
}

export class RuleAgent implements Agent {
  readonly name = "rules";

  async handle(input: TurnInput, ctx: AgentContext): Promise<void> {
    return this.run(classifyIntent(input, ctx.recentInbound()), input, ctx);
  }

  async run(intent: RuleIntent, input: TurnInput, ctx: AgentContext): Promise<void> {
    const text = input.text.trim();
    const lower = text.toLowerCase();
    switch (intent.kind) {
      case "forwarded":
        return this.forwarded(intent.message, input, ctx, intent.act);
      case "pause":
        ctx.pause();
        return ctx.say("Paused. FinGuard will not move any money until you resume it in Settings and agree to the policy again.");
      case "cancel":
        return this.cancel(lower, ctx);
      case "area":
        return this.area(intent.area, intent.words, ctx);
      case "move_own":
        return this.moveOwn(lower, intent.from, intent.to, ctx);
      case "savings":
        return this.savings(ctx);
      case "pay_bill":
        return this.payBill(lower, ctx);
      case "send":
        return this.send(text, lower, ctx);
      case "balances":
        return this.balances(ctx);
      case "research":
        return answerResearch(intent, ctx);
      case "help":
        return ctx.say(HELP);
    }
  }

  private async forwarded(message: string, input: TurnInput, ctx: AgentContext, act: boolean): Promise<void> {
    const ref = input.inbound ? `inbound:${input.inbound.id}` : "inbound:earlier";
    const request = requestIn(message);
    if (!act || !request || input.inbound) {
      const assessment = await ctx.checkMessage(message, ref);
      if (!act || !request) return ctx.say(explainAssessment(assessment));
    }

    const outcome = await ctx.tool("bank.transfer", {
      from_account: CHECKING,
      to_account: request.account,
      amount: request.amount,
      memo: "as asked in the forwarded message",
    });
    ctx.say(explainOutcome(outcome) ?? "Done.");
    if (outcome.status === "denied" && outcome.decision.scam?.risk === "high") {
      const contact = ctx.policy().trustedContact;
      ctx.alertTrustedContact(
        `FinGuard stopped a likely scam payment of ${formatUsd(request.amount)} to account ${request.account}. Nothing was sent. Please check in with them.`,
      );
      if (contact) ctx.say(`I recorded an alert for ${contact.name}, as you asked for high-risk attempts. FinGuard does not text them yet, so you may want to call them.`);
    }
  }

  private async moveOwn(lower: string, from: string, to: string, ctx: AgentContext): Promise<void> {
    const amount = amountIn(lower);
    if (amount === null) return ctx.say(`How much should I move to ${to === SAVINGS ? "savings" : "checking"}?`);
    const outcome = await ctx.tool("bank.move_own", { from_account: from, to_account: to, amount });
    ctx.say(explainOutcome(outcome) ?? "Done.");
  }

  private async cancel(lower: string, ctx: AgentContext): Promise<void> {
    const listed = await ctx.tool("subscriptions.list", {});
    if (listed.status !== "executed") return ctx.say(explainOutcome(listed) ?? "I could not read your subscriptions.");
    const subs = (listed.result.data ?? []) as { id: string; merchant: string; price: number; status: string }[];
    const active = subs.filter((x) => x.status === "active");
    const sub = active.find((x) => x.merchant.toLowerCase().split(/\s+/).some((w) => w.length > 2 && lower.includes(w)));
    if (!sub) return ctx.say(active.length ? `Which one? You pay for ${active.map((x) => `${x.merchant} (${formatUsd(x.price)} a month)`).join(", ")}.` : "You have no active subscriptions.");
    const outcome = await ctx.tool("subscriptions.cancel", { subscription_id: sub.id });
    ctx.say(outcome.status === "executed" ? `Cancelled ${sub.merchant}. You will not be charged ${formatUsd(sub.price)} again. Receipt ${outcome.receipt?.id ?? ""}.`.replace(/ \.$/, ".") : (explainOutcome(outcome) ?? "Done."));
  }

  private async payBill(lower: string, ctx: AgentContext): Promise<void> {
    const listed = await ctx.tool("bank.list_bills", {});
    if (listed.status !== "executed") return ctx.say(explainOutcome(listed) ?? "I could not read your bills.");
    const bills = ((listed.result.data ?? []) as { id: string; payee: string; amount: number; due: string; status?: string }[]).filter((b) => b.status !== "paid");
    const bill = bills.find((b) => b.payee.toLowerCase().split(/\s+/).some((w) => w.length > 2 && lower.includes(w))) ?? (bills.length === 1 ? bills[0] : undefined);
    if (!bill) return ctx.say(bills.length ? `Which bill? You have ${bills.map((b) => `${b.payee} (${formatUsd(b.amount)})`).join(", ")}.` : "You have no bills due.");
    const outcome = await ctx.tool("bank.pay_bill", { bill_id: bill.id, from_account: CHECKING, amount: bill.amount });
    ctx.say(explainOutcome(outcome) ?? "Done.");
  }

  private async send(text: string, lower: string, ctx: AgentContext): Promise<void> {
    const amount = amountIn(text)!;
    const listed = await ctx.tool("bank.list_payees", {});
    const payees = (listed.status === "executed" ? listed.result.data : []) as { id: string; name: string; account: string }[];
    const byName = payees.find((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.length > 2 && lower.includes(w)));
    const account = byName?.account ?? accountNumbersIn(text).at(-1);
    if (!account) return ctx.say("Who should I send it to? Give me a saved payee's name or an account number.");
    const outcome = await ctx.tool("bank.transfer", { from_account: CHECKING, to_account: account, amount, ...(byName ? { payee_name: byName.name } : {}) });
    ctx.say(explainOutcome(outcome) ?? "Done.");
  }

  private async savings(ctx: AgentContext): Promise<void> {
    const report = await ctx.savings();
    const top = [...report.recommendations].sort((a, b) => b.monthlySavings - a.monthlySavings).slice(0, 3);
    ctx.say(
      `I found about ${formatUsd(report.totalMonthly)} a month you could save: ` +
        top.map((r) => `${r.title.split(":")[0]} (${formatUsd(r.monthlySavings)} a month)`).join("; ") +
        ". Open the panel to see the evidence for each and act with one tap.",
    );
  }

  private async balances(ctx: AgentContext): Promise<void> {
    const listed = await ctx.tool("bank.get_accounts", {});
    if (listed.status !== "executed") return ctx.say(explainOutcome(listed) ?? "I could not read your accounts.");
    const accounts = listed.result.data as { nickname: string; last4?: string; balance: number }[];
    ctx.say(accounts.map((a) => `${a.nickname}${a.last4 ? ` ...${a.last4}` : ""}: ${formatUsd(a.balance)}`).join(". ") + ".");
  }

  private async area(area: Area, words: string, ctx: AgentContext): Promise<void> {
    const cards = ((await ctx.findings?.(area)) ?? []).filter((f) => f.area === area);
    if (cards.length === 0) return ctx.say(`I have nothing on your ${words} yet.`);
    const top = cards.slice(0, 2);
    const source = top.flatMap((f) => f.citations).find((c) => c.url);
    ctx.say(
      top.map((f) => `${f.title}. ${f.summary}`).join(" ") +
        (source ? ` Source: ${source.title}.` : "") +
        (top.some((f) => f.simulated) ? " These are simulated demo figures." : ""),
    );
    const act = top.find((f) => f.action)?.action;
    if (act) ctx.say(`Want me to ${act.label.charAt(0).toLowerCase()}${act.label.slice(1)}? It runs through SkillGate and needs your approval code.`);
  }
}

