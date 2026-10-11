
export type ParticleMode = "idle" | "gather" | "stream" | "scan" | "pass" | "stop" | "burst";
export type ParticleTone = "trusted" | "untrusted" | "ok" | "warn" | "bad" | "neutral";
export type Anchor = string | HTMLElement | null | undefined;

export interface FieldOptions {
  mode: ParticleMode;
  tone: ParticleTone;
  from: Anchor;
  to: Anchor;
  intensity: number;
}

const GLOW = 0;
const SPARK = 1;
const STAR = 2;
const RING = 3;
const MAGIC = 4;
const TRACE = 5;
const TEX_FILES = ["glow", "spark", "star", "ring", "magic", "trace"];
const TEX_SIZE = 64;

const images: (HTMLImageElement | null)[] = TEX_FILES.map(() => null);
const tinted = new Map<string, HTMLCanvasElement>();
const loadSubs = new Set<() => void>();
let loading = false;

function loadTextures(): void {
  if (loading || typeof Image === "undefined") return;
  loading = true;
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");
  TEX_FILES.forEach((name, i) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      images[i] = img;
      tinted.clear();
      loadSubs.forEach((fn) => fn());
    };
    img.src = `${base}particles/${name}.png`;
  });
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function procedural(tex: number): HTMLCanvasElement {
  const c = makeCanvas(TEX_SIZE, TEX_SIZE);
  const g = c.getContext("2d")!;
  const m = TEX_SIZE / 2;
  if (tex === RING) {
    g.strokeStyle = "#fff";
    g.lineWidth = 4;
    g.shadowColor = "#fff";
    g.shadowBlur = 6;
    g.beginPath();
    g.arc(m, m, m - 8, 0, Math.PI * 2);
    g.stroke();
    return c;
  }
  const r = g.createRadialGradient(m, m, 0, m, m, m);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(tex === GLOW || tex === MAGIC ? 0.35 : 0.18, "rgba(255,255,255,0.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  if (tex === SPARK) g.setTransform(1, 0, 0, 0.22, 0, m * 0.78);
  if (tex === TRACE) g.setTransform(0.22, 0, 0, 1, m * 0.78, 0);
  g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  return c;
}

function sprite(tex: number, color: string, dark: boolean): HTMLCanvasElement {
  const key = `${tex}|${color}|${dark ? 1 : 0}`;
  const hit = tinted.get(key);
  if (hit) return hit;
  const src: CanvasImageSource = images[tex] ?? procedural(tex);
  const c = makeCanvas(TEX_SIZE, TEX_SIZE);
  const g = c.getContext("2d")!;
  g.drawImage(src, 0, 0, TEX_SIZE, TEX_SIZE);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  if (tex !== RING) {
    const s = TEX_SIZE * 0.5;
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = dark ? 0.55 : 0.8;
    g.drawImage(dark ? src : c, (TEX_SIZE - s) / 2, (TEX_SIZE - s) / 2, s, s);
  }
  tinted.set(key, c);
  return c;
}

const TONES: ParticleTone[] = ["trusted", "untrusted", "ok", "warn", "bad", "neutral"];
const TONE_VARS: Record<ParticleTone, [string, string]> = {
  trusted: ["--origin-system", "--origin-user"],
  untrusted: ["--origin-inbound", "--origin-tooltext"],
  ok: ["--allow", "--origin-system"],
  warn: ["--ask", "--origin-tooltext"],
  bad: ["--deny", "--origin-inbound"],
  neutral: ["--brand", "--origin-user"],
};
const FALLBACK: Record<ParticleTone, [string, string]> = {
  trusted: ["#4fc1aa", "#7aa2f7"],
  untrusted: ["#f2766b", "#f0a35e"],
  ok: ["#4cc38a", "#4fc1aa"],
  warn: ["#f0a640", "#f0a35e"],
  bad: ["#f2766b", "#f2766b"],
  neutral: ["#3fb6a0", "#7aa2f7"],
};

const ORBIT = 1;
const PATH = 2;
const FREE = 3;
const END_ABSORB = 0;
const END_CONTINUE = 1;
const END_BOUNCE = 2;
const EASE_LINEAR = 0;
const EASE_INOUT = 1;
const EASE_IN = 2;
const EASE_OUT = 3;
const CAP = 160;

class P {
  live = false;
  kind = FREE;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  ax = 0;
  ay = 0;
  cx = 0;
  cy = 0;
  bx = 0;
  by = 0;
  u = 0;
  du = 1;
  ease = EASE_LINEAR;
  lane = 0;
  width = 0;
  end = END_ABSORB;
  ang = 0;
  rad = 0;
  spin = 0;
  ph = 0;
  blend = 1;
  bt = 0;
  sx = 0;
  sy = 0;
  svx = 0;
  svy = 0;
  drag = 0;
  g = 0;
  age = 0;
  ttl = 1;
  size = 8;
  tex = GLOW;
  tone = 0;
  ci = 0;
  alpha = 1;
  trail = 0;
  pop = 0;
  shrink = false;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Flash {
  x: number;
  y: number;
  age: number;
  ttl: number;
  s0: number;
  s1: number;
  tex: number;
  tone: number;
  ci: number;
  a: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const easeOut3 = (t: number) => 1 - Math.pow(1 - t, 3);

function eased(kind: number, u: number): number {
  if (kind === EASE_INOUT) return smooth(u);
  if (kind === EASE_IN) return u * u;
  if (kind === EASE_OUT) return 1 - (1 - u) * (1 - u);
  return u;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export class Field {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private pool: P[] = Array.from({ length: CAP }, () => new P());
  private flashes: Flash[] = [];
  private opts: FieldOptions = { mode: "idle", tone: "neutral", from: null, to: null, intensity: 0.6 };
  private started = false;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private k = 1;
  private calm = 1;
  private fromEl: HTMLElement | null = null;
  private toEl: HTMLElement | null = null;
  private fromBox: Box | null = null;
  private toBox: Box | null = null;
  private colors: string[][] = TONES.map((t) => [...FALLBACK[t]]);
  private dark = false;
  private reduced = reducedMotion();
  private visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  private inView = true;
  private raf = 0;
  private last = 0;
  private time = 0;
  private modeT = 0;
  private acc = 0;
  private sinceMeasure = 0;
  private sinceImpact = 0;
  private settled = false;
  private halo = 0;
  private haloTone = 5;
  private haloPrev = 5;
  private haloMix = 1;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private mqDark: MediaQueryList | null = null;
  private mqMotion: MediaQueryList | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    loadTextures();
    loadSubs.add(this.onTextures);
    if (typeof ResizeObserver === "function") {
      this.ro = new ResizeObserver(() => this.measure(true));
      this.ro.observe(canvas);
    }
    if (typeof IntersectionObserver === "function") {
      this.io = new IntersectionObserver((entries) => {
        this.inView = entries.some((e) => e.isIntersecting);
        this.wake();
      });
      this.io.observe(canvas);
    }
    if (typeof MutationObserver === "function") {
      this.mo = new MutationObserver(this.onTheme);
      this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    }
    if (typeof window.matchMedia === "function") {
      this.mqDark = window.matchMedia("(prefers-color-scheme: dark)");
      this.mqDark.addEventListener("change", this.onTheme);
      this.mqMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.mqMotion.addEventListener("change", this.onMotion);
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.readTheme();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    loadSubs.delete(this.onTextures);
    this.ro?.disconnect();
    this.io?.disconnect();
    this.mo?.disconnect();
    this.mqDark?.removeEventListener("change", this.onTheme);
    this.mqMotion?.removeEventListener("change", this.onMotion);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  set(next: FieldOptions): void {
    const prev = this.opts;
    this.opts = { ...next, intensity: clamp(Number.isFinite(next.intensity) ? next.intensity : 0.6, 0, 1) };
    const anchorsChanged = prev.from !== next.from || prev.to !== next.to;
    if (!this.started || anchorsChanged) this.measure(true);
    const toneIndex = Math.max(0, TONES.indexOf(this.opts.tone));
    if (toneIndex !== this.haloTone) {
      this.haloPrev = this.haloTone;
      this.haloTone = toneIndex;
      this.haloMix = this.started ? 0 : 1;
    }
    if (!this.started) {
      this.started = true;
      this.enter(this.opts.mode, true);
    } else if (prev.mode !== next.mode || anchorsChanged) {
      this.enter(this.opts.mode, false);
    }
    if (this.reduced) this.drawStill();
    this.wake();
  }

  private onTextures = () => {
    if (this.reduced) this.drawStill();
  };

  private onTheme = () => {
    this.readTheme();
    if (this.reduced) this.drawStill();
  };

  private onMotion = () => {
    this.reduced = reducedMotion();
    if (this.reduced) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.drawStill();
    } else this.wake();
  };

  private onVisibility = () => {
    this.visible = document.visibilityState !== "hidden";
    this.wake();
  };

  private readTheme(): void {
    const cs = getComputedStyle(this.canvas);
    this.colors = TONES.map((t) => TONE_VARS[t].map((v, i) => cs.getPropertyValue(v).trim() || FALLBACK[t][i]!));
    const scheme = getComputedStyle(document.documentElement).colorScheme || "";
    this.dark = scheme.includes("dark");
  }

  private resolve(a: Anchor): HTMLElement | null {
    if (!a) return null;
    if (typeof a !== "string") return a.isConnected ? a : null;
    const parent = this.canvas.parentElement;
    if (!parent) return null;
    try {
      return parent.querySelector<HTMLElement>(a);
    } catch {
      return null;
    }
  }

  private measure(force = false): void {
    if (!force && this.sinceMeasure < 0.3) return;
    this.sinceMeasure = 0;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.k = clamp(Math.min(w, h) / 170, 0.42, 1.15);
      this.calm = clamp(Math.sqrt(w * h) / 180, 0.5, 1);
    }
    const fromEl = this.resolve(this.opts.from);
    const toEl = this.resolve(this.opts.to);
    if (fromEl !== this.fromEl || toEl !== this.toEl) {
      for (const el of [this.fromEl, this.toEl]) if (el && el !== fromEl && el !== toEl) this.ro?.unobserve(el);
      for (const el of [fromEl, toEl]) if (el && el !== this.fromEl && el !== this.toEl) this.ro?.observe(el);
      this.fromEl = fromEl;
      this.toEl = toEl;
    }
    const box = (el: HTMLElement | null): Box | null => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (!b.width && !b.height) return null;
      return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
    };
    this.fromBox = box(fromEl);
    this.toBox = box(toEl);
    if (this.reduced && force && this.started && this.w && this.h) this.drawStill();
  }

  private shouldRun(): boolean {
    return this.started && !this.reduced && this.visible && this.inView && !!this.ctx;
  }

  private wake(): void {
    if (this.raf || !this.shouldRun()) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (!this.shouldRun()) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.sinceMeasure += dt;
    this.measure();
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  };

  private oneAnchor(): boolean {
    const m = this.opts.mode;
    return !this.toBox && !!this.fromBox && (m === "idle" || m === "pass" || m === "stop" || m === "burst");
  }

  private target(): Box {
    if (this.toBox) return this.toBox;
    if (this.oneAnchor()) return this.fromBox!;
    return { x: this.w / 2 - 20, y: this.h / 2 - 20, w: 40, h: 40 };
  }

  private source(): Box {
    if (this.fromBox && !this.oneAnchor()) return this.fromBox;
    const t = this.target();
    const cx = t.x + t.w / 2;
    const reach = Math.max(48, this.w * 0.28);
    const sx = cx - reach >= 8 ? cx - reach : Math.min(this.w - 8, cx + reach);
    return { x: sx - 10, y: t.y + t.h / 2 - 10, w: 20, h: 20 };
  }

  private center(b: Box): [number, number] {
    return [b.x + b.w / 2, b.y + b.h / 2];
  }

  private take(): P | null {
    for (const p of this.pool) if (!p.live) return p;
    return null;
  }

  private count(kind?: number): number {
    let n = 0;
    for (const p of this.pool) if (p.live && (kind === undefined || p.kind === kind)) n++;
    return n;
  }

  private born(p: P, tex: number, size: number, ttl: number): P {
    p.live = true;
    p.age = 0;
    p.ttl = ttl;
    p.tex = tex;
    p.size = size * this.k * 1.45;
    p.tone = Math.max(0, TONES.indexOf(this.opts.tone));
    p.ci = Math.random() < 0.72 ? 0 : 1;
    p.alpha = rand(0.7, 1);
    p.trail = 0;
    p.pop = 0;
    p.shrink = false;
    p.blend = 1;
    p.bt = 0;
    p.vx = 0;
    p.vy = 0;
    p.ph = rand(0, Math.PI * 2);
    return p;
  }

  private retire(p: P, within = 0.3): void {
    p.ttl = Math.min(p.ttl, p.age + within);
  }

  private flash(x: number, y: number, s0: number, s1: number, ttl: number, tex: number, a: number, tone = this.haloTone): void {
    if (this.flashes.length > 10) this.flashes.shift();
    this.flashes.push({ x, y, age: 0, ttl, s0, s1, tex, tone, ci: 0, a });
  }

  private pathFrom(p: P, bx: number, by: number, opts: { secs: number; bend?: number; ease?: number; end?: number; lane?: number; width?: number }): void {
    const ax = p.x;
    const ay = p.y;
    const dx = bx - ax;
    const dy = by - ay;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist;
    const ny = dx / dist;
    const speed = Math.hypot(p.vx, p.vy);
    let cx = (ax + bx) / 2 + nx * (opts.bend ?? 0) * dist;
    let cy = (ay + by) / 2 + ny * (opts.bend ?? 0) * dist;
    if (speed > 30) {
      const reach = Math.min(dist * 0.5, speed * opts.secs * 0.35);
      cx = cx * 0.4 + (ax + (p.vx / speed) * reach) * 0.6;
      cy = cy * 0.4 + (ay + (p.vy / speed) * reach) * 0.6;
    }
    p.kind = PATH;
    p.ax = ax;
    p.ay = ay;
    p.cx = cx;
    p.cy = cy;
    p.bx = bx;
    p.by = by;
    p.u = 0;
    p.du = 1 / Math.max(0.15, opts.secs);
    p.ease = opts.ease ?? EASE_LINEAR;
    p.end = opts.end ?? END_ABSORB;
    p.lane = opts.lane ?? 0;
    p.width = opts.width ?? 0;
    p.blend = 1;
    if (p.ttl < p.age + opts.secs + 0.2) p.ttl = p.age + opts.secs + 1.5;
  }

  private toOrbit(p: P, fresh: boolean): void {
    const t = this.target();
    const [cx, cy] = this.center(t);
    const base = Math.max(t.w, t.h) / 2;
    p.kind = ORBIT;
    p.ang = fresh ? rand(0, Math.PI * 2) : Math.atan2((p.y - cy) / 0.78, p.x - cx);
    p.rad = base + rand(6, 22) * this.k + base * rand(0.05, 0.35);
    p.spin = rand(0.35, 0.8);
    p.ttl = p.age + rand(4, 9);
    if (!fresh) {
      p.blend = 0;
      p.bt = 0;
      p.sx = p.x;
      p.sy = p.y;
      p.svx = p.vx;
      p.svy = p.vy;
    }
  }

  private enter(mode: ParticleMode, first: boolean): void {
    this.modeT = 0;
    this.acc = 0;
    this.settled = false;
    const t = this.target();
    const [tx, ty] = this.center(t);
    const big = Math.max(t.w, t.h, 24);
    for (const p of this.pool) {
      if (!p.live) continue;
      switch (mode) {
        case "idle":
          if (p.kind === ORBIT) break;
          if (this.count(ORBIT) < this.idleCount()) this.toOrbit(p, false);
          else this.retire(p, 0.5);
          break;
        case "gather":
          this.pathFrom(p, tx + rand(-0.15, 0.15) * t.w, ty + rand(-0.15, 0.15) * t.h, { secs: rand(0.5, 0.9), bend: rand(-0.3, 0.3), ease: EASE_OUT, end: END_ABSORB });
          break;
        case "stream":
          this.pathFrom(p, tx, ty, { secs: rand(0.5, 0.9), bend: 0.12, ease: EASE_LINEAR, end: END_ABSORB, lane: rand(-1, 1), width: 9 * this.k });
          break;
        case "pass":
          this.pathFrom(p, tx, ty + rand(-0.2, 0.2) * t.h, { secs: rand(0.45, 0.8), bend: 0.08, end: END_CONTINUE });
          break;
        case "stop": {
          const [ex, ey] = this.edgePoint();
          this.pathFrom(p, ex, ey + rand(-0.25, 0.25) * t.h, { secs: rand(0.35, 0.6), ease: EASE_IN, end: END_BOUNCE });
          break;
        }
        case "scan":
          p.kind = FREE;
          p.drag = 2.5;
          p.g = 0;
          this.retire(p, 0.6);
          break;
        case "burst": {
          const d = Math.hypot(p.x - tx, p.y - ty);
          if (d < big * 1.6) {
            const a = Math.atan2(p.y - ty, p.x - tx);
            const s = rand(160, 300) * this.k;
            p.kind = FREE;
            p.vx = Math.cos(a) * s;
            p.vy = Math.sin(a) * s;
            p.drag = 3;
            p.g = 0;
            p.ttl = p.age + rand(0.7, 1.2);
          } else this.pathFrom(p, tx, ty, { secs: rand(0.3, 0.5), ease: EASE_IN, end: END_ABSORB });
          break;
        }
      }
    }
    if (mode === "idle" && first) for (let i = 0; i < this.idleCount(); i++) this.spawnOrbit(true);
    if (mode === "burst") this.burst();
    if (mode === "stop" && !first) this.flash(tx, ty, big * 1.1, big * 2.1, 0.45, GLOW, 0.85);
    if (mode === "pass" && !first) this.flash(tx, ty, big * 0.8, big * 1.7, 0.5, RING, 0.6);
  }

  private idleCount(): number {
    return Math.max(3, Math.round((5 + 9 * this.opts.intensity) * this.calm));
  }

  private edgePoint(): [number, number] {
    const t = this.target();
    const [tx, ty] = this.center(t);
    const [sx, sy] = this.center(this.source());
    const dx = sx - tx;
    const dy = sy - ty;
    const d = Math.hypot(dx, dy) || 1;
    const r = Math.min(t.w, t.h) * 0.42;
    return [tx + (dx / d) * r, ty + (dy / d) * r];
  }

  private spawnOrbit(prefill = false): void {
    const p = this.take();
    if (!p) return;
    this.born(p, Math.random() < 0.8 ? GLOW : MAGIC, rand(6, 11), 1);
    this.toOrbit(p, true);
    if (prefill) p.age = rand(0, 0.15);
    this.place(p);
  }

  private spawnGather(): void {
    const p = this.take();
    if (!p) return;
    const s = this.source();
    const t = this.target();
    const [tx, ty] = this.center(t);
    this.born(p, Math.random() < 0.55 ? MAGIC : GLOW, rand(7, 13), 4);
    p.x = s.x + s.w * rand(0.12, 0.88);
    p.y = s.y + s.h * rand(0.12, 0.88);
    const dist = Math.hypot(tx - p.x, ty - p.y);
    this.pathFrom(p, tx + rand(-0.15, 0.15) * t.w, ty + rand(-0.15, 0.15) * t.h, {
      secs: clamp(dist / 230, 0.55, 1.5) * rand(0.85, 1.2),
      bend: (Math.random() < 0.5 ? -1 : 1) * rand(0.15, 0.45),
      ease: EASE_INOUT,
      end: END_ABSORB,
    });
    p.trail = 3;
  }

  private spawnStream(): void {
    const p = this.take();
    if (!p) return;
    const s = this.source();
    const [sx, sy] = this.center(s);
    const [tx, ty] = this.center(this.target());
    const streak = Math.random() < 0.3;
    this.born(p, streak ? TRACE : GLOW, streak ? rand(9, 14) : rand(5, 9), 4);
    p.x = sx + rand(-0.15, 0.15) * s.w;
    p.y = sy + rand(-0.15, 0.15) * s.h;
    const dist = Math.hypot(tx - sx, ty - sy);
    this.pathFrom(p, tx, ty, { secs: clamp(dist / 190, 0.5, 2) * rand(0.92, 1.08), bend: -0.14, ease: EASE_LINEAR, end: END_ABSORB, lane: rand(-1, 1) * rand(0.3, 1), width: 11 * this.k });
    p.trail = streak ? 0 : 2;
  }

  private spawnPass(): void {
    const p = this.take();
    if (!p) return;
    const s = this.source();
    const t = this.target();
    const [sx, sy] = this.center(s);
    const [tx, ty] = this.center(t);
    this.born(p, Math.random() < 0.75 ? GLOW : SPARK, rand(6, 10), 4);
    p.x = sx + rand(-0.15, 0.15) * s.w;
    p.y = sy + rand(-0.15, 0.15) * s.h;
    const dist = Math.hypot(tx - sx, ty - sy);
    this.pathFrom(p, tx, ty + rand(-0.22, 0.22) * t.h, { secs: clamp(dist / 210, 0.45, 1.6), bend: -0.08, ease: EASE_LINEAR, end: END_CONTINUE });
    p.trail = 2;
  }

  private spawnStop(): void {
    const p = this.take();
    if (!p) return;
    const s = this.source();
    const t = this.target();
    const [sx, sy] = this.center(s);
    const [ex, ey] = this.edgePoint();
    this.born(p, Math.random() < 0.7 ? GLOW : SPARK, rand(6, 10), 4);
    p.x = sx + rand(-0.15, 0.15) * s.w;
    p.y = sy + rand(-0.15, 0.15) * s.h;
    const dist = Math.hypot(ex - sx, ey - sy);
    this.pathFrom(p, ex, ey + rand(-0.25, 0.25) * t.h, { secs: clamp(dist / 240, 0.4, 1.4), bend: -0.06, ease: EASE_IN, end: END_BOUNCE });
    p.trail = 2;
  }

  private spawnSpark(y: number, dir: number): void {
    const p = this.take();
    if (!p) return;
    const s = this.fromBox ?? this.toBox ?? { x: 0, y: 0, w: this.w, h: this.h };
    this.born(p, Math.random() < 0.6 ? SPARK : GLOW, rand(6, 12), rand(0.35, 0.75));
    p.kind = FREE;
    p.x = s.x + s.w * rand(0.04, 0.96);
    p.y = y;
    p.vx = rand(-30, 30) * this.k;
    p.vy = (rand(-22, 22) + dir * 24) * this.k;
    p.drag = 2.2;
    p.g = 0;
  }

  private burst(): void {
    const t = this.target();
    const [tx, ty] = this.center(t);
    const big = Math.max(t.w, t.h, 24);
    const n = Math.round((22 + 34 * this.opts.intensity) * this.calm);
    for (let i = 0; i < n; i++) {
      const p = this.take();
      if (!p) break;
      const r = Math.random();
      this.born(p, r < 0.4 ? STAR : r < 0.8 ? GLOW : SPARK, r < 0.4 ? rand(10, 18) : rand(6, 12), rand(0.8, 1.5));
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
      const s = rand(120, 330) * this.k;
      p.kind = FREE;
      p.x = tx + Math.cos(a) * big * 0.2;
      p.y = ty + Math.sin(a) * big * 0.2;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.drag = rand(2.6, 3.6);
      p.g = 0;
      p.pop = 0.6;
    }
    this.flash(tx, ty, big * 0.9, big * 2.6, 0.55, GLOW, 1);
    this.flash(tx, ty, big * 0.5, big * 3.2, 0.75, RING, 0.9);
    this.flash(tx, ty, big * 0.4, big * 1.5, 0.45, STAR, 0.9);
  }

  private step(dt: number): void {
    this.time += dt;
    this.modeT += dt;
    this.sinceImpact += dt;
    const { mode, intensity } = this.opts;
    const t = this.target();
    const [tx, ty] = this.center(t);

    const rate = (lo: number, hi: number) => (lo + (hi - lo) * intensity) * this.calm;
    const emit = (r: number, fn: () => void) => {
      this.acc += r * dt;
      while (this.acc >= 1) {
        this.acc -= 1;
        fn();
      }
    };
    switch (mode) {
      case "idle":
        if (this.count(ORBIT) < this.idleCount()) emit(4, () => this.spawnOrbit());
        break;
      case "gather":
        emit(rate(10, 34), () => this.spawnGather());
        break;
      case "stream":
        emit(rate(24, 70), () => this.spawnStream());
        break;
      case "pass":
        emit(rate(16, 44), () => this.spawnPass());
        break;
      case "stop":
        emit(rate(12, 32), () => this.spawnStop());
        break;
      case "scan": {
        const y = this.scanY();
        emit(rate(26, 64), () => this.spawnSpark(y, this.scanDir()));
        break;
      }
      case "burst":
        if (this.modeT > 0.75 && !this.settled) {
          this.settled = true;
          let n = this.count(ORBIT);
          for (const p of this.pool) {
            if (n >= this.idleCount()) break;
            if (p.live && p.kind === FREE && p.ttl - p.age > 0.25) {
              this.toOrbit(p, false);
              n++;
            }
          }
        }
        if (this.settled && this.count(ORBIT) < this.idleCount()) emit(3, () => this.spawnOrbit());
        break;
    }

    for (const p of this.pool) {
      if (!p.live) continue;
      p.age += dt;
      if (p.age >= p.ttl) {
        p.live = false;
        continue;
      }
      const ox = p.x;
      const oy = p.y;
      if (p.kind === PATH) {
        p.u += p.du * dt;
        if (p.u >= 1) {
          p.u = 1;
          this.place(p);
          this.pathEnd(p, dt, ox, oy, tx, ty);
          continue;
        }
        this.place(p);
      } else if (p.kind === ORBIT) {
        p.ang += p.spin * dt;
        this.place(p);
      } else {
        const f = Math.exp(-p.drag * dt);
        p.vx *= f;
        p.vy *= f;
        p.vy += p.g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      if (p.blend < 1) {
        p.bt += dt;
        p.blend = Math.min(1, p.blend + dt / 0.6);
        const tau = (1 - Math.exp(-p.bt * 4)) / 4;
        const gx = p.sx + p.svx * tau;
        const gy = p.sy + p.svy * tau;
        const s = smooth(p.blend);
        p.x = gx + (p.x - gx) * s;
        p.y = gy + (p.y - gy) * s;
      }
      if (p.kind !== FREE) {
        p.vx = (p.x - ox) / dt;
        p.vy = (p.y - oy) / dt;
      }
      if (p.pop > 0) p.pop = Math.max(0, p.pop - dt * 2.5);
    }

    this.flashes = this.flashes.filter((f) => (f.age += dt) < f.ttl);
    const haloGoal = mode === "idle" ? 0.34 : mode === "burst" ? (this.settled ? 0.36 : 0.5) : mode === "gather" ? 0.3 : mode === "pass" ? 0.3 : mode === "stop" ? 0.34 : mode === "stream" ? 0.16 : 0;
    this.halo += (haloGoal - this.halo) * (1 - Math.exp(-dt * 3));
    this.haloMix = Math.min(1, this.haloMix + dt / 0.5);
  }

  private place(p: P): void {
    if (p.kind === ORBIT) {
      const [cx, cy] = this.center(this.target());
      const r = p.rad * (1 + 0.07 * Math.sin(this.time * 1.3 + p.ph));
      p.x = cx + Math.cos(p.ang) * r;
      p.y = cy + Math.sin(p.ang) * r * 0.78 + Math.sin(this.time * 0.9 + p.ph) * 2 * this.k;
      return;
    }
    if (p.kind !== PATH) return;
    const e = eased(p.ease, p.u);
    const m = 1 - e;
    let x = m * m * p.ax + 2 * m * e * p.cx + e * e * p.bx;
    let y = m * m * p.ay + 2 * m * e * p.cy + e * e * p.by;
    if (p.width) {
      const dx = p.bx - p.ax;
      const dy = p.by - p.ay;
      const d = Math.hypot(dx, dy) || 1;
      const off = Math.sin(Math.PI * e) * (p.lane * p.width + Math.sin(e * 9 - this.time * 5 + p.ph) * 1.6 * this.k);
      x += (-dy / d) * off;
      y += (dx / d) * off;
    }
    p.x = x;
    p.y = y;
  }

  private pathEnd(p: P, dt: number, ox: number, oy: number, tx: number, ty: number): void {
    const vx = (p.x - ox) / dt;
    const vy = (p.y - oy) / dt;
    const t = this.target();
    const big = Math.max(t.w, t.h, 24);
    if (p.end === END_CONTINUE) {
      p.kind = FREE;
      p.vx = vx;
      p.vy = vy;
      p.drag = 0.9;
      p.g = 0;
      p.pop = 0.8;
      p.ttl = p.age + rand(0.35, 0.7);
      if (this.sinceImpact > 0.22) {
        this.sinceImpact = 0;
        this.flash(tx, ty, big * 0.7, big * 1.5, 0.4, RING, 0.35);
      }
      return;
    }
    if (p.end === END_BOUNCE) {
      const s = Math.hypot(vx, vy) || 1;
      const nx = vx / s;
      const ny = vy / s;
      p.kind = FREE;
      p.vx = -nx * s * rand(0.18, 0.4) + -ny * rand(-1, 1) * s * 0.35;
      p.vy = -ny * s * rand(0.18, 0.4) + nx * rand(-1, 1) * s * 0.35 - rand(20, 80) * this.k;
      p.drag = 1.1;
      p.g = rand(420, 640) * this.k;
      p.pop = 0.7;
      p.ttl = p.age + rand(0.6, 1);
      if (this.sinceImpact > 0.12) {
        this.sinceImpact = 0;
        this.flash(p.x, p.y, big * 0.35, big * 0.9, 0.3, GLOW, 0.55);
      }
      return;
    }
    p.kind = FREE;
    p.vx = 0;
    p.vy = 0;
    p.drag = 0;
    p.g = 0;
    p.shrink = true;
    p.ttl = p.age + 0.18;
    if (this.sinceImpact > 0.18) {
      this.sinceImpact = 0;
      this.flash(tx, ty, big * 0.5, big * 1.1, 0.35, GLOW, 0.22);
    }
  }

  private scanY(): number {
    const s = this.fromBox ?? this.toBox ?? { x: 0, y: 0, w: this.w, h: this.h };
    const period = 1.9;
    const ph = (this.modeT % (period * 2)) / period; // 0..2: down, then up
    const e = smooth(ph < 1 ? ph : 2 - ph);
    return s.y + s.h * (0.06 + 0.88 * e);
  }

  private scanDir(): number {
    const ph = (this.modeT % 3.8) / 1.9;
    return ph < 1 ? 1 : -1;
  }

  private draw(): void {
    const g = this.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.w || !this.h) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = this.dark ? "lighter" : "source-over";
    const fade = (0.55 + 0.45 * this.opts.intensity) * (0.7 + 0.3 * this.calm);

    if (this.halo > 0.01) {
      const t = this.target();
      const [tx, ty] = this.center(t);
      const breath = Math.sin((this.time * Math.PI * 2) / 3.2);
      const size = Math.max(t.w, t.h, 32) * 1.9 * (1 + 0.05 * breath);
      const a = this.halo * (0.8 + 0.2 * breath) * fade * (this.dark ? 1 : 0.75);
      if (this.haloMix < 1) this.blit(GLOW, this.haloPrev, 0, tx, ty, size, a * (1 - this.haloMix));
      this.blit(GLOW, this.haloTone, 0, tx, ty, size, a * this.haloMix);
    }

    if (this.opts.mode === "scan") {
      const s = this.fromBox ?? this.toBox ?? { x: 0, y: 0, w: this.w, h: this.h };
      const y = this.scanY();
      const color = this.colors[this.haloTone]![0]!;
      const band = Math.max(10, 16 * this.k);
      g.globalAlpha = 0.32 * fade;
      g.drawImage(sprite(GLOW, color, this.dark), s.x - 6, y - band / 2, s.w + 12, band);
      const grad = g.createLinearGradient(s.x, 0, s.x + s.w, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.globalAlpha = 0.85 * fade;
      g.fillStyle = grad;
      g.fillRect(s.x, y - 1, s.w, 2);
    }

    for (const p of this.pool) {
      if (!p.live) continue;
      const fin = Math.min(1, p.age / 0.18);
      const fout = Math.min(1, (p.ttl - p.age) / 0.3);
      let a = p.alpha * fin * fout * fade;
      let size = p.size * (1 + p.pop * 0.7);
      if (p.shrink) {
        const k = clamp((p.ttl - p.age) / 0.18, 0, 1);
        size *= 0.4 + 0.6 * k;
        a *= k;
      }
      if (p.kind === ORBIT) a *= 0.55 + 0.45 * Math.sin(this.time * 2.2 + p.ph * 3) ** 2;
      if (a <= 0.01) continue;
      if (p.trail && p.kind === PATH) {
        const u = p.u;
        for (let i = 1; i <= p.trail; i++) {
          p.u = Math.max(0, u - i * 0.035);
          const x0 = p.x;
          const y0 = p.y;
          this.place(p);
          this.blit(p.tex === TRACE ? GLOW : p.tex, p.tone, p.ci, p.x, p.y, size * (1 - i * 0.16), a * 0.5 * (1 - i / (p.trail + 1)));
          p.x = x0;
          p.y = y0;
        }
        p.u = u;
      } else if (p.trail && (p.vx || p.vy)) {
        for (let i = 1; i <= p.trail; i++) this.blit(p.tex, p.tone, p.ci, p.x - p.vx * i * 0.018, p.y - p.vy * i * 0.018, size * (1 - i * 0.16), a * 0.45 * (1 - i / (p.trail + 1)));
      }
      if (p.tex === TRACE) this.streak(p, size, a);
      else this.blit(p.tex, p.tone, p.ci, p.x, p.y, size, a);
    }

    for (const f of this.flashes) {
      const k = f.age / f.ttl;
      const size = f.s0 + (f.s1 - f.s0) * easeOut3(k);
      this.blit(f.tex, f.tone, f.ci, f.x, f.y, size, f.a * (1 - k) * (1 - k) * fade);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }

  private blit(tex: number, tone: number, ci: number, x: number, y: number, size: number, a: number): void {
    const g = this.ctx!;
    if (a <= 0.005 || size <= 0.5) return;
    g.globalAlpha = Math.min(1, a);
    g.drawImage(sprite(tex, this.colors[tone]![ci]!, this.dark), x - size / 2, y - size / 2, size, size);
  }

  private streak(p: P, size: number, a: number): void {
    const g = this.ctx!;
    const angle = Math.atan2(p.vy, p.vx) + Math.PI / 2;
    g.save();
    g.translate(p.x, p.y);
    g.rotate(angle);
    const w = this.dark ? size : size * 0.75;
    g.globalAlpha = Math.min(1, this.dark ? a : a * 0.6);
    g.drawImage(sprite(TRACE, this.colors[p.tone]![p.ci]!, this.dark), -w / 2, -size, w, size * 2);
    g.restore();
  }

  private drawStill(): void {
    const g = this.ctx;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.w || !this.h) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalCompositeOperation = this.dark ? "lighter" : "source-over";
    const { mode } = this.opts;
    const tone = this.haloTone;
    const t = this.target();
    const [tx, ty] = this.center(t);
    const big = Math.max(t.w, t.h, 32);
    if (mode !== "scan") this.blit(GLOW, tone, 0, tx, ty, big * 1.9, this.dark ? 0.3 : 0.2);
    if (mode === "idle" || mode === "burst") {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.4;
        this.blit(i % 2 ? MAGIC : GLOW, tone, i % 2, tx + Math.cos(a) * big * 0.75, ty + Math.sin(a) * big * 0.6, 9 * this.k, 0.75);
      }
      if (mode === "burst") this.blit(RING, tone, 0, tx, ty, big * 1.5, 0.5);
    } else if (mode === "scan") {
      const s = this.fromBox ?? this.toBox ?? { x: 0, y: 0, w: this.w, h: this.h };
      g.globalAlpha = 0.6;
      g.fillStyle = this.colors[tone]![0]!;
      g.fillRect(s.x, s.y + s.h / 2 - 1, s.w, 2);
    } else {
      const [sx, sy] = this.center(this.source());
      const end = mode === "stop" ? this.edgePoint() : [tx, ty];
      for (let i = 0; i <= 6; i++) {
        const e = i / 6;
        const x = sx + (end[0]! - sx) * e;
        const y = sy + (end[1]! - sy) * e - Math.sin(Math.PI * e) * 8 * this.k;
        this.blit(GLOW, tone, i % 2, x, y, (6 + 5 * e) * this.k, 0.35 + 0.5 * e);
      }
      if (mode === "stop") this.blit(RING, tone, 0, tx, ty, big * 1.2, 0.6);
      if (mode === "pass") this.blit(RING, tone, 0, tx, ty, big * 1.25, 0.45);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }
}
