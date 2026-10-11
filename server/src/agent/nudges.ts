import type { Services } from "../services.ts";
import type { CashFlow, Nudge } from "../types.ts";
import { formatUsd, newId, nowIso } from "../util.ts";

const DAY = 86_400_000;

function daysUntil(date: string): number {
  return Math.max(0, Math.ceil((Date.parse(date) - Date.now()) / DAY));
}

const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

interface Sub { id: string; merchant: string; price: number; renews: string; trial: boolean; lastUsed: string | null; status: string }
interface Bill { id: string; payee: string; amount: number; due: string; status?: string }

export async function findNudges(s: Services, inputs: { subs?: unknown[]; bills?: unknown[]; flow?: CashFlow | null } = {}): Promise<Nudge[]> {
  const read = async <T,>(tool: string) => ((await s.tools.get(tool)?.run({}))?.data ?? []) as T[];
  const [subs, bills, flow] = await Promise.all([
    (inputs.subs as Sub[] | undefined) ?? read<Sub>("subscriptions.list"),
    (inputs.bills as Bill[] | undefined) ?? read<Bill>("bank.list_bills"),
    inputs.flow !== undefined ? inputs.flow : s.cashFlow(s.policy.current().ownAccounts[0] ?? ""),
  ]);
  const nudges: Nudge[] = [];
  const make = (n: Omit<Nudge, "id" | "createdAt">): Nudge => ({ ...n, id: newId("nudge"), createdAt: nowIso() });

  for (const sub of subs.filter((x) => x.status === "active")) {
    const days = daysUntil(sub.renews);
    const unusedDays = sub.lastUsed ? Math.floor((Date.now() - Date.parse(sub.lastUsed)) / DAY) : null;
    if (sub.trial && days <= 3)
      nudges.push(
        make({
          kind: "trial_ending",
          title: `${sub.merchant} trial renews ${inDays(days)}`,
          body: `You have not used it. It becomes ${formatUsd(sub.price)} a month ${inDays(days)}. Want me to cancel it before you are charged?`,
          evidence: [{ label: `Trial renews ${sub.renews} at ${formatUsd(sub.price)}/month`, source: `bank:subscriptions#${sub.id}` }],
          action: { label: `Cancel ${sub.merchant}`, tool: "subscriptions.cancel", args: { subscription_id: sub.id } },
        }),
      );
    else if (unusedDays !== null && unusedDays >= 45)
      nudges.push(
        make({
          kind: "subscription_renewing",
          title: `${sub.merchant}: not used in ${unusedDays} days`,
          body: `It renews ${inDays(days)} for ${formatUsd(sub.price)}. Cancel it to save ${formatUsd(sub.price * 12)} a year?`,
          evidence: [{ label: `Last used ${sub.lastUsed}`, source: `bank:subscriptions#${sub.id}` }],
          action: { label: `Cancel ${sub.merchant}`, tool: "subscriptions.cancel", args: { subscription_id: sub.id } },
        }),
      );
  }

  for (const bill of bills.filter((b) => b.status !== "paid" && daysUntil(b.due) <= 3))
    nudges.push(
      make({
        kind: "bill_due",
        title: `${bill.payee} ${formatUsd(bill.amount)} is due ${inDays(daysUntil(bill.due))}`,
        body: "Pay it now to avoid a late fee. It goes to the account on file, and I will ask you to confirm with a code.",
        evidence: [{ label: `${bill.payee} bill due ${bill.due}`, source: `bank:bills#${bill.id}` }],
        action: { label: `Pay ${formatUsd(bill.amount)}`, tool: "bank.pay_bill", args: { bill_id: bill.id, from_account: flow?.account ?? "acct-checking", amount: bill.amount } },
      }),
    );

  if (flow && flow.safeToMove >= 200) {
    const own = s.policy.current().grants.find((g) => g.capability === "transfers.own");
    const amount = Math.min(own?.maxAmount ?? 500, Math.floor(flow.safeToMove / 100) * 100);
    const owed = flow.upcoming.reduce((sum, b) => sum + b.amount, 0);
    nudges.push(
      make({
        kind: "safe_to_save",
        title: `${formatUsd(flow.safeToMove)} is safe to save`,
        body: `After ${formatUsd(owed)} of bills due in the next ${flow.horizonDays} days and your ${formatUsd(flow.buffer)} buffer, checking has room. Move ${formatUsd(amount)} to savings?`,
        evidence: flow.upcoming.map((b) => ({ label: `${b.label} ${formatUsd(b.amount)} due ${b.due}`, source: `bank:bills#${b.source}` })),
        action: { label: `Move ${formatUsd(amount)}`, tool: "bank.move_own", args: { from_account: flow.account, to_account: s.policy.current().ownAccounts[1] ?? "acct-savings", amount } },
      }),
    );
  }
  return nudges;
}

export async function sendNudges(s: Services): Promise<Nudge[]> {
  const nudges = await findNudges(s);
  for (const n of nudges) s.trace.append("nudge_sent", n);
  return nudges;
}
