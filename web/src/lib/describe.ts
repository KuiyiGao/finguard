import type { ToolCall } from "@contracts";
import { accountName, amountOf, formatUsd } from "./format.ts";

const READS: Record<string, string> = {
  "bank.get_accounts": "Read balances",
  "bank.list_bills": "Read bills",
  "bank.list_purchases": "Read purchases",
  "bank.list_payees": "Read saved payees",
  "subscriptions.list": "Read subscriptions",
  "household.accounts": "Read balances",
  "household.bills": "Read bills",
  "household.subscriptions": "Read subscriptions",
  "household.payees": "Read saved payees",
  "household.savings_report": "Read the savings report",
  "household.cash_flow": "Work out what is safe to move",
  "household.messages": "Read forwarded messages and their scam checks",
  "household.protection": "Check blocked moves and waiting approvals",
  "household.scenarios": "Read loan, contract and investment scenarios (simulated)",
  "documents.annotate": "Mark up the shared document",
  "research.sec_filings": "Read SEC filings",
  "research.sec_facts": "Read reported financials (SEC)",
  "research.treasury_rates": "Read Treasury average rates",
  "research.fdic_bank": "Look up the FDIC bank registry",
  "research.cfpb_complaints": "Count CFPB complaints",
};

const NAMES: Record<string, string> = {
  "sub-streamflix": "Paramount+",
  "sub-music": "Spotify",
  "sub-tunebox": "Spotify",
  "sub-cloudbox": "iCloud+",
  "sub-gym": "CloudGym",
  "sub-wordnook": "WordNook Puzzles",
  "sub-gazette": "Hometown Gazette",
  "sub-classicflix": "ClassicFlix",
  "sub-kidstunes": "KidsTunes",
  "sub-familyflix": "FamilyFlix",
  "sub-roadready": "RoadReady Roadside",
  "sub-beatstream": "BeatStream",
  "sub-fuelsaver": "FuelSaver Plus",
  "sub-marketpulse": "MarketPulse Pro",
  "sub-climbing": "Peak Climbing Gym",
  "sub-cloudvault": "CloudVault Storage",
  "bill-duke-oct": "Duke Energy",
  "bill-rent-oct": "Maple Court Apartments",
  "duke-bill": "Duke Energy",
  "duke-next": "Duke Energy",
  "rent-next": "Maple Court Apartments",
  "internet-bill": "Spectrum Internet",
  "bill-oakridge-electric": "Oakridge Electric",
  "bill-maple-hill-water": "Maple Hill Water",
  "bill-evergreen-health": "Evergreen Health Plan",
  "bill-hilltop-phone": "Hilltop Phone & Internet",
  "bill-summit-auto": "Summit Auto Finance",
  "bill-riverbend-rent": "Riverbend Apartments",
  "bill-little-sprouts": "Little Sprouts Daycare",
  "bill-bright-city-power": "Bright City Power",
  "bill-metro-wireless": "Metro Wireless",
  "bill-lakeview-rooms": "Lakeview Rooms",
  "bill-shield-auto": "Shield Auto Insurance",
  "bill-summit-card": "Summit Rewards Card",
  "bill-coastal-power": "Coastal Power & Light",
  "bill-harborview-hoa": "Harborview Condo HOA",
  "payee-duke": "Duke Energy",
  "payee-maple": "Maple Court Apartments",
  "payee-sam": "Sam Rivera",
  "payee-ridgeline": "Ridgeline Plumbing & Heating",
};

export function prettyId(id: string): string {
  if (NAMES[id]) return NAMES[id]!;
  const name = id.replace(/^(sub|bill|payee)-/, "").replace(/-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/, "").replace(/-bill$/, "").replace(/-/g, " ");
  return name.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function plainIds(text: string): string {
  return text
    .replace(/\bbill\s+(bill-[a-z0-9]+(?:-[a-z0-9]+)*)/gi, (_, id: string) => `${prettyId(id.toLowerCase())} bill`)
    .replace(/\b(?:bill|sub|payee)-[a-z0-9]+(?:-[a-z0-9]+)*/gi, (id) => prettyId(id.toLowerCase()))
    .replace(/\bacct-[a-z]+\b/gi, (id) => accountName(id.toLowerCase()));
}

export function sourceKind(source: string): string {
  const s = source.trim().toLowerCase();
  const kinds: [RegExp, string][] = [
    [/accounts#/, "Account balance"],
    [/bills#|^bill-/, "Bill"],
    [/purchases#/, "Purchase"],
    [/payees#|^policy:payee/, "Saved payee"],
    [/subscriptions#/, "Subscription"],
    [/^(kb|builtin):/, "Article"],
    [/^sec:/, "SEC filing"],
    [/^cfpb:/, "CFPB complaint data"],
    [/^fdic:/, "FDIC bank registry"],
    [/^treasury:/, "Treasury rates"],
    [/^sim\./, "Simulated scenario"],
    [/^transfer:/, "Proposed transfer"],
  ];
  return kinds.find(([re]) => re.test(s))?.[1] ?? "";
}

function place(value: unknown): string {
  const v = String(value ?? "");
  if (v.startsWith("acct-")) return accountName(v);
  if (v.startsWith("payee-")) return prettyId(v);
  return /\d{4}/.test(v) ? `account ${v}` : v;
}

function subjectOf(args: Record<string, unknown>): string {
  const subject = args.ticker ?? args.company ?? args.name ?? args.query;
  return typeof subject === "string" || typeof subject === "number" ? String(subject).trim() : "";
}

function humanTool(tool: string): string {
  const words = tool.replace(/^[a-z0-9]+\./i, "").replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tool;
}

export function describeCall(call: Pick<ToolCall, "tool" | "args">): string {
  const read = READS[call.tool];
  if (read) {
    const subject = call.tool.startsWith("research.") ? subjectOf(call.args) : "";
    return subject ? `${read} for ${subject}` : read;
  }
  const amount = amountOf(call.args.amount);
  const money = amount === null ? "?" : formatUsd(amount);
  switch (call.tool) {
    case "bank.move_own":
      return `Move ${money} from ${place(call.args.from_account)} to ${place(call.args.to_account)}`;
    case "bank.pay_bill":
      return `Pay ${prettyId(String(call.args.bill_id))} bill ${money}`;
    case "subscriptions.cancel":
      return `Cancel ${prettyId(String(call.args.subscription_id))}`;
    case "bank.transfer":
      return `Send ${money} to ${place(call.args.to_account)}`;
    default:
      return humanTool(call.tool);
  }
}

export const isRead = (tool: string) => tool in READS;
