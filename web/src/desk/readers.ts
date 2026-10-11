import type { Area, Finding } from "@contracts";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const first = <T>(...xs: (T | undefined)[]): T | undefined => xs.find((x) => x !== undefined);

const AREAS: Area[] = ["everyday", "bills", "subscriptions", "investments", "loans", "contracts", "protection"];

export function asFinding(x: unknown): Finding | null {
  if (!isObj(x) || !str(x.id) || !str(x.title)) return null;
  const tone = ["save", "info", "warn", "block"].includes(String(x.tone)) ? (x.tone as Finding["tone"]) : "info";
  const area = AREAS.includes(x.area as Area) ? (x.area as Area) : "investments";
  return {
    ...(x as unknown as Finding),
    area,
    tone,
    summary: str(x.summary) ?? "",
    evidence: arr(x.evidence).filter(isObj) as unknown as Finding["evidence"],
    citations: arr(x.citations).filter(isObj) as unknown as Finding["citations"],
    simulated: x.simulated === true,
    from: (str(x.from) as Finding["from"]) ?? "research",
    createdAt: str(x.createdAt) ?? new Date(0).toISOString(),
  };
}

function findingsIn(raw: Obj): Finding[] {
  const inner = isObj(raw.brief) ? raw.brief : isObj(raw.view) ? raw.view : isObj(raw.review) ? raw.review : raw;
  const list = [...arr(inner.findings), ...arr(raw.findings !== inner.findings ? raw.findings : [])];
  if (isObj(inner.finding)) list.unshift(inner.finding);
  if (isObj(raw.finding) && raw.finding !== inner.finding) list.unshift(raw.finding);
  const seen = new Set<string>();
  return list.map(asFinding).filter((f): f is Finding => {
    if (!f || seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || undefined;
  }
}

export interface BriefStep {
  skill: string;
  host?: string;
  status: "ok" | "running" | "failed" | "skipped" | "blocked" | string;
  ms?: number;
  note?: string;
}

export interface Reference {
  id: string;
  title: string;
  url?: string;
}

export interface Brief {
  id?: string;
  title: string;
  subject?: string;
  steps: BriefStep[];
  findings: Finding[];
  references: Reference[];
  notes: string[];
  simulated: boolean;
  generatedAt?: string;
  traceSeq?: number;
}

function readStep(x: unknown): BriefStep | null {
  if (!isObj(x)) return null;
  const skill = first(str(x.skill), str(x.name), str(x.id), str(x.tool));
  if (!skill) return null;
  const hosts = arr(x.hosts).map(str).filter(Boolean) as string[];
  const host = first(str(x.host), str(x.sourceHost), hostOf(str(x.url)), hostOf(str(x.source)), hosts.join(", ") || undefined);
  const status = first(str(x.status), x.ok === true ? "ok" : x.ok === false ? "failed" : undefined) ?? "ok";
  return { skill, host, status, ms: first(num(x.ms), num(x.latencyMs), num(x.durationMs), num(x.elapsedMs)), note: first(str(x.detail), str(x.note), str(x.error), str(x.reason), str(x.summary)) };
}

export function readBrief(raw: Obj, query: string): Brief {
  const b = isObj(raw.brief) ? raw.brief : raw;
  const co = isObj(b.company) ? b.company : isObj(b.subject) ? b.subject : undefined;
  const subject = co ? first(str(co.name), str(co.ticker)) : str(b.subject);
  const ticker = co ? str(co.ticker) : str(b.ticker);
  const findings = findingsIn(raw);
  const references = [...arr(b.references), ...arr(raw.references !== b.references ? raw.references : [])]
    .map((r): Reference | null => (isObj(r) && (str(r.title) || str(r.url)) ? { id: str(r.id) ?? str(r.url) ?? String(r.title), title: str(r.title) ?? str(r.url)!, url: str(r.url) } : null))
    .filter((r): r is Reference => r !== null);
  return {
    id: first(str(b.turnId), str(b.id), str(raw.id)),
    title: first(str(b.title), subject && ticker && subject !== ticker ? `${subject} (${ticker})` : subject) ?? query,
    subject,
    steps: [...arr(b.steps), ...arr(b.trace), ...arr(b.skills), ...arr(raw.steps !== b.steps ? raw.steps : [])].map(readStep).filter((s): s is BriefStep => s !== null),
    findings,
    references,
    notes: [...arr(b.notes), ...arr(b.caveats), str(b.note), str(b.disclaimer)].map(str).filter(Boolean) as string[],
    simulated: b.simulated === true || findings.some((f) => f.simulated),
    generatedAt: first(str(b.generatedAt), str(b.createdAt)),
    traceSeq: first(num(b.traceSeq), num(raw.traceSeq)),
  };
}

export interface SkillTool {
  name: string;
  description?: string;
  hosts: string[];
  mode?: string;
  effect?: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
  publisher?: string;
  version?: string;
  status?: string;
  hash?: string;
  summary?: string;
  capabilities: { capability: string; approval?: string; maxAmount?: number }[];
  reads: string[];
  hosts: string[];
  writes: string[];
  effects: string[];
  moneyFields: string[];
  tools: SkillTool[];
}

function strings(x: unknown): string[] {
  return arr(x)
    .map((v) => (isObj(v) ? first(str(v.host), str(v.name), str(v.id), str(v.label)) : str(v)))
    .filter(Boolean) as string[];
}

export function readSkills(raw: Obj): SkillInfo[] {
  const list = Array.isArray(raw) ? raw : arr(raw.skills).length ? arr(raw.skills) : arr(raw.items).length ? arr(raw.items) : isObj(raw.manifest) || str(raw.name) ? [raw] : [];
  return list
    .map((x): SkillInfo | null => {
      if (!isObj(x)) return null;
      const m = isObj(x.manifest) ? { ...x, ...x.manifest } : x;
      const name = first(str(m.name), str(m.id));
      if (!name) return null;
      const caps = arr(m.capabilities).map((c) =>
        isObj(c) ? { capability: str(c.capability) ?? str(c.name) ?? "unknown", approval: str(c.approval), maxAmount: num(c.maxAmount) } : { capability: String(c) },
      );
      const net = isObj(m.network) ? m.network : {};
      return {
        name,
        description: str(m.description),
        publisher: str(m.publisher),
        version: str(m.version),
        status: first(str(x.status), str(m.status), x.enabled === true ? "enabled" : x.enabled === false ? "off" : undefined),
        hash: first(str(x.sha256), str(m.sha256), str(m.hash)),
        capabilities: caps,
        reads: [...strings(m.reads), ...strings(m.data), ...strings(m.scopes)],
        hosts: [...new Set([...strings(x.hosts), ...strings(m.hosts), ...strings(m.allowedHosts), ...strings(m.sources), ...strings(net.hosts), ...strings(net.allow)])],
        writes: strings(m.writes),
        summary: str(x.summary),
        effects: strings(x.effects),
        moneyFields: strings(x.moneyFields),
        tools: arr(x.tools)
          .filter(isObj)
          .map((t) => ({ name: str(t.name) ?? "tool", description: str(t.description), hosts: strings(t.hosts), mode: str(t.mode), effect: str(t.effect) })),
      };
    })
    .filter((s): s is SkillInfo => s !== null);
}

export interface ContractReview {
  findings: Finding[];
  notes: string[];
}

export function readContract(raw: Obj): ContractReview {
  const r = isObj(raw.review) ? raw.review : raw;
  return { findings: findingsIn(raw), notes: [str(raw.reply), str(r.note), str(r.summary), str(r.disclaimer)].filter(Boolean) as string[] };
}
