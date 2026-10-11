import type { Services } from "../services.ts";
import { startImessage, type ImessageLink } from "./server.ts";
import type { connectSpectrum } from "./spectrum.ts";

export interface Phone {
  id: number;
  name?: string;
  handle: string;
  line?: string;
}

export interface PhoneView {
  id: number;
  label: string;
  active: boolean;
  connected: boolean;
}

/** STEWARD_USER_HANDLE lists one phone or several, comma-separated, each "Name:handle@line" (name and line optional). */
export function parsePhones(env: NodeJS.ProcessEnv): Phone[] {
  const raw = env.STEWARD_USER_HANDLE || env.SPECTRUM_RECIPIENT_ID || "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const named = /^([^:+@]+):(.+)$/.exec(entry);
      const [handle, line] = (named ? named[2]! : entry).split("@").map((part) => part.trim());
      return { id: i + 1, ...(named ? { name: named[1]!.trim() } : {}), handle: handle!, ...(line ? { line } : {}) };
    });
}

/** The phone FinGuard texts. One at a time; switching reconnects iMessage to the chosen phone. */
export class PhoneSwitch {
  private readonly phones: Phone[];
  private link?: ImessageLink;
  private current = 0;
  private switching: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly s: Services,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly connect?: typeof connectSpectrum,
  ) {
    this.phones = parsePhones(env);
  }

  list(): PhoneView[] {
    return this.phones.map((p) => ({ id: p.id, label: `${p.name ?? `Phone ${p.id}`}, ending ${p.handle.slice(-2)}`, active: p.id === this.current, connected: p.id === this.current && Boolean(this.link) }));
  }

  /** IMESSAGE_PHONE picks the phone at startup, by name or number; otherwise the first. */
  defaultPhone(): number {
    const key = this.env.FINGUARD_INSTANCE === "demo" ? (this.env.IMESSAGE_DEMO_PHONE ?? this.env.IMESSAGE_PHONE) : this.env.IMESSAGE_PHONE;
    return this.find(key ?? "")?.id ?? this.phones[0]?.id ?? 1;
  }

  find(key: string | number): Phone | undefined {
    const k = String(key).trim().toLowerCase();
    return this.phones.find((p) => String(p.id) === k || (p.name ?? "").toLowerCase() === k);
  }

  use(key: string | number): Promise<boolean> {
    this.switching = this.switching.then(async () => {
      const phone = this.find(key);
      if (!phone) return false;
      const id = phone.id;
      await this.link?.stop().catch(() => undefined);
      this.link = undefined;
      this.current = id;
      const env = { ...this.env, STEWARD_USER_HANDLE: phone.handle, SPECTRUM_RECIPIENT_ID: "", ...(phone.line ? { SPECTRUM_IMESSAGE_PHONE: phone.line } : {}) };
      this.link = await startImessage(this.s, { env, ...(this.connect ? { connect: this.connect } : {}) });
      return Boolean(this.link);
    });
    return this.switching;
  }

  async stop(): Promise<void> {
    await this.link?.stop().catch(() => undefined);
    this.link = undefined;
  }
}
