import { createHash, randomInt, randomUUID } from "node:crypto";
import { createApprovalChannel } from "./imessage.ts";
import type { ApprovalRequest } from "../types.ts";

const seconds = Number(process.env.APPROVAL_DEMO_TTL_SECONDS ?? "60");
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
  throw new Error("APPROVAL_DEMO_TTL_SECONDS must be between 0 and 3600.");
}
const code = process.env.APPROVAL_DEMO_CODE ?? String(randomInt(1000, 10000));
if (!/^\d{4}$/.test(code)) throw new Error("APPROVAL_DEMO_CODE must contain four digits.");

const action = { tool: "demo.review", args: { description: "Fictional $84.20 bill review" } };
const request: ApprovalRequest = {
  id: `demo-${randomUUID()}`,
  callId: `demo-call-${randomUUID()}`,
  actionHash: createHash("sha256").update(JSON.stringify(action)).digest("hex"),
  code,
  summary: "FICTIONAL DEMO: Review a proposed $84.20 bill payment. This script only records the answer.",
  channel: "imessage",
  expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
  status: "pending",
};
const channel = await createApprovalChannel({
  route: {
    recipientId: process.env.SPECTRUM_RECIPIENT_ID ?? (process.env.SPECTRUM_PROVIDER === "imessage" ? "" : "fictional-user-luster"),
    conversationId: process.env.SPECTRUM_CONVERSATION_ID ?? (process.env.SPECTRUM_PROVIDER === "imessage" ? "" : "fictional-demo-session"),
  },
});
request.expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
if (process.env.SPECTRUM_PROVIDER === "imessage") {
  console.log(`Sending fictional approval ${request.id}; awaiting a phone reply until ${request.expiresAt}.`);
}
process.once("SIGINT", () => channel.close());
process.once("SIGTERM", () => channel.close());
try {
  const outcome = await channel.ask(request);
  console.log(`\nApproval result: ${outcome}. No money action was executed.`);
} finally {
  await channel.shutdown();
}
