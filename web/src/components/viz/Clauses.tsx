import type { Viz } from "@contracts";
import { stagger, VizFrame } from "./motion.tsx";

export type ClausesViz = Extract<Viz, { kind: "clauses" }>;

type Span = ClausesViz["spans"][number];

const inWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}$]/u.test(c);

function ordered(viz: ClausesViz): Span[] {
  const text = viz.text;
  const out: Span[] = [];
  let prev = 0;
  for (const s of [...viz.spans].sort((a, b) => a.start - b.start)) {
    if (s.end <= s.start || s.start < 0 || s.end > text.length) continue;
    let start = s.start;
    let end = s.end;
    while (start > prev && inWord(text[start - 1]) && inWord(text[start])) start--;
    while (end < text.length && inWord(text[end]) && inWord(text[end - 1])) end++;
    if (start < prev) start = prev;
    if (end <= start) continue;
    out.push({ ...s, start, end });
    prev = end;
  }
  return out;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

export function Clauses({ viz, compact = false }: { viz: ClausesViz; compact?: boolean }) {
  const spans = ordered(viz);
  const label = `Highlighted text, ${spans.length} ${spans.length === 1 ? "passage" : "passages"}. ${spans
    .map((s) => `${s.label}: “${viz.text.slice(s.start, s.end)}”`)
    .join("; ")}.`;
  if (compact)
    return (
      <VizFrame className="viz-clauses viz-compact" label={label}>
        <ul className="viz-clause-list">
          {spans.slice(0, 2).map((s, i) => (
            <li key={i} style={stagger(i)}>
              <span className={`viz-clause-num tone-${s.tone}`}>{i + 1}</span>
              <span>
                <strong>{s.label}</strong> <q className="viz-clause-quote">{clip(viz.text.slice(s.start, s.end), 70)}</q>
              </span>
            </li>
          ))}
        </ul>
        {spans.length > 2 && <p className="viz-more faint">+{spans.length - 2} more</p>}
      </VizFrame>
    );
  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.start > at) parts.push(<span key={`t${i}`}>{viz.text.slice(at, s.start)}</span>);
    parts.push(
      <mark key={`m${i}`} className={`viz-mark tone-${s.tone}`} style={stagger(i)}>
        {viz.text.slice(s.start, s.end)}
        <sup className="viz-mark-num">{i + 1}</sup>
      </mark>,
    );
    at = s.end;
  });
  if (at < viz.text.length) parts.push(<span key="tail">{viz.text.slice(at)}</span>);
  return (
    <VizFrame className="viz-clauses" label={label}>
      <blockquote className="viz-clause-text">{parts}</blockquote>
      <ol className="viz-clause-list">
        {spans.map((s, i) => (
          <li key={i} style={stagger(i)}>
            <span className={`viz-clause-num tone-${s.tone}`}>{i + 1}</span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
    </VizFrame>
  );
}
