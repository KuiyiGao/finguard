import {
  parseApprovalReply,
  type ApprovalDelivery, type ApprovalReply, type ApprovalRoute, type ApprovalTransport,
} from "./approval-channel.ts";

const MAX_CLOCK_SKEW_MS = 30_000;

export interface SpectrumSpace {
  id: string;
  __platform: string;
  type: string;
  phone: string;
  send(text: string): Promise<unknown>;
}

export interface SpectrumMessage {
  id: string;
  platform: string;
  direction: string;
  timestamp: Date;
  sender?: { id: string };
  space: { id: string };
  content: { type: string; text?: string };
}

export interface SpectrumRuntime {
  messages: AsyncIterable<readonly [unknown, SpectrumMessage]>;
  stop(): Promise<void>;
}

interface SpectrumUser { id: string }
interface SpectrumClient {
  user(handle: string): Promise<SpectrumUser>;
  space: { create(user: SpectrumUser, params?: { phone: string }): Promise<SpectrumSpace> };
}
interface ImessageProvider {
  (app: SpectrumRuntime): SpectrumClient;
  (space: unknown): SpectrumSpace;
  config(): unknown;
}
export interface SpectrumSdk {
  Spectrum(options: {
    projectId: string;
    projectSecret: string;
    providers: unknown[];
    options: { logLevel: "error" };
  }): Promise<SpectrumRuntime>;
  imessage: ImessageProvider;
}

export class SpectrumApprovalTransport implements ApprovalTransport {
  readonly route: Readonly<ApprovalRoute>;
  private readonly runtime: SpectrumRuntime;
  private readonly space: SpectrumSpace;
  private readonly narrowSpace: (space: unknown) => SpectrumSpace;
  private readonly listeners = new Set<(reply: ApprovalReply) => void>();
  private readonly textListeners = new Set<(message: { id: string; text: string }) => void>();
  private readonly messageIds = new Set<string>();
  private readonly openedAt: number;
  private readonly now: () => number;
  private running = true;
  private stopping?: Promise<void>;

  constructor(options: {
    runtime: SpectrumRuntime;
    space: SpectrumSpace;
    recipientId: string;
    narrowSpace: (space: unknown) => SpectrumSpace;
    now?: () => number;
  }) {
    if (
      !options.recipientId || !options.space.id ||
      options.space.__platform !== "imessage" || options.space.type !== "dm" ||
      !options.space.phone
    ) throw new Error("Spectrum approvals require a resolved iMessage direct conversation.");
    this.runtime = options.runtime;
    this.space = options.space;
    this.narrowSpace = options.narrowSpace;
    this.now = options.now ?? Date.now;
    this.openedAt = this.now();
    this.route = Object.freeze({
      recipientId: options.recipientId,
      conversationId: options.space.id,
    });
    void this.consume();
  }

  async send(delivery: ApprovalDelivery): Promise<void> {
    this.assertRoute(delivery.route);
    await this.sendText(delivery.text);
  }

  async notify(route: Readonly<ApprovalRoute>, text: string): Promise<void> {
    this.assertRoute(route);
    await this.sendText(text);
  }

