import "./env.ts"; // first: loads release/.env before anything reads process.env
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { runReviewTurn, startAgentCore } from "./agent/core.ts";
import { createApp } from "./gateway/app.ts";
import { PhoneSwitch } from "./notify/phones.ts";
import { appUrl } from "./notify/server.ts";
import { buildServices } from "./services.ts";

const config = loadConfig();
const services = buildServices(config, { log: (line) => console.log(line) });
const chain = services.trace.verify({ full: true });
if (!chain.ok) console.warn(`WARNING: audit trace fails verification at seq ${chain.badSeq} (${chain.reason}).`);

const server = http.createServer(createApp(services, (line) => console.log(line)));
startAgentCore(services);
server.listen(config.port, () => {
  console.log(`FinGuard server on http://localhost:${config.port}`);
  console.log(`  policy v${services.policy.current().version}, consent ${services.policy.consent() ? "on file" : "needed"}, ${chain.count} trace events`);
  console.log(`  modes: nessie=${config.nessieMode} rag=${config.ragMode} agent=${config.agentMode} spectrum=${config.spectrumProvider}`);
  console.log(`  stubs: ${services.stubs.join(", ")}`);
  const built = fs.existsSync(path.join(config.webDist, "index.html"));
  if (!built) console.log("  web app: not built; run `npm run build` in release/web, or `npm run dev` there");
  else {
    const local = `http://localhost:${config.port}`;
    const phone = appUrl(process.env, config.port);
    console.log(`  demo entries:
    ${local}/          the phone beside the operations console (desktop)
    ${local}/desk      the customer's desktop view
    ${local}/console   operations: scenes, alerts, audit chain
    ${phone ? `${phone}/app` : `${local}/app`}   the customer app${phone ? " for a phone on this network (Share > Add to Home Screen)" : ""}`);
    if (config.spectrumProvider === "imessage") console.log('    iMessage       text the FinGuard line; "help" lists what works by text');
  }
});
const phones = new PhoneSwitch(services);
services.phones = phones;
void phones.use(phones.defaultPhone());

const autopilot = config.autopilotMinutes
  ? setInterval(() => {
      runReviewTurn(services, { reason: "a scheduled check", source: "system", nudge: true }).catch((err) =>
        console.log(`autopilot: review failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, config.autopilotMinutes * 60_000)
  : undefined;
if (autopilot) console.log(`  autopilot: a household review every ${config.autopilotMinutes} min`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(autopilot);
    void phones.stop();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
