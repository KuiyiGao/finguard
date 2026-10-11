import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { sendNudges } from "../src/agent/nudges.ts";
import { runTurn } from "../src/agent/turn.ts";
import { loadConfig } from "../src/config.ts";
import { PERSONAS, type Persona, type TurnExpect } from "../src/demo/personas.ts";
import { buildServices, type Services } from "../src/services.ts";
import type { ApprovalRequest, AuthorizationReceipt, Decision, RiskLevel, ScamAssessment, ToolCall, Verdict } from "../src/types.ts";
import { newId } from "../src/util.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULT_FILE = path.join(here, "..", "eval", "parallel-result.json");

export interface Observed {
  tool: string | null;
  verdict?: Verdict;
  status?: "executed" | "denied" | "not_approved" | "blocked" | "failed";
  receipt?: "standing_instruction" | "approval";
  reasons: string[];
  scamRisk?: RiskLevel;
  alerts: string[];
  approvals: number;
}

export interface StepResult {
  step: number;
  label: string;
  ok: boolean;
  ms: number;
  problems: string[];
  got: Observed | { nudges: string[] };
}

export interface SessionResult {
  id: string;
  persona: string;
  ok: boolean;
  steps: StepResult[];
  chain: { ok: boolean; events: number; reason?: string };
  error?: string;
}

export interface Failure {
  session: string;
  persona: string;
  step: number | null;
  label: string;
  problems: string[];
}

