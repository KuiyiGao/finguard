import fs from "node:fs";
import type { RequestListener } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { currentFindings, reviewNow, routeAction, runActionTurn, runDocumentTurn, runReviewTurn, type TurnSource } from "../agent/core.ts";
import { runTurn } from "../agent/turn.ts";
import { SERVER_ROOT } from "../config.ts";
import { DEFAULT_PERSONA, findPersona, personaList, UnknownPersonaError } from "../demo/personas.ts";
import { playScene, replayApproval, SCENES } from "../demo/scenes.ts";
import type { RunOutcome } from "../policy/run.ts";
import { PolicyError, type PolicyChanges } from "../policy/store.ts";
import { DOCUMENT_KINDS, documentSamples, MAX_DOCUMENT_CHARS, type DocumentKind } from "../documents/index.ts";
import { buildResearchBrief } from "../research/brief.ts";
import { researchPack } from "../research/index.ts";
import { resetServices, type Services } from "../services.ts";
import type { ApprovalRequest, TraceEvent, TraceEventType } from "../types.ts";
import { newId } from "../util.ts";
import { HttpError, readJson, roleOf, route, sendJson, type Ctx, type Role, type Route } from "./http.ts";
import { appUrl } from "../notify/address.ts";
import { serveWeb } from "./static.ts";
import { Director, type Call } from "../demo/director.ts";

const phoneUrl = (port: number) => {
  const base = appUrl(process.env, port);
  return base ? `${base}/app` : undefined;
};

const VERSION = "0.1.0";
const ANYONE: Role[] = ["customer", "operator"];
const CUSTOMER: Role[] = ["customer"];
const OPERATOR: Role[] = ["operator"];

const OPERATOR_ONLY: ReadonlySet<TraceEventType> = new Set(["skill_loaded", "eval_result", "scenario_started"]);
const POLICY_KEYS = new Set(["grants", "savedPayees", "newPayeeCoolingOffMinutes", "dailyLimit", "trustedContact", "paused", "cashFlowBuffer"]);

function approvalView(request: ApprovalRequest, role: Role): Partial<ApprovalRequest> {
  if (role === "customer") return request;
  const { code: _code, ...rest } = request;
  return rest;
}

