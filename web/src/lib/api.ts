import type { ApprovalRequest, AuthorizationReceipt, CashFlow, ConsentRecord, DelegationPolicy, FindingsView, Nudge, SavingsReport } from "@contracts";

export type Role = "customer" | "operator";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(role: Role, method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(path, {
    method,
    headers: { "X-Demo-Role": role, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" ? data.error : `Request failed (${res.status})`, data);
  return { status: res.status, data: data as T };
}

export interface State {
  role: Role;
  policy: DelegationPolicy;
  policyHash: string;
  consent: ConsentRecord | null;
  needsConsent: boolean;
  approvals: ApprovalRequest[];
  receipts: AuthorizationReceipt[];
  spentToday: number;
  trace: { events: number; head: string | null; verify?: VerifyResult };
}

export type VerifyResult = { ok: true; count: number; head?: string | null } | { ok: false; count: number; badSeq: number; reason: string; head?: string | null };

export interface EvalResult {
  ranAt: string;
  total: number;
  passed: number;
  byCategory: Record<string, { total: number; passed: number }>;
  cases: { id: string; category: string; expected: string; actual: string; ok: boolean }[];
}

export interface DirectorView {
  intro: string;
  outro: string;
  steps: { n: number; title: string; say: string; show: string }[];
  next: number | null;
  running: boolean;
  log: { n: number; title: string; lines: { label: string; text: string; tone?: "ok" | "warn" | "bad" | "dim" }[] }[];
}

export interface PhoneView {
  id: number;
  label: string;
  active: boolean;
  connected: boolean;
}

export interface Health {
  ok: boolean;
  service?: string;
  version?: string;
  startedAt?: string;
  modes?: Record<string, string>;
  stubs?: string[];
  trace?: { events: number; verified: boolean };
  keys?: Record<string, boolean>;
  phoneUrl?: string;
}

export interface Account {
  id: string;
  nickname: string;
  last4: string;
  balance: number;
}

export type DocumentKind = "contract" | "statement" | "invoice";
export interface DocumentSample {
  id: string;
  kind: DocumentKind;
  name: string;
  text: string;
  fictional: true;
}

export function api(role: Role) {
  return {
    state: async () => (await call<State>(role, "GET", "/api/state")).data,
    policy: async () => (await call<{ policy: DelegationPolicy; hash: string; statement: string; consent: ConsentRecord | null; versions: number }>(role, "GET", "/api/policy")).data,
    accounts: async () => (await call<{ accounts: Account[]; stub: boolean }>(role, "GET", "/api/accounts")).data,
    savings: async () => (await call<{ report: SavingsReport }>(role, "GET", "/api/savings")).data.report,
    chat: async (text: string, inbound?: { id?: string; text: string }) =>
      (await call<{ turnId: string; status: "done" | "awaiting_approval"; replies?: string[]; approval?: ApprovalRequest }>(role, "POST", "/api/chat", { text, inbound })).data,
    action: async (tool: string, args: Record<string, unknown>) => (await call<Record<string, unknown>>(role, "POST", "/api/actions", { tool, args })).data,
    answer: async (id: string, approve: boolean, code?: string) =>
      (await call<{ approval: ApprovalRequest }>(role, "POST", `/api/approvals/${id}`, { approve, code })).data.approval,
    updatePolicy: async (changes: Record<string, unknown>, note?: string) =>
      (await call<{ policy: DelegationPolicy; statement: string; needsConsent: boolean }>(role, "POST", "/api/policy", { changes, note })).data,
    consent: async (policyVersion: number) => (await call<{ consent: ConsentRecord }>(role, "POST", "/api/consent", { policyVersion, channel: "app" })).data.consent,
    verify: async () => (await call<VerifyResult>(role, "GET", "/api/audit/verify")).data,
    scenes: async () => (await call<{ scenes: { id: string; title: string; summary: string }[] }>(role, "GET", "/api/demo/scenes")).data.scenes,
    playScene: async (id: string) => (await call<unknown>(role, "POST", `/api/demo/scenes/${id}`, {})).data,
    evalResult: async () => (await call<{ result: EvalResult | null }>(role, "GET", "/api/eval")).data.result,
    cashFlow: async () => (await call<{ cashFlow: CashFlow }>(role, "GET", "/api/cashflow")).data.cashFlow,
    runNudges: async () => (await call<{ nudges: Nudge[] }>(role, "POST", "/api/nudges/run", {})).data.nudges,
    replay: async (approvalId: string) =>
      (await call<{ blocked: boolean; reason: string }>(role, "POST", `/api/demo/replay/${approvalId}`, {})).data,
    reset: async (consent = false) => (await call<unknown>(role, "POST", "/api/demo/reset", { consent })).data,
    findings: async () => {
      const data = (await call<FindingsView & { view?: FindingsView }>(role, "GET", "/api/findings")).data;
      return data.view ?? data;
    },
    metrics: async () => (await call<Record<string, unknown>>(role, "GET", "/api/metrics")).data,
    dbStats: async () => (await call<Record<string, unknown>>(role, "GET", "/api/db/stats")).data,
    health: async () => (await call<Health>(role, "GET", "/api/health")).data,
    director: async () => (await call<DirectorView>(role, "GET", "/api/director")).data,
    directorNext: async () => (await call<DirectorView>(role, "POST", "/api/director/next", {})).data,
    directorRestart: async () => (await call<DirectorView>(role, "POST", "/api/director/restart", {})).data,
    phones: async () => (await call<{ phones: PhoneView[] }>(role, "GET", "/api/imessage/phones")).data.phones,
    usePhone: async (id: number) => (await call<{ ok: boolean; phones: PhoneView[] }>(role, "POST", `/api/imessage/phones/${id}`, {})).data,
    researchBrief: async (query: string) => (await call<Record<string, unknown>>(role, "POST", "/api/research/brief", { query })).data,
    researchSkills: async () => (await call<Record<string, unknown>>(role, "GET", "/api/research/skills")).data,
    reviewContract: async (text: string, name?: string) => (await call<Record<string, unknown>>(role, "POST", "/api/contracts/review", { text, name })).data,
    reviewDocument: async (text: string, kind?: DocumentKind, name?: string) => (await call<Record<string, unknown>>(role, "POST", "/api/documents/review", { text, kind, name })).data,
    documentSamples: async () => (await call<DocumentSample[]>(role, "GET", "/api/documents/samples")).data,
    agentReview: async () => (await call<Record<string, unknown>>(role, "POST", "/api/agent/review", {})).data,
  };
}

export type Api = ReturnType<typeof api>;
