import type { ApprovalChannel, ApprovalRequest } from "../types.ts";

export type ApprovalOutcome = "approved" | "denied" | "expired";

export type UnmatchedReply = "none_waiting" | "several_waiting" | "wrong_code";

export interface ApprovalRoute {
  recipientId: string;
  conversationId: string;
}

export interface ApprovalReply {
  id: string;
  senderId: string;
  conversationId: string;
  requestId: string;
  text: string;
}

export interface ApprovalDelivery {
  route: Readonly<ApprovalRoute>;
  request: Readonly<ApprovalRequest>;
  text: string;
}

export interface ApprovalTransport {
  send(delivery: ApprovalDelivery): Promise<void>;
  notify(route: Readonly<ApprovalRoute>, text: string): Promise<void>;
  subscribe(listener: (reply: ApprovalReply) => void): () => void;
}

interface Pending {
  request: Readonly<ApprovalRequest>;
  expiresAt: number;
  sending: boolean;
  delivered: boolean;
  earlyReply?: ApprovalReply;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (outcome: ApprovalOutcome) => void;
}

export class BoundApprovalChannel implements ApprovalChannel {
  readonly name = "imessage" as const;
  private readonly route: Readonly<ApprovalRoute>;
  private readonly transport: ApprovalTransport;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly requestIds = new Set<string>();
  private readonly replyIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly failure: ApprovalOutcome;
  private readonly onUnmatched?: (why: UnmatchedReply) => void;
  private readonly link?: (request: Readonly<ApprovalRequest>) => string | undefined;
  private closed = false;

  constructor(options: {
    route: ApprovalRoute;
    transport: ApprovalTransport;
    now?: () => number;
    abstainOnFailure?: boolean;
    onUnmatched?: (why: UnmatchedReply) => void;
    link?: (request: Readonly<ApprovalRequest>) => string | undefined;
  }) {
    if (!options.route.recipientId || !options.route.conversationId) {
      throw new Error("Approval routing requires a recipient and conversation.");
    }
    this.route = Object.freeze({ ...options.route });
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.failure = options.abstainOnFailure ? "expired" : "denied";
    this.onUnmatched = options.onUnmatched;
    this.link = options.link;
    this.unsubscribe = this.transport.subscribe((reply) => this.receive(reply));
  }

  ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const expiresAt = Date.parse(request.expiresAt);
    if (
      this.closed ||
      request.status !== "pending" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.id) ||
      !request.callId ||
      !/^[a-f0-9]{64}$/i.test(request.actionHash) ||
      !/^\d{4}$/.test(request.code) ||
      !Number.isFinite(expiresAt) ||
      this.requestIds.has(request.id)
    ) {
      return Promise.resolve(this.failure);
    }
    this.requestIds.add(request.id);
    if (expiresAt <= this.now()) return Promise.resolve("expired");

    const snapshot = Object.freeze({ ...request });
    return new Promise<ApprovalOutcome>((resolve) => {
      const pending: Pending = {
        request: snapshot,
        expiresAt,
        sending: false,
        delivered: false,
        resolve,
      };
      this.pending.set(snapshot.id, pending);
      this.scheduleExpiry(snapshot.id, pending);
      Promise.resolve()
        .then(() => {
          if (!this.pending.has(snapshot.id)) return;
          if (this.now() >= pending.expiresAt) {
            this.settle(snapshot.id, "expired");
            return;
          }
          pending.sending = true;
          return this.transport.send({
            route: this.route,
            request: snapshot,
            text: formatApproval(snapshot, { several: this.pending.size > 1, link: this.link?.(snapshot) }),
          });
        })
        .then(() => {
          if (this.now() >= pending.expiresAt) {
            this.settle(snapshot.id, "expired");
            return;
          }
          pending.delivered = true;
          if (pending.earlyReply) this.applyReply(snapshot.id, pending, pending.earlyReply);
        })
        .catch(() => this.settle(
          snapshot.id, this.now() >= pending.expiresAt ? "expired" : this.failure,
        ));
    });
  }

  withdraw(requestId: string): void {
    this.settle(requestId, "expired");
  }

  async notify(text: string): Promise<void> {
    if (this.closed) throw new Error("Approval channel is closed.");
    await this.transport.notify(this.route, text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const id of this.pending.keys()) this.settle(id, this.failure);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private receive(reply: ApprovalReply): void {
    if (
      this.closed || !reply.id || typeof reply.text !== "string" ||
      reply.senderId !== this.route.recipientId ||
      reply.conversationId !== this.route.conversationId ||
      this.replyIds.has(reply.id)
    ) return;
    this.replyIds.add(reply.id);
    const requestId = reply.requestId || (this.pending.size === 1 ? [...this.pending.keys()][0]! : "");
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.onUnmatched?.(this.pending.size > 1 && !reply.requestId ? "several_waiting" : "none_waiting");
      return;
    }
    if (this.now() >= pending.expiresAt) {
      this.settle(requestId, "expired");
      return;
    }
    if (!pending.delivered) {
      if (pending.sending && !pending.earlyReply && this.replyOutcome(reply, pending)) {
        pending.earlyReply = Object.freeze({ ...reply });
      }
      return;
    }
    this.applyReply(requestId, pending, reply);
  }

  private replyOutcome(reply: ApprovalReply, pending: Pending): ApprovalOutcome | undefined {
    const text = reply.text.trim();
    if (/^NO$/i.test(text)) return "denied";
    const match = /^YES\s+(\d{4})$/i.exec(text);
    return match?.[1] === pending.request.code ? "approved" : undefined;
  }

  private applyReply(id: string, pending: Pending, reply: ApprovalReply): void {
    if (this.pending.get(id) !== pending) return;
    if (this.now() >= pending.expiresAt) {
      this.settle(id, "expired");
      return;
    }
    const outcome = this.replyOutcome(reply, pending);
    if (outcome) this.settle(id, outcome);
    else this.onUnmatched?.("wrong_code");
  }

  private scheduleExpiry(id: string, pending: Pending): void {
    const remaining = pending.expiresAt - this.now();
    if (remaining <= 0) {
      this.settle(id, "expired");
      return;
    }
    pending.timer = setTimeout(
      () => this.scheduleExpiry(id, pending),
      Math.min(remaining, 2_147_483_647),
    );
  }

  private settle(id: string, outcome: ApprovalOutcome): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }
}