  subscribe(listener: (reply: ApprovalReply) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onText(listener: (message: { id: string; text: string }) => void): () => void {
    this.textListeners.add(listener);
    return () => { this.textListeners.delete(listener); };
  }

  close(): Promise<void> {
    if (!this.stopping) {
      this.running = false;
      this.listeners.clear();
      this.textListeners.clear();
      this.stopping = Promise.resolve()
        .then(() => this.runtime.stop())
        .catch(() => { throw new Error("Spectrum shutdown failed."); });
    }
    return this.stopping;
  }

  private assertRoute(route: Readonly<ApprovalRoute>): void {
    if (!this.running) throw new Error("Spectrum message stream is unavailable.");
    if (
      route.recipientId !== this.route.recipientId ||
      route.conversationId !== this.route.conversationId
    ) throw new Error("Spectrum approval route does not match the registered direct conversation.");
  }

  private async sendText(text: string): Promise<void> {
    try {
      const message = await this.space.send(text);
      if (
        !message || typeof message !== "object" ||
        !("id" in message) || typeof message.id !== "string" || !message.id.trim()
      ) throw new Error("Missing send acknowledgement.");
    } catch {
      throw new Error("Spectrum delivery failed.");
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const [rawSpace, message] of this.runtime.messages) {
        if (!this.running) break;
        if (
          message.platform !== "imessage" || message.direction !== "inbound" ||
          !message.id || this.messageIds.has(message.id)
        ) continue;
        this.messageIds.add(message.id);
        const space = this.narrowSpace(rawSpace);
        const timestamp = message.timestamp instanceof Date ? message.timestamp.getTime() : NaN;
        if (
          space.__platform !== "imessage" || space.type !== "dm" ||
          space.id !== this.route.conversationId || space.phone !== this.space.phone ||
          message.space?.id !== space.id ||
          message.sender?.id !== this.route.recipientId ||
          !Number.isFinite(timestamp) || timestamp < this.openedAt - MAX_CLOCK_SKEW_MS ||
          timestamp > this.now() + MAX_CLOCK_SKEW_MS ||
          message.content?.type !== "text" || typeof message.content.text !== "string"
        ) continue;
        const command = parseApprovalReply(message.content.text);
        if (!command) {
          for (const listener of this.textListeners) listener({ id: message.id, text: message.content.text });
          continue;
        }
        const reply: ApprovalReply = {
          id: message.id,
          senderId: message.sender.id,
          conversationId: space.id,
          requestId: command.requestId,
          text: command.text,
        };
        for (const listener of this.listeners) listener(reply);
      }
    } catch {
    } finally {
      this.running = false;
    }
  }
}

export async function connectSpectrum(options: {
  route: ApprovalRoute;
  env?: Record<string, string | undefined>;
  loadSdk?: () => Promise<SpectrumSdk>;
}): Promise<SpectrumApprovalTransport> {
  const env = options.env ?? process.env;
  if (!env.SPECTRUM_PROJECT_ID || !env.SPECTRUM_PROJECT_SECRET) {
    throw new Error("imessage requires SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in the process environment.");
  }
  if (!options.route.recipientId) {
    throw new Error("imessage requires a registered SPECTRUM_RECIPIENT_ID handle.");
  }
  const sdk = await (options.loadSdk ?? loadSpectrumSdk)();
  let runtime: SpectrumRuntime | undefined;
  try {
    runtime = await sdk.Spectrum({
      projectId: env.SPECTRUM_PROJECT_ID,
      projectSecret: env.SPECTRUM_PROJECT_SECRET,
      providers: [sdk.imessage.config()],
      options: { logLevel: "error" },
    });
    const im = sdk.imessage(runtime);
    const user = await im.user(options.route.recipientId);
    const space = await im.space.create(
      user,
      env.SPECTRUM_IMESSAGE_PHONE ? { phone: env.SPECTRUM_IMESSAGE_PHONE } : undefined,
    );
    if (options.route.conversationId && space.id !== options.route.conversationId) {
      throw new Error("Configured conversation does not match the recipient's DM.");
    }
    return new SpectrumApprovalTransport({
      runtime, space, recipientId: user.id,
      narrowSpace: (rawSpace) => sdk.imessage(rawSpace),
    });
  } catch {
    try { await runtime?.stop(); } catch { /* Preserve the sanitized connection error. */ }
    throw new Error("Spectrum connection or direct-conversation binding failed; check project credentials, registered handle, and line configuration.");
  }
}

async function loadSpectrumSdk(): Promise<SpectrumSdk> {
  const sdkName = "spectrum-ts";
  const providerName = "spectrum-ts/providers/imessage";
  try {
    const [sdk, provider] = await Promise.all([import(sdkName), import(providerName)]);
    if (typeof sdk.Spectrum !== "function" || typeof provider.imessage !== "function") {
      throw new Error("Unsupported SDK exports");
    }
    return { Spectrum: sdk.Spectrum, imessage: provider.imessage } as SpectrumSdk;
  } catch {
    throw new Error("Optional spectrum-ts SDK is unavailable. Run npm ci in release/server, or use SPECTRUM_PROVIDER=terminal|off.");
  }
}
