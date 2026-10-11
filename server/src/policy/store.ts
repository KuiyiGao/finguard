import fs from "node:fs";
import type { TraceLog } from "../audit/trace.ts";
import type { Capability, CapabilityGrant, ConsentRecord, DelegationPolicy } from "../types.ts";
import { canonicalJson, formatUsd, newId, nowIso, sha256 } from "../util.ts";

export const CAPABILITIES: readonly Capability[] = ["bank.read", "transfers.own", "bills.pay", "transfers.external", "subscriptions.manage", "research.read"];

export const CAPABILITY_PHRASE: Record<Capability, string> = {
  "bank.read": "read your balances, bills, purchases and payees",
  "transfers.own": "move money between your own accounts",
  "bills.pay": "pay your bills",
  "transfers.external": "send money to other people",
  "subscriptions.manage": "cancel your subscriptions and trials",
  "research.read": "look up public data such as company filings, Treasury rates, the FDIC bank list and CFPB complaints",
};

export type PolicyChanges = Partial<Omit<DelegationPolicy, "version" | "savedPayees">> & {
  savedPayees?: { id?: string; name: string; account: string; addedAt?: string }[];
};

interface PolicyChanged {
  policy: DelegationPolicy;
  hash: string;
  changed: string[];
  note: string;
}

export function policyHash(policy: DelegationPolicy): string {
  return sha256(canonicalJson(policy));
}

export function validatePolicy(value: unknown): string[] {
  const p = value as Partial<DelegationPolicy> | null;
  if (!p || typeof p !== "object") return ["policy must be an object"];
  const errors: string[] = [];
  const isAmount = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const isText = (s: unknown) => typeof s === "string" && s.trim().length > 0;

  if (!Number.isInteger(p.version) || (p.version ?? 0) < 1) errors.push("version must be a positive integer");
  if (!Array.isArray(p.grants)) errors.push("grants must be a list");
  else {
    const seen = new Set<string>();
    for (const g of p.grants as Partial<CapabilityGrant>[]) {
      if (!CAPABILITIES.includes(g?.capability as Capability)) errors.push(`unknown capability ${String(g?.capability)}`);
      else if (seen.has(g.capability!)) errors.push(`capability ${g.capability} is granted twice`);
      else seen.add(g.capability!);
      if (!["never", "always", "over_limit"].includes(g?.approval as string)) errors.push(`grant ${String(g?.capability)} needs approval never, always or over_limit`);
      if (g?.maxAmount !== undefined && !isAmount(g.maxAmount)) errors.push(`grant ${String(g.capability)} maxAmount must be a non-negative number`);
      if (g?.approval === "over_limit" && g.maxAmount === undefined) errors.push(`grant ${String(g.capability)} uses over_limit without a maxAmount`);
    }
  }
  if (!Array.isArray(p.ownAccounts) || !p.ownAccounts.every(isText)) errors.push("ownAccounts must be a list of account ids");
  if (!Array.isArray(p.savedPayees)) errors.push("savedPayees must be a list");
  else if (!p.savedPayees.every((s) => isText(s?.id) && isText(s?.name) && isText(s?.account) && !Number.isNaN(Date.parse(s?.addedAt))))
    errors.push("every saved payee needs id, name, account and an addedAt date");
  if (!isAmount(p.newPayeeCoolingOffMinutes)) errors.push("newPayeeCoolingOffMinutes must be a non-negative number");
  if (!isAmount(p.dailyLimit)) errors.push("dailyLimit must be a non-negative number");
  if (p.cashFlowBuffer !== undefined && !isAmount(p.cashFlowBuffer)) errors.push("cashFlowBuffer must be a non-negative number");
  if (p.trustedContact !== undefined && !(isText(p.trustedContact?.name) && isText(p.trustedContact?.handle)))
    errors.push("trustedContact needs a name and a handle");
  if (typeof p.paused !== "boolean") errors.push("paused must be true or false");
  return errors;
}

export function loadPolicyFile(file: string): DelegationPolicy {
  const policy = JSON.parse(fs.readFileSync(file, "utf8")) as DelegationPolicy;
  const errors = validatePolicy(policy);
  if (errors.length) throw new Error(`invalid policy in ${file}: ${errors.join("; ")}`);
  return policy;
}

