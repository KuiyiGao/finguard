import type { ToolRegistry } from "../tools/registry.ts";
import type { CashFlow, DelegationPolicy } from "../types.ts";

export type CashFlowSource = (account: string) => Promise<CashFlow | null>;

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function bankCashFlow(tools: ToolRegistry, policy: () => DelegationPolicy, horizonDays = 14): CashFlowSource {
  return async (account) => {
    const accounts = await tools.get("bank.get_accounts")?.run({});
    const found = ((accounts?.data ?? []) as { id: string; balance: number }[]).find((a) => a.id === account);
    if (!found) return null;
    const p = policy();
    let upcoming: CashFlow["upcoming"] = [];
    if (account === p.ownAccounts[0]) {
      const bills = await tools.get("bank.list_bills")?.run({});
      const until = Date.now() + horizonDays * DAY;
      upcoming = ((bills?.data ?? []) as { id: string; payee: string; amount: number; due: string; status?: string }[])
        .filter((b) => b.status !== "paid" && Date.parse(b.due) <= until)
        .map((b) => ({ label: b.payee, amount: b.amount, due: b.due, source: b.id }));
    }
    const buffer = p.cashFlowBuffer ?? 0;
    const owed = upcoming.reduce((sum, b) => sum + b.amount, 0);
    return { account, balance: found.balance, upcoming, buffer, safeToMove: Math.max(0, round2(found.balance - owed - buffer)), horizonDays };
  };
}
