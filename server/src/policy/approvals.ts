import type { ApprovalRequest } from "../types.ts";

export type ApprovalStatus = ApprovalRequest["status"];
export type AnswerResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; problem: "not_found" | "settled" | "wrong_code" | "locked"; error: string; request?: ApprovalRequest };

interface Entry {
  request: ApprovalRequest;
  settle: () => void;
  timer: NodeJS.Timeout;
  wrongCodes: number;
  via?: string;
  usedBy?: string;
}

const MAX_WRONG_CODES = 3;

export class ApprovalBook {
  private entries = new Map<string, Entry>();

  constructor(private readonly onSettled: (request: ApprovalRequest, via: string) => void) {}

  open(request: ApprovalRequest): Promise<ApprovalRequest> {
    return new Promise((resolve) => {
      const ttl = Math.max(0, Date.parse(request.expiresAt) - Date.now());
      const entry: Entry = {
        request,
        wrongCodes: 0,
        settle: () => resolve({ ...entry.request }),
        timer: setTimeout(() => this.finish(entry, "expired", "timeout"), ttl),
      };
      this.entries.set(request.id, entry);
    });
  }

  answer(id: string, approve: boolean, code: string | undefined, via: string): AnswerResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, problem: "not_found", error: "No such approval." };
    if (entry.request.status !== "pending")
      return { ok: false, problem: "settled", error: `This approval is already ${entry.request.status}.`, request: { ...entry.request } };
    if (approve && String(code ?? "").trim() !== entry.request.code) {
      entry.wrongCodes += 1;
      if (entry.wrongCodes >= MAX_WRONG_CODES) {
        this.finish(entry, "denied", `${via}: too many wrong codes`);
        return { ok: false, problem: "locked", error: "Too many wrong codes; the request was denied.", request: { ...entry.request } };
      }
      return { ok: false, problem: "wrong_code", error: "That code does not match this request." };
    }
    this.finish(entry, approve ? "approved" : "denied", via);
    return { ok: true, request: { ...entry.request } };
  }

  settleFromChannel(id: string, status: "approved" | "denied", via: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.request.status === "pending") this.finish(entry, status, via);
  }

  get(id: string): ApprovalRequest | undefined {
    const entry = this.entries.get(id);
    return entry && { ...entry.request };
  }

  via(id: string): string | undefined {
    return this.entries.get(id)?.via;
  }

  pending(): ApprovalRequest[] {
    return [...this.entries.values()].filter((e) => e.request.status === "pending").map((e) => ({ ...e.request }));
  }

  consume(id: string, callId: string, actionHash: string): string | null {
    const entry = this.entries.get(id);
    if (!entry) return "FinGuard has no record of that approval.";
    if (entry.request.status !== "approved") return `That approval is ${entry.request.status}, not approved.`;
    if (entry.request.actionHash !== actionHash) return "That approval was given for a different action.";
    if (entry.usedBy && entry.usedBy !== callId) return "That approval was already used.";
    entry.usedBy = callId;
    return null;
  }

  usedBy(id: string): string | undefined {
    return this.entries.get(id)?.usedBy;
  }

  private finish(entry: Entry, status: Exclude<ApprovalStatus, "pending">, via: string): void {
    if (entry.request.status !== "pending") return;
    clearTimeout(entry.timer);
    entry.request.status = status;
    entry.via = via;
    this.onSettled({ ...entry.request }, via);
    entry.settle();
  }
}