export interface ParallelResult {
  ranAt: string;
  sessions: number;
  turns: number;
  passed: number;
  failed: number;
  failures: Failure[];
  latencyMs: { p50: number; p95: number; max: number };
  throughputTurnsPerSec: number;
  byPersona: Record<string, { passed: number; total: number }>;
  checks: { passed: number; total: number };
  repeat: number;
  wallMs: number;
  results?: SessionResult[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const RISK_ORDER: RiskLevel[] = ["high", "medium", "low"];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function observe(s: Services, turnId: string, approvals: number): Observed {
  const events = s.trace.list().filter((e) => e.turnId === turnId);
  const of = <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.data as T);
  const call = of<ToolCall>("tool_proposed").filter((c) => s.tools.spec(c.tool)?.effect !== "read").at(-1);
  const decision = call && of<Decision>("decision").find((d) => d.callId === call.id);
  const executed = call && of<{ callId: string; ok: boolean }>("tool_executed").find((x) => x.callId === call.id);
  const receipt = call && of<AuthorizationReceipt>("receipt_issued").find((r) => r.callId === call.id);
  const resolved = call && of<{ callId: string; status: string }>("approval_resolved").find((r) => r.callId === call.id);
  const status: Observed["status"] = !call
    ? undefined
    : executed?.ok
      ? "executed"
      : decision?.verdict === "deny"
        ? "denied"
        : resolved && resolved.status !== "approved"
          ? "not_approved"
          : executed
            ? "failed"
            : "blocked";
  const risks = new Set(of<ScamAssessment>("scam_assessed").map((a) => a.risk));
  return {
    tool: call?.tool ?? null,
    verdict: decision?.verdict,
    status,
    receipt: receipt?.authorizedBy.kind,
    reasons: decision?.reasons.map((r) => `${r.rule}:${r.verdict}`) ?? [],
    scamRisk: RISK_ORDER.find((r) => risks.has(r)),
    alerts: of<{ to: string | null }>("alert_sent").map((a) => a.to ?? "(nobody)"),
    approvals,
  };
}

export function check(want: TurnExpect, got: Observed): string[] {
  const problems: string[] = [];
  if (want.tool !== undefined && got.tool !== want.tool) problems.push(`expected ${want.tool ?? "no money tool"}, got ${got.tool ?? "no money tool"}`);
  if (want.verdict !== undefined) {
    const allowed = [want.verdict].flat();
    if (!got.verdict || !allowed.includes(got.verdict)) problems.push(`expected verdict ${allowed.join(" or ")}, got ${got.verdict ?? "none"}`);
  }
  if (want.status && got.status !== want.status) problems.push(`expected ${want.status}, got ${got.status ?? "nothing"}`);
  if (want.receipt && got.receipt !== want.receipt) problems.push(`expected a ${want.receipt} receipt, got ${got.receipt ?? "none"}`);
  for (const [rule, verdict] of Object.entries(want.rules ?? {})) {
    if (!got.reasons.includes(`${rule}:${verdict}`))
      problems.push(`expected a ${rule} reason that says ${verdict}, got ${got.reasons.filter((r) => r.startsWith(`${rule}:`)).join(", ") || "none"}`);
  }
  if (want.scamRisk && got.scamRisk !== want.scamRisk) problems.push(`expected ScamShield to rate it ${want.scamRisk}, got ${got.scamRisk ?? "no rating"}`);
  if (want.alert !== undefined && !got.alerts.includes(want.alert)) problems.push(`expected ${want.alert} to be alerted, got ${got.alerts.join(", ") || "no alert"}`);
  if (want.alert === undefined && got.alerts.length) problems.push(`did not expect an alert, got one to ${got.alerts.join(", ")}`);
  if (got.status === "executed" && got.verdict === "deny") problems.push("a denied action ran"); // never, whatever the script says
  return problems;
}

export async function runSession(persona: Persona, n = 1): Promise<SessionResult> {
  const id = `${persona.id}#${n}`;
  const steps: StepResult[] = [];
  let s: Services | undefined;
  try {
    s = buildServices(loadConfig({}), { persist: false, persona: persona.id });
    s.policy.recordConsent("app"); // the customer agreed to their policy, as after onboarding
    for (const [i, step] of persona.session().entries()) {
      const started = performance.now();
      if ("nudges" in step) {
        const kinds = (await sendNudges(s)).map((x) => x.kind);
        const problems = [
          ...step.nudges.include.filter((k) => !kinds.includes(k)).map((k) => `expected a ${k} nudge`),
          ...(step.nudges.exclude ?? []).filter((k) => kinds.includes(k)).map((k) => `did not expect a ${k} nudge`),
        ];
        steps.push({ step: i + 1, label: step.label, ok: problems.length === 0, ms: round2(performance.now() - started), problems, got: { nudges: kinds } });
        continue;
      }
      const turnId = newId("turn");
      const approve = step.answer === "approve";
      let approvals = 0;
      const live = s;
      await runTurn(live, { turnId, text: step.text, ...(step.inbound ? { inbound: { text: step.inbound } } : {}) }, {
        onApprovalRequested: (a: ApprovalRequest) => {
          approvals += 1;
          setImmediate(() => live.gate.answer(a.id, approve, approve ? a.code : undefined, "app"));
        },
      });
      const ms = round2(performance.now() - started);
      const got = observe(live, turnId, approvals);
      const problems = check(step.expect, got);
      steps.push({ step: i + 1, label: step.label, ok: problems.length === 0, ms, problems, got });
    }
    const verified = s.trace.verify({ full: true });
    const chain = verified.ok ? { ok: true, events: verified.count } : { ok: false, events: verified.count, reason: `event ${verified.badSeq}: ${verified.reason}` };
    return { id, persona: persona.id, ok: chain.ok && steps.every((x) => x.ok), steps, chain };
  } catch (err) {
    return { id, persona: persona.id, ok: false, steps, chain: { ok: false, events: s?.trace.size ?? 0, reason: "session stopped early" }, error: err instanceof Error ? err.message : String(err) };
  } finally {
    s?.db?.close();
  }
}

export async function runParallel({
  repeat = 1,
  personas = PERSONAS,
  outFile = RESULT_FILE as string | null,
  detail = false,
}: { repeat?: number; personas?: readonly Persona[]; outFile?: string | null; detail?: boolean } = {}): Promise<ParallelResult> {
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("repeat must be a positive integer");
  const started = performance.now();
  const results = await Promise.all(personas.flatMap((p) => Array.from({ length: repeat }, (_, i) => runSession(p, i + 1))));
  const wallMs = performance.now() - started;

  const steps = results.flatMap((r) => r.steps);
  const times = steps.map((x) => x.ms).sort((a, b) => a - b);
  const failures: Failure[] = results.flatMap((r) => [
    ...r.steps.filter((x) => !x.ok).map((x) => ({ session: r.id, persona: r.persona, step: x.step, label: x.label, problems: x.problems })),
    ...(r.chain.ok ? [] : [{ session: r.id, persona: r.persona, step: null, label: "audit chain verifies", problems: [r.error ?? r.chain.reason ?? "the chain did not verify"] }]),
  ]);
  const byPersona: ParallelResult["byPersona"] = {};
  for (const r of results) {
    const bucket = (byPersona[r.persona] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (r.ok) bucket.passed += 1;
  }
  const passed = results.filter((r) => r.ok).length;
  const result: ParallelResult = {
    ranAt: new Date().toISOString(),
    sessions: results.length,
    turns: steps.length,
    passed,
    failed: results.length - passed,
    failures,
    latencyMs: { p50: percentile(times, 50), p95: percentile(times, 95), max: times.at(-1) ?? 0 },
    throughputTurnsPerSec: wallMs > 0 ? round2(steps.length / (wallMs / 1000)) : 0,
    byPersona,
    checks: { passed: steps.filter((x) => x.ok).length + results.filter((r) => r.chain.ok).length, total: steps.length + results.length },
    repeat,
    wallMs: round2(wallMs),
  };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
  return detail ? { ...result, results } : result;
}

export function scorecard(r: ParallelResult): string {
  const personas = Object.keys(r.byPersona).length;
  const lines = [
    `FinGuard parallel personas: ${r.passed}/${r.sessions} sessions passed (${personas} personas x ${r.repeat}, all concurrent, each on its own in-memory services)`,
    "",
    `${"persona".padEnd(12)}sessions passed`,
  ];
  for (const [id, b] of Object.entries(r.byPersona)) lines.push(`${id.padEnd(12)}${`${b.passed}/${b.total}`.padStart(15)}`);
  lines.push(
    "",
    `checks: ${r.checks.passed}/${r.checks.total} (every scripted turn plus each session's audit chain)`,
    `turns: ${r.turns} in ${(r.wallMs / 1000).toFixed(2)} s -> ${r.throughputTurnsPerSec.toFixed(1)} turns/s`,
    `turn latency under load: p50 ${r.latencyMs.p50.toFixed(1)} ms, p95 ${r.latencyMs.p95.toFixed(1)} ms, max ${r.latencyMs.max.toFixed(1)} ms`,
    "",
    r.failures.length ? `Failures (${r.failures.length}):` : "No failures.",
  );
  for (const f of r.failures.slice(0, 25)) lines.push(`  ${f.session} step ${f.step ?? "-"} (${f.label})`, ...f.problems.map((p) => `    ${p}`));
  if (r.failures.length > 25) lines.push(`  ... and ${r.failures.length - 25} more in the result file`);
  return lines.join("\n");
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i]!.includes("=") ? args[i]!.slice(name.length + 1) : args[i + 1];
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repeat = Number(argValue(args, "--repeat") ?? 1);
  const outFile = path.resolve(argValue(args, "--out") ?? RESULT_FILE);
  const result = await runParallel({ repeat, outFile });
  console.log(scorecard(result));
  console.log(`\nWrote ${path.relative(process.cwd(), outFile) || outFile}`);
  if (result.failed > 0) process.exitCode = 1;
}
