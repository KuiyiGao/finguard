import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  ApprovalDelivery, ApprovalReply, ApprovalRoute, ApprovalTransport,
} from "./approval-channel.ts";

export class TerminalApprovalTransport implements ApprovalTransport {
  private readonly output: Writable;
  private readonly readline: Interface;
  private readonly routes = new Map<string, Readonly<ApprovalRoute>>();
  private readonly listeners = new Set<(reply: ApprovalReply) => void>();
  private closed = false;

  constructor(options: { input?: Readable; output?: Writable } = {}) {
    this.output = options.output ?? process.stdout;
    this.readline = createInterface({
      input: options.input ?? process.stdin,
      crlfDelay: Infinity,
    });
    this.readline.on("line", (line) => this.receiveLine(line));
    this.readline.on("close", () => { this.closed = true; });
  }

  async send(delivery: ApprovalDelivery): Promise<void> {
    if (this.closed) throw new Error("Terminal input is closed.");
    if (this.routes.has(delivery.request.id)) {
      throw new Error("Terminal request IDs must be unique for this transport.");
    }
    this.routes.set(delivery.request.id, delivery.route);
    this.output.write(
      `\n[terminal to ${delivery.route.recipientId}; session ${delivery.route.conversationId}]\n${delivery.text}\n> `,
    );
  }

  async notify(route: Readonly<ApprovalRoute>, text: string): Promise<void> {
    this.output.write(`\n[terminal to ${route.recipientId}; session ${route.conversationId}]\n${text}\n`);
  }

  subscribe(listener: (reply: ApprovalReply) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.closed = true;
    this.readline.close();
    this.listeners.clear();
  }

  private receiveLine(line: string): void {
    const match = /^(YES\s+\d{4}|NO)\s+([A-Za-z0-9_.:-]{1,128})$/i.exec(line.trim());
    const text = match?.[1];
    const requestId = match?.[2];
    const route = requestId ? this.routes.get(requestId) : undefined;
    if (!text || !requestId || !route) {
      this.output.write("Use YES <4-digit-code> <request-id> or NO <request-id>.\n> ");
      return;
    }
    const reply: ApprovalReply = {
      id: randomUUID(),
      senderId: route.recipientId,
      conversationId: route.conversationId,
      requestId,
      text,
    };
    for (const listener of this.listeners) listener(reply);
  }
}
