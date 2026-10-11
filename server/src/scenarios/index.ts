import { RuleScamShield } from "../fraud/scamshield.ts";
import type { DelegationPolicy, Finding, Retriever } from "../types.ts";
import { contractFindings, type ContractTerms } from "./contracts.ts";
import { feeDrag, investmentFindings, investmentTotal } from "./investments.ts";
import { loanFindings, loanTotals, type LoanTotals } from "./loans.ts";

export interface ScenarioInput {
  now: Date;
  retriever: Retriever;
  policy?: () => DelegationPolicy;
  gym?: { id: string; price: number; renews: string; status: string };
}

export interface ScenarioTotals {
  investments: number;
  feeDrag: number;
  loans: LoanTotals;
  contract: ContractTerms & { cancelled: boolean };
}

const NO_POLICY: DelegationPolicy = { version: 0, grants: [], ownAccounts: [], savedPayees: [], newPayeeCoolingOffMinutes: 0, dailyLimit: 0, paused: true };

export async function buildScenarios(input: ScenarioInput): Promise<{ findings: Finding[]; totals: ScenarioTotals }> {
  const shield = new RuleScamShield({ policy: input.policy ?? (() => NO_POLICY), retriever: input.retriever });
  const [investments, loans, contracts] = await Promise.all([
    investmentFindings({ now: input.now, retriever: input.retriever, shield }),
    loanFindings({ now: input.now, retriever: input.retriever, shield }),
    contractFindings({ now: input.now, retriever: input.retriever, gym: input.gym }),
  ]);
  return {
    findings: [...investments, ...loans, ...contracts.findings],
    totals: { investments: investmentTotal(), feeDrag: feeDrag().drag, loans: loanTotals(), contract: { ...contracts.terms, cancelled: contracts.cancelled } },
  };
}
