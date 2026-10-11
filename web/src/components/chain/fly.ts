
const NS = "http://www.w3.org/2000/svg";

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function pill(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  const n = (v: number) => v.toFixed(1);
  return `M${n(x + rr)} ${n(y)}H${n(x + w - rr)}A${n(rr)} ${n(rr)} 0 0 1 ${n(x + w)} ${n(y + rr)}V${n(y + h - rr)}A${n(rr)} ${n(rr)} 0 0 1 ${n(x + w - rr)} ${n(y + h)}H${n(x + rr)}A${n(rr)} ${n(rr)} 0 0 1 ${n(x)} ${n(y + h - rr)}V${n(y + rr)}A${n(rr)} ${n(rr)} 0 0 1 ${n(x + rr)} ${n(y)}Z`;
}

export interface FlyOptions {
  tone: string;
  duration: number;
  toRadius?: number;
  onDone?: () => void;
}

export function flyPill(layer: SVGSVGElement, root: HTMLElement, from: DOMRect, to: DOMRect, opts: FlyOptions): () => void {
  const base = root.getBoundingClientRect();
  const a = { x: from.left - base.left, y: from.top - base.top, w: Math.max(8, from.width), h: Math.max(8, from.height) };
  const b = { x: to.left - base.left, y: to.top - base.top, w: Math.max(8, to.width), h: Math.max(8, to.height) };
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", `ch-fly tone-${opts.tone}`);
  const glow = document.createElementNS(NS, "path");
  glow.setAttribute("class", "ch-fly-glow");
  const shape = document.createElementNS(NS, "path");
  shape.setAttribute("class", "ch-fly-pill");
  g.append(glow, shape);
  layer.append(g);

  const c0 = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const c1 = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = c1.x - c0.x;
  const dy = c1.y - c0.y;
  const len = Math.hypot(dx, dy) || 1;
  const bend = Math.min(140, len * 0.32);
  const ctrl = { x: (c0.x + c1.x) / 2 + (dy / len) * bend, y: (c0.y + c1.y) / 2 - (dx / len) * bend };
  const r1 = opts.toRadius ?? Math.min(b.h / 2, 11);
  let raf = 0;
  let t0 = 0;
  const frame = (now: number) => {
    if (!t0) t0 = now;
    const t = Math.min(1, (now - t0) / opts.duration);
    const e = easeInOut(t);
    const u = 1 - e;
    const x = u * u * c0.x + 2 * u * e * ctrl.x + e * e * c1.x;
    const y = u * u * c0.y + 2 * u * e * ctrl.y + e * e * c1.y;
    const lift = 1 + 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.2));
    const s = easeInOut(Math.min(1, t * 1.2));
    const w = (a.w + (b.w - a.w) * s) * lift;
    const h = (a.h + (b.h - a.h) * s) * lift;
    const d = pill(x - w / 2, y - h / 2, w, h, 4 + (r1 - 4) * s);
    shape.setAttribute("d", d);
    glow.setAttribute("d", d);
    glow.style.opacity = String(0.9 * Math.sin(Math.PI * t));
    g.style.opacity = String(t < 0.82 ? 1 : Math.max(0, 1 - (t - 0.82) / 0.18));
    if (t < 1) raf = requestAnimationFrame(frame);
    else {
      g.remove();
      opts.onDone?.();
    }
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    g.remove();
  };
}

export function magnet(el: HTMLElement, from: DOMRect | null, duration: number): void {
  const to = el.getBoundingClientRect();
  const frames: Keyframe[] = from
    ? [
        { transform: `translate(${from.left + from.width / 2 - (to.left + to.width / 2)}px, ${from.top + from.height / 2 - (to.top + to.height / 2)}px) scale(0.55)`, opacity: 0.25, offset: 0 },
        { transform: "translate(0px, 0px) scale(1.09)", opacity: 1, offset: 0.74 },
        { transform: "translate(0px, 0px) scale(1)", opacity: 1, offset: 1 },
      ]
    : [
        { transform: "translateY(-16px) scale(0.8)", opacity: 0, offset: 0 },
        { transform: "translateY(0px) scale(1.07)", opacity: 1, offset: 0.7 },
        { transform: "translateY(0px) scale(1)", opacity: 1, offset: 1 },
      ];
  el.animate(frames, { duration, easing: "cubic-bezier(0.55, 0, 0.25, 1)" });
}