export function parseApprovalReply(text: string): { text: string; requestId: string } | undefined {
  const t = text.trim();
  const id = String.raw`(?:[\s,.:;!-]+([A-Za-z0-9_.:-]*[0-9_:-][A-Za-z0-9_.:-]*))?`;
  const yes = new RegExp(String.raw`^(?:(?:yes|y|yep|yeah|ok|okay|approve|approved|confirm)[\s,.:;!-]*)?(\d{4})${id}[\s.!]*$`, "i").exec(t);
  if (yes) return { text: `YES ${yes[1]}`, requestId: yes[2] ?? "" };
  const no = new RegExp(String.raw`^(?:no|n|nope|decline|deny)${id}[\s.!]*$`, "i").exec(t);
  if (no) return { text: "NO", requestId: no[1] ?? "" };
  return undefined;
}

export class OffApprovalChannel implements ApprovalChannel {
  readonly name = "imessage" as const;

  async ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return Date.parse(request.expiresAt) <= Date.now() ? "expired" : "denied";
  }

  async notify(_text: string): Promise<void> {}
  close(): void {}
}

/** The action itself, without SkillGate's explanation that follows it. */
export function firstSentence(summary: string): string {
  const cut = summary.search(/\.\s+[A-Z]/);
  return cut > 0 ? summary.slice(0, cut + 1) : summary;
}

export function formatApproval(request: Readonly<ApprovalRequest>, options: { several?: boolean; link?: string } = {}): string {
  const expires = new Date(request.expiresAt);
  const until = Number.isFinite(expires.getTime()) ? expires.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : request.expiresAt;
  return [
    `FinGuard approval: ${firstSentence(request.summary)}`,
    ...(request.checks?.length ? [`✓ ${request.checks.join(", ")}.`] : []),
    `Reply YES ${request.code}${options.several ? ` ${request.id}` : ""} or NO by ${until}.`,
    ...(options.link ? [options.link] : []),
  ].join("\n");
}