function grantSentence(g: CapabilityGrant): string {
  const what = CAPABILITY_PHRASE[g.capability].replace(/\byour\b/g, "my");
  const max = g.maxAmount === undefined ? "" : ` up to ${formatUsd(g.maxAmount)} each`;
  if (g.approval === "never") return `${what}${max} without asking me`;
  if (g.approval === "always") return `${what}${max}, only after I approve each one`;
  return `${what} without asking me up to ${formatUsd(g.maxAmount ?? 0)} each, and only after I approve above that`;
}

export function consentStatement(policy: DelegationPolicy): string {
  const parts = [
    `Under policy v${policy.version}, I let FinGuard ${policy.grants.map(grantSentence).join("; ")}.`,
    `FinGuard never moves more than ${formatUsd(policy.dailyLimit)} in a day for me.`,
  ];
  if (policy.cashFlowBuffer !== undefined)
    parts.push(`A move that would leave my checking account short of bills due in the next 14 days plus ${formatUsd(policy.cashFlowBuffer)} needs my approval.`);
  if (policy.newPayeeCoolingOffMinutes > 0)
    parts.push(`Payments to a payee added in the last ${Math.round(policy.newPayeeCoolingOffMinutes / 60)} hours, or to someone not saved, need my approval.`);
  if (policy.paused) parts.push("Money movement is paused until I resume it.");
  parts.push(
    "Actions FinGuard takes within these limits, or that I approve with a code, count as authorized by me. " +
      "FinGuard keeps a receipt for each one, and I can pause or change this policy at any time.",
  );
  return parts.join(" ");
}

export class PolicyStore {
  private versions: DelegationPolicy[] = [];
  private consents: ConsentRecord[] = [];

  constructor(private readonly trace: TraceLog, defaults: DelegationPolicy) {
    for (const e of trace.list()) {
      if (e.type === "policy_changed") this.versions.push((e.data as PolicyChanged).policy);
      if (e.type === "consent_recorded") this.consents.push(e.data as ConsentRecord);
    }
    if (this.versions.length === 0) {
      const errors = validatePolicy({ ...defaults, version: 1 });
      if (errors.length) throw new Error(`invalid default policy: ${errors.join("; ")}`);
      this.commit({ ...defaults, version: 1 }, Object.keys(defaults), "default policy");
    }
  }

  current(): DelegationPolicy {
    return this.versions.at(-1)!;
  }

  hash(): string {
    return policyHash(this.current());
  }

  history(): DelegationPolicy[] {
    return [...this.versions];
  }

  consent(): ConsentRecord | undefined {
    const policy = this.current();
    const hash = policyHash(policy);
    return this.consents.findLast((c) => c.policyVersion === policy.version && c.policyHash === hash);
  }

  statement(): string {
    return consentStatement(this.current());
  }

  update(changes: PolicyChanges, note = ""): DelegationPolicy {
    const before = this.current();
    const savedPayees = changes.savedPayees?.map((p) => ({
      id: p.id ?? newId("payee"),
      name: p.name,
      account: p.account,
      addedAt: p.addedAt ?? before.savedPayees.find((s) => s.id === p.id)?.addedAt ?? nowIso(),
    }));
    const next: DelegationPolicy = { ...before, ...changes, savedPayees: savedPayees ?? before.savedPayees, version: before.version + 1 };
    const errors = validatePolicy(next);
    if (errors.length) throw new PolicyError(errors);
    const changed = (Object.keys(next) as (keyof DelegationPolicy)[]).filter(
      (k) => k !== "version" && canonicalJson(next[k]) !== canonicalJson(before[k]),
    );
    if (changed.length === 0) return before;
    this.commit(next, changed, note);
    return next;
  }

  recordConsent(channel: ConsentRecord["channel"]): ConsentRecord {
    const existing = this.consent();
    if (existing) return existing;
    const policy = this.current();
    const record: ConsentRecord = {
      id: newId("consent"),
      policyVersion: policy.version,
      policyHash: policyHash(policy),
      statement: consentStatement(policy),
      acceptedAt: nowIso(),
      channel,
    };
    this.consents.push(record);
    this.trace.append("consent_recorded", record);
    return record;
  }

  private commit(policy: DelegationPolicy, changed: string[], note: string): void {
    this.versions.push(policy);
    this.trace.append<PolicyChanged>("policy_changed", { policy, hash: policyHash(policy), changed, note });
  }
}

export class PolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid policy: ${problems.join("; ")}`);
  }
}