function text(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${field} must be a non-empty string.`);
  if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return value;
}

const documentSource = (value: unknown): TurnSource => (value === "app" || value === "imessage" ? value : "desk");

export function createApp(s: Services, log: (line: string) => void = () => {}): RequestListener {
  const selfCall: Call = async (role, method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${s.config.port}${path}`, { method, headers: { "X-Demo-Role": role, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.status >= 400) throw new Error(`${method} ${path}: ${res.status} ${data.error ?? ""}`);
    return data;
  };
  let directorState: Director | undefined;
  const director = () => (directorState ??= new Director(selfCall));
  const outcomeView = (o: RunOutcome, role: Role) => ({
    status: o.status,
    decision: o.decision,
    approval: "approval" in o && o.approval ? approvalView(o.approval, role) : undefined,
    receipt: o.status === "executed" ? o.receipt : undefined,
    result: o.status === "executed" ? o.result.data : undefined,
    error: "error" in o ? o.error : undefined,
  });

  const routes: Route[] = [
    route("GET", "/api/health", ANYONE, () => {
      const chain = s.trace.verify();
      return {
        ok: true,
        service: "finguard",
        version: VERSION,
        startedAt: s.startedAt,
        modes: { nessie: s.config.nessieMode, rag: s.config.ragMode, agent: s.config.agentMode, spectrum: s.config.spectrumProvider,
          scam: s.config.scamLlm, sec: s.config.secret("SEC_USER_AGENT") ? "live" : "cached",
          autopilot: s.config.autopilotMinutes ? `every ${s.config.autopilotMinutes} min` : "off" },
        phoneUrl: phoneUrl(s.config.port),
        stubs: s.stubs,
        trace: { events: chain.count, verified: chain.ok },
        keys: { anthropic: Boolean(s.config.secret("ANTHROPIC_API_KEY")), gemini: Boolean(s.config.secret("GEMINI_API_KEY")) }, // presence only, never values
      };
    }),

    route("GET", "/api/state", ANYONE, ({ role }) => {
      const consent = s.policy.consent();
      return {
        role,
        policy: s.policy.current(),
        policyHash: s.policy.hash(),
        consent: consent ?? null,
        needsConsent: !consent,
        approvals: s.gate.pendingApprovals().map((a) => approvalView(a, role)),
        receipts: s.gate.receipts().slice(-20).reverse(),
        spentToday: s.gate.spentToday(),
        trace: { events: s.trace.size, head: s.trace.last()?.hash ?? null, ...(role === "operator" ? { verify: s.trace.verify() } : {}) },
      };
    }),

    route("GET", "/api/events", ANYONE, ({ req, res, url, role }) => {
      let after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
      if (after > (s.trace.last()?.seq ?? 0)) after = 0;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 1000\n\n");
      res.write(`event: hello\ndata: ${JSON.stringify({ trace: s.trace.first()?.hash ?? null })}\n\n`);
      const send = (e: TraceEvent) => {
        if (role === "customer" && OPERATOR_ONLY.has(e.type)) return;
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      for (const e of s.trace.list(after)) send(e);
      const unsubscribe = s.trace.subscribe(send);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      ping.unref();
      const onReset = () => {
        res.write("event: reset\ndata: {}\n\n");
        res.end();
      };
      s.events.once("reset", onReset);
      req.on("close", () => {
        unsubscribe();
        clearInterval(ping);
        s.events.off("reset", onReset);
      });
    }),

    route("POST", "/api/chat", CUSTOMER, async ({ req, res, role }) => {
      const body = await readJson(req);
      const message = text(body.text, "text");
      const raw = body.inbound as { id?: unknown; text?: unknown } | undefined;
      const inbound = raw === undefined ? undefined : { id: typeof raw.id === "string" ? raw.id : undefined, text: text(raw.text, "inbound.text") };
      const turnId = typeof body.turnId === "string" ? body.turnId : newId("turn");
      await new Promise<void>((resolve) => {
        let responded = false;
        const respond = (status: number, payload: unknown) => {
          if (responded) return;
          responded = true;
          sendJson(res, status, payload);
          resolve();
        };
        const source: TurnSource = body.source === "desk" || body.source === "imessage" ? body.source : "app"; // turn_started.source
        runTurn(s, { turnId, text: message, inbound, source }, {
          onApprovalRequested: (approval) => respond(202, { turnId, status: "awaiting_approval", approval: approvalView(approval, role) }),
        }).then(
          (turn) => respond(200, { turnId, status: "done", replies: turn.replies }),
          (err: unknown) => {
            log(`turn ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`);
            respond(500, { error: "The turn failed inside the server." });
          },
        );
      });
    }),

    route("POST", "/api/actions", CUSTOMER, async ({ req, res, role }) => {
      const body = await readJson(req);
      const tool = text(body.tool, "tool", 100);
      const args = body.args ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "args must be an object.");
      const turnId = typeof body.turnId === "string" ? body.turnId : newId("turn");
      const source: TurnSource = body.source === "desk" || body.source === "imessage" ? body.source : "app";
      await new Promise<void>((resolve) => {
        let responded = false;
        const respond = (status: number, payload: unknown) => {
          if (responded) return;
          responded = true;
          sendJson(res, status, payload);
          resolve();
        };
        runActionTurn(s, { tool, args: args as Record<string, unknown>, turnId, source }, {
          onApprovalRequested: (approval) => respond(202, { status: "awaiting_approval", callId: approval.callId, turnId, agent: routeAction(tool), approval: approvalView(approval, role) }),
        }).then(
          (r) =>
            respond(200, "outcome" in r
              ? { callId: r.callId, turnId, agent: r.agent, reply: r.reply, ...outcomeView(r.outcome, role) }
              : { callId: r.callId, turnId, agent: r.agent, reply: r.reply, status: "refused", error: r.refused }),
          (err: unknown) => {
            log(`action in ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`);
            respond(500, { error: "The action failed inside the server." });
          },
        );
      });
    }),

    route("GET", "/api/approvals/:id", ANYONE, ({ params, role }) => {
      const approval = s.gate.approval(params.id!);
      if (!approval) throw new HttpError(404, "No such approval.");
      return { approval: approvalView(approval, role) };
    }),

    route("POST", "/api/approvals/:id", CUSTOMER, async ({ req, params }) => {
      const body = await readJson(req);
      if (typeof body.approve !== "boolean") throw new HttpError(400, "approve must be true or false.");
      const result = s.gate.answer(params.id!, body.approve, typeof body.code === "string" ? body.code : undefined, "app");
      if (result.ok) return { approval: result.request };
      const status = { not_found: 404, settled: 409, wrong_code: 400, locked: 409 }[result.problem];
      throw new HttpError(status, result.error, { problem: result.problem });
    }),

    route("GET", "/api/policy", ANYONE, () => ({
      policy: s.policy.current(),
      hash: s.policy.hash(),
      statement: s.policy.statement(),
      consent: s.policy.consent() ?? null,
      versions: s.policy.history().length,
    })),

    route("POST", "/api/policy", CUSTOMER, async ({ req }) => {
      const body = await readJson(req);
      const changes = body.changes as Record<string, unknown> | undefined;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new HttpError(400, "changes must be an object.");
      const unknown = Object.keys(changes).filter((k) => !POLICY_KEYS.has(k));
      if (unknown.length) throw new HttpError(400, `These policy fields cannot be changed here: ${unknown.join(", ")}.`);
      const policy = s.policy.update(changes as PolicyChanges, typeof body.note === "string" ? body.note : "");
      return { policy, hash: s.policy.hash(), statement: s.policy.statement(), needsConsent: !s.policy.consent() };
    }),

    route("POST", "/api/consent", CUSTOMER, async ({ req }) => {
      const body = await readJson(req);
      const current = s.policy.current().version;
      if (body.policyVersion !== current)
        throw new HttpError(409, `Consent must name the current policy version (${current}); review it and try again.`, { policyVersion: current });
      const channel = body.channel === "imessage" ? "imessage" : "app";
      return { consent: s.policy.recordConsent(channel) };
    }),

    route("GET", "/api/accounts", ANYONE, async () => {
      const result = await s.tools.get("bank.get_accounts")!.run({});
      if (!result.ok) throw new HttpError(502, result.error ?? "The bank did not answer.");
      const accounts = (result.data as Record<string, unknown>[]).map((a) => ({
        id: String(a.id ?? a._id),
        nickname: String(a.nickname ?? a.type ?? "Account"),
        kind: /saving/i.test(`${a.type ?? ""} ${a.nickname ?? ""}`) ? "savings" : "checking",
        last4: String(a.last4 ?? a.account_number ?? "").slice(-4),
        balance: Number(a.balance),
      }));
      return { accounts, stub: s.stubs.some((x) => x.startsWith("bank")) };
    }),

    route("GET", "/api/savings", ANYONE, async () => ({ report: await s.savings() })),

    route("GET", "/api/findings", ANYONE, () => currentFindings(s)),

    route("POST", "/api/agent/review", ANYONE, async ({ role }) => {
      const r = await reviewNow(s, { reason: "requested", source: role === "operator" ? "console" : "app" });
      return { turnId: r.turnId, reply: r.reply, findings: r.view.findings.length, areas: r.view.areas.length, view: r.view };
    }),

    route("GET", "/api/cashflow", ANYONE, async () => {
      const flow = await s.cashFlow(s.policy.current().ownAccounts[0] ?? "");
      if (!flow) throw new HttpError(404, "No checking account found.");
      return { cashFlow: flow };
    }),

    route("GET", "/api/imessage/phones", ANYONE, () => ({ phones: s.phones?.list() ?? [] })),

    route("GET", "/api/director", ANYONE, () => director().view()),
    route("POST", "/api/director/next", OPERATOR, async () => ({ entry: await director().step(), ...director().view() })),
    route("POST", "/api/director/restart", OPERATOR, async () => {
      await director().restart();
      return director().view();
    }),

    route("POST", "/api/imessage/phones/:id", OPERATOR, async ({ params }) => {
      if (!s.phones) throw new HttpError(404, "iMessage is off.");
      const ok = await s.phones.use(decodeURIComponent(params.id!));
      return { ok, phones: s.phones.list() };
    }),

    route("POST", "/api/nudges/run", OPERATOR, async () => {
      const r = await runReviewTurn(s, { reason: "a proactive check from the console", source: "console", nudge: true });
      return { nudges: r.nudges, turnId: r.turnId, reply: r.reply };
    }),

    route("GET", "/api/demo/scenes", ANYONE, () => ({ scenes: SCENES.map(({ id, title, summary }) => ({ id, title, summary })) })),

    route("GET", "/api/demo/personas", ANYONE, () => ({ personas: personaList(), current: s.persona ?? DEFAULT_PERSONA })),

    route("POST", "/api/demo/reset", OPERATOR, async ({ req }) => {
      const body = await readJson(req);
      const persona = body.persona === undefined ? undefined : text(body.persona, "persona", 40);
      if (persona !== undefined && !findPersona(persona)) throw new HttpError(400, new UnknownPersonaError(persona).message);
      if (persona !== undefined && persona !== DEFAULT_PERSONA && s.config.nessieMode !== "mock")
        throw new HttpError(409, "Personas are simulated households; they need NESSIE_MODE=mock.");
      resetServices(s, { persona });
      if (body.consent === true) s.policy.recordConsent("app");
      return { ok: true, persona: s.persona ?? DEFAULT_PERSONA, policyVersion: s.policy.current().version, consent: s.policy.consent() ?? null };
    }),

    route("POST", "/api/demo/scenes/:id", OPERATOR, ({ params, res }) => {
      const scene = SCENES.find((x) => x.id === params.id);
      if (!scene) throw new HttpError(404, `No scene ${params.id}.`);
      playScene(s, scene).catch((err: unknown) => log(`scene ${scene.id} failed: ${String(err)}`));
      sendJson(res, 202, { scene: scene.id, steps: scene.steps().length });
    }),

    route("POST", "/api/demo/replay/:id", OPERATOR, async ({ params }) => {
      const result = await replayApproval(s, params.id!);
      if ("error" in result) throw new HttpError(result.status, result.error);
      return result;
    }),

    route("GET", "/api/eval", ANYONE, () => {
      const file = path.join(SERVER_ROOT, "eval", "last-result.json");
      if (!fs.existsSync(file)) return { result: null };
      return { result: JSON.parse(fs.readFileSync(file, "utf8")) as unknown };
    }),

    route("GET", "/api/audit/verify", OPERATOR, () => ({ ...s.trace.verify({ full: true }), head: s.trace.last()?.hash ?? null })),

    route("GET", "/api/tools", ANYONE, () => ({ tools: s.tools.specs() })),

    route("GET", "/api/research/skills", ANYONE, () => researchPack({ secLive: Boolean(s.config.secret("SEC_USER_AGENT")) })),

    route("POST", "/api/research/brief", ANYONE, async ({ req }) => {
      const body = await readJson(req);
      return buildResearchBrief(s, { query: text(body.query, "query", 200) });
    }),

    route("POST", "/api/documents/review", ANYONE, async ({ req }) => {
      const body = await readJson(req);
      const kind = body.kind === undefined || body.kind === null || body.kind === "" ? undefined : body.kind;
      if (kind !== undefined && !DOCUMENT_KINDS.includes(kind as DocumentKind)) throw new HttpError(400, `kind must be one of ${DOCUMENT_KINDS.join(", ")}, or left out to classify the document.`);
      const r = await runDocumentTurn(s, {
        text: text(body.text, "text", MAX_DOCUMENT_CHARS),
        ...(kind ? { kind: kind as DocumentKind } : {}),
        source: documentSource(body.source),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
      });
      return { finding: r.finding, turnId: r.turnId, reply: r.reply, kind: r.kind, marks: r.marks };
    }),

    route("GET", "/api/documents/samples", ANYONE, () => documentSamples()),

    route("POST", "/api/contracts/review", ANYONE, async ({ req }) => {
      const body = await readJson(req);
      const r = await runDocumentTurn(s, { text: text(body.text, "text", MAX_DOCUMENT_CHARS), kind: "contract", source: documentSource(body.source), ...(typeof body.name === "string" ? { name: body.name } : {}) });
      return { finding: r.finding, turnId: r.turnId, reply: r.reply, clauses: r.clauses };
    }),

    route("GET", "/api/db/stats", OPERATOR, () => {
      if (!s.db) throw new HttpError(503, "The read model is not available.");
      return { stats: s.db.stats(), recentReceipts: s.db.recentReceipts(10) };
    }),

    route("GET", "/api/metrics", OPERATOR, () => ({
      ...(s.metrics?.snapshot() ?? {}),
      agent: {
        name: s.agent.name,
        mode: s.config.agentMode,
        ...(s.config.agentMode === "claude" ? { model: s.config.llmModel } : {}),
        recentFallbacks: "recentFallbacks" in s.agent && typeof s.agent.recentFallbacks === "function" ? (s.agent.recentFallbacks as () => unknown[])() : [],
      },
    })),
  ];

  return async (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD") && serveWeb(s.config.webDist, url.pathname, res, req)) return;
    let routeKey = "unmatched"; // route template, not the raw path, so the metric names stay bounded
    res.on("finish", () => {
      const ms = performance.now() - started;
      s.metrics?.observe(`http:${routeKey}`, ms);
      log(`${req.method} ${url.pathname} ${res.statusCode} ${Math.round(ms)}ms`);
    });
    try {
      const role = roleOf(req, url);
      const candidates = routes.filter((r) => r.pattern.test(url.pathname));
      if (candidates.length === 0) throw new HttpError(404, `No route for ${url.pathname}.`);
      const match = candidates.find((r) => r.method === req.method);
      if (!match) throw new HttpError(405, `${req.method} is not supported on ${url.pathname}.`);
      routeKey = `${match.method} ${match.path}`;
      if (!match.roles.includes(role)) throw new HttpError(403, `The ${role} role cannot use ${match.method} ${match.path}.`);
      const params = { ...(match.pattern.exec(url.pathname)?.groups ?? {}) };
      const ctx: Ctx = { req, res, url, params, role };
      const out = await match.handle(ctx);
      if (!res.headersSent && out !== undefined) sendJson(res, 200, out);
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...err.details });
      if (err instanceof PolicyError) return sendJson(res, 400, { error: err.message, problems: err.problems });
      log(`500 ${req.method} ${url.pathname}: ${err instanceof Error ? err.stack : String(err)}`);
      sendJson(res, 500, { error: "Internal server error." });
    }
  };
}
