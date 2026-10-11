import type { ToolSpec } from "../types.ts";

const account = { type: "string", description: "Account id, e.g. acct-checking, or an account number" };
const amount = { type: "number", exclusiveMinimum: 0, description: "USD" };

export const BANK_TOOLS = {
  getAccounts: {
    name: "bank.get_accounts",
    description: "List the user's accounts with balances.",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    capability: "bank.read",
  },
  listBills: {
    name: "bank.list_bills",
    description: "List bills with payee, amount and due date.",
    inputSchema: { type: "object", properties: { account_id: account } },
    effect: "read",
    capability: "bank.read",
  },
  listPurchases: {
    name: "bank.list_purchases",
    description: "List recent purchases with merchant, amount, date and memo.",
    inputSchema: { type: "object", properties: { account_id: account, limit: { type: "number" } } },
    effect: "read",
    capability: "bank.read",
  },
  listPayees: {
    name: "bank.list_payees",
    description: "List the user's saved payees and their accounts on file.",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    capability: "bank.read",
  },
  moveOwn: {
    name: "bank.move_own",
    description: "Move money between two of the user's own accounts.",
    inputSchema: {
      type: "object",
      properties: { from_account: account, to_account: account, amount },
      required: ["from_account", "to_account", "amount"],
    },
    effect: "move_money",
    capability: "transfers.own",
    moneyFields: ["from_account", "to_account", "amount"],
  },
  payBill: {
    name: "bank.pay_bill",
    description: "Pay a bill on file to the payee's account on file.",
    inputSchema: {
      type: "object",
      properties: { bill_id: { type: "string" }, from_account: account, amount },
      required: ["bill_id", "from_account", "amount"],
    },
    effect: "move_money",
    capability: "bills.pay",
    moneyFields: ["bill_id", "from_account", "amount"],
  },
  transfer: {
    name: "bank.transfer",
    description: "Send money from the user's account to another person's account.",
    inputSchema: {
      type: "object",
      properties: {
        from_account: account,
        to_account: account,
        amount,
        payee_name: { type: "string" },
        memo: { type: "string" },
      },
      required: ["from_account", "to_account", "amount"],
    },
    effect: "move_money",
    capability: "transfers.external",
    moneyFields: ["from_account", "to_account", "amount"],
  },
  listSubscriptions: {
    name: "subscriptions.list",
    description: "List recurring subscriptions and trials with price, renewal date and last use.",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    capability: "bank.read",
  },
  cancelSubscription: {
    name: "subscriptions.cancel",
    description: "Cancel a subscription or trial with the merchant before it renews.",
    inputSchema: { type: "object", properties: { subscription_id: { type: "string" } }, required: ["subscription_id"] },
    effect: "account_change",
    capability: "subscriptions.manage",
    moneyFields: ["subscription_id"],
  },
} satisfies Record<string, ToolSpec>;
