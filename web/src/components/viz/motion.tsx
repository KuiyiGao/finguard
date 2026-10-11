import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { formatValue, type ValueUnit } from "./format.ts";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function stillMode(): boolean {
  return prefersReducedMotion() || hidden();
}

export function useInView<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    if (typeof IntersectionObserver !== "function" || hidden()) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

export function useCountUp(target: number, { duration = 900, delay = 0, run = true }: { duration?: number; delay?: number; run?: boolean } = {}): number {
  const still = stillMode();
  const [value, setValue] = useState(still ? target : 0);
  const shown = useRef(still ? target : 0);
  useEffect(() => {
    if (!run) return;
    if (stillMode() || !Number.isFinite(target)) {
      shown.current = target;
      setValue(target);
      return;
    }
    const start = shown.current;
    if (start === target) {
      setValue(target);
      return;
    }
    let raf = 0;
    let t0 = 0;
    const tick = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, Math.max(0, (t - t0 - delay) / duration));
      const eased = 1 - Math.pow(1 - p, 3);
      const v = p >= 1 ? target : start + (target - start) * eased;
      shown.current = v;
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, delay, run]);
  return value;
}

export function CountUp({ value, unit, delay = 0, duration = 900, className = "" }: { value: number; unit?: ValueUnit; delay?: number; duration?: number; className?: string }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const v = useCountUp(value, { delay, duration, run: seen });
  const final = formatValue(value, unit);
  return (
    <span ref={ref} className={`countup num ${className}`}>
      <span className="countup-ghost" aria-hidden>
        {final}
      </span>
      <span className="countup-live" aria-hidden>
        {formatValue(v, unit)}
      </span>
      <span className="visually-hidden">{final}</span>
    </span>
  );
}

export function VizFrame({ label, className, children, style }: { label: string; className: string; children: ReactNode; style?: CSSProperties }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const [still] = useState(stillMode);
  return (
    <div ref={ref} className={`viz ${className}`} role="img" aria-label={label} data-run={still ? "still" : seen ? "on" : "off"} style={style}>
      {children}
    </div>
  );
}

export const stagger = (i: number): CSSProperties => ({ "--i": i }) as CSSProperties;
