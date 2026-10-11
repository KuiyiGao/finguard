import type { ApprovalChannel } from "../types.ts";
import {
  BoundApprovalChannel, OffApprovalChannel,
  type ApprovalRoute, type ApprovalTransport,
} from "./approval-channel.ts";
import { TerminalApprovalTransport } from "./terminal.ts";
import { connectSpectrum, SpectrumApprovalTransport } from "./spectrum.ts";

export type SpectrumProvider = "terminal" | "off" | "imessage";
export interface ManagedApprovalChannel extends ApprovalChannel {
  close(): void;
  shutdown(): Promise<void>;
}

export async function createApprovalChannel(options: {
  route: ApprovalRoute;
  provider?: SpectrumProvider;
  transport?: ApprovalTransport;
}): Promise<ManagedApprovalChannel> {
  const provider = options.provider ?? process.env.SPECTRUM_PROVIDER ?? "off";
  if (provider === "off") {
    const channel = new OffApprovalChannel();
    return Object.assign(channel, { shutdown: async () => { channel.close(); } });
  }
  if (provider !== "terminal" && provider !== "imessage") {
    throw new Error("SPECTRUM_PROVIDER must be terminal, off, or imessage.");
  }
  const transport = options.transport ?? (provider === "terminal"
    ? new TerminalApprovalTransport()
    : await connectSpectrum({ route: options.route }));
  if (options.transport && transport instanceof SpectrumApprovalTransport && (
    transport.route.recipientId !== options.route.recipientId ||
    transport.route.conversationId !== options.route.conversationId
  )) {
    throw new Error("Injected Spectrum transport belongs to a different recipient or conversation.");
  }
  const route = transport instanceof SpectrumApprovalTransport ? transport.route : options.route;
  const channel = new BoundApprovalChannel({ route, transport });
  const close = channel.close.bind(channel);
  let stopping: Promise<void> | undefined;
  channel.close = () => {
    close();
    if (!options.transport && transport instanceof TerminalApprovalTransport) transport.close();
    if (!options.transport && transport instanceof SpectrumApprovalTransport) {
      stopping ??= transport.close();
      void stopping.catch(() => {});
    }
  };
  return Object.assign(channel, {
    shutdown: async () => { channel.close(); await stopping; },
  });
}
