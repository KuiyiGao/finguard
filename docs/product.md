# FinGuard product map

FinGuard is evidence-grounded execution and permission for money: every claim is an evidence
card with its sources, and every action passes SkillGate, is approved with a code bound to that
exact action, and leaves a receipt in a hash-chained audit trace. This page is the single
reference for what the product does, where each part lives, how people move through it, and how
it moves. Build to it; change it in the open (PLAN.md, "How to change the plan").

## The agent at the core

Nothing happens outside an agent turn. Every finding on the panel, every check, every document
review, every research note and every action is produced by a supervised turn: the orchestrator
routes it to one least-privilege specialist (guardian, payments, savings or advisor), the
specialist uses only the tools in its manifest, every tool call (reads included) goes through
SkillGate, and the evaluator checks the reply before anyone sees it. Each turn starts with a
`turn_started` event naming why it ran:

| Kind | Started by | Example |
|---|---|---|
| chat | the customer asks | "Can I afford to move $500?" |
| inbound | a forwarded text or an iMessage | "Is this real?" with the message |
| review | FinGuard itself (start, reset, after a receipt, on demand) | the sweep that produces the panel's cards |
| action | a tap on a card's action | "Cancel CloudGym before it renews" |
| document | a contract, statement or invoice comes in | the gym contract on the desk |
| research | a company or holding | "Research Apple" |

Every card carries the turn and the specialist that produced it, so "How FinGuard found this"
opens that turn in the agent theater on any surface.

## Feature tiers

| Tier | Name | What it covers | Always on |
|---|---|---|---|
| 0 | Trust core | SkillGate (consent, pause, limits, provenance, cash flow, cooling-off, scam check), approval codes bound to the action, receipts, hash-chained audit, the evidence card, the evaluator that checks every reply | yes, on every surface |
| 1 | Protect | ScamShield on forwarded messages and payments (red flags, typologies, payee comparison, Gemini second opinion that can only raise risk), trusted-contact alerts (recorded, not sent yet), "is this bank real" (FDIC) | yes |
| 2 | Act | moves, bill payments and transfers within limits; subscription cancels; proactive nudges; "safe to move today"; approvals in the app or by iMessage | yes |
| 3 | Understand | the panel's seven areas (everyday, bills, subscriptions, investments, loans, contracts, protection); the savings report; loan, fee and contract math; document annotation into an evidence chain | yes |
| 4 | Research and extend | skill packs with capability manifests (first: public-data research on SEC, FDIC, CFPB and Treasury data), the agent theater, personas and parallel tests, evals and metrics | for advisors and operators |

A feature belongs to the lowest tier it depends on. Nothing in a higher tier may bypass a lower
one: research can propose, never execute; a model can raise a risk, never lower it.

## Surfaces

| Surface | Who | Job | Route |
|---|---|---|---|
| iPhone app (PWA) | the customer | glance, decide, approve: safe to move, one card that needs you, seven area tiles, approval sheet with the code, chat and forward, receipts, limits and pause | `/app` |
| iMessage (Photon) | the customer | the same decisions without opening the app: nudges, "Reply YES 1234" | phone |
| Desktop desk | the customer or their advisor | deep work: dashboards per area, the research desk, documents in (paste or drop a contract, statement or invoice), data sources, the agent theater beside the chat | `/desk` |
| Operations console | operator, compliance, judges | every decision with its pipeline, provenance graph and rules; approvals (codes hidden); receipts; audit verify; findings; eval scorecard; metrics and read-model counts; demo scenes and personas | `/console` |
| Stage | the presenter | phone and console side by side with a caption per step | `/` |
| Gallery | the team | every chart, card, mark, icon and state with sample data, light and dark | `/gallery` |

Phone first decides; desktop explains. A flow may start on one surface and finish on another
(a nudge on iMessage, the evidence chain on the desk, the receipt on the phone); the trace ties
them together.

## Journeys

Each journey names its evidence moment (E) and its permission moment (P).

1. **Is this message real?** Forward a text (app or iMessage) -> the orchestrator routes to the
   guardian -> ScamShield and the Gemini second opinion -> E: the card highlights the exact red-flag
   words and cites the FTC or FBI page -> "send it anyway" -> P: SkillGate denies (the account
   number appears only in the message) -> an alert for the trusted contact is recorded -> the console shows the
   provenance graph.
2. **FinGuard noticed.** A nudge (Paramount+ trial renews in 2 days) -> E: never used, renewal date,
   price -> "Cancel" -> P: code for this exact cancel -> receipt -> the savings report updates.
3. **Pay a bill safely.** "Pay my Duke bill" -> P: bills always ask; code -> receipt. A forwarded
   invoice asking to pay account 4417 -> E: payee differs from the account on file -> P: denied.
4. **Read the fine print.** On the desk, drop the gym contract -> E: six clauses highlighted, the
   renewal cost computed, the FTC page on automatic renewals -> the evidence chain proposes
   "Cancel before it renews" -> P: SkillGate checks, code -> receipt closes the chain.
5. **Research a holding.** On the desk, "research Apple" -> the advisor runs the research skills
   (each visible in the theater with its host and manifest) -> E: revenue and income over periods,
   complaint counts, Treasury rates, each with its filing or dataset link -> a research note with
   no buy or sell advice. For an advisory team, any follow-up action is a proposal that passes
   SkillGate like any other.
6. **Prove it.** In the console: try to reuse an approved code on a different payment (refused,
   hashes differ), verify the audit chain, show the SkillGate eval scorecard and stage latencies.

The two-minute demo runs 1, 2 (or 3), 4 and 6; 5 is the extension story.

## One agent on screen

FinGuard is one agent with one mark: a soft brand-teal disc, a thin ring and one white glyph. The
specialist shows only as the glyph and the ring's color (Waypoints for routing, Shield for the
guardian, Send for payments, PiggyBank for savings, BookOpen for the advisor, Search for
research); there are no characters. The mark appears once, in the middle of the agent theater;
everywhere else a line of text says who did the work, with at most a small muted glyph. A hand-off
is a glyph cross-fade, a ring-color change and a small pop. SkillGate, the evaluator, the customer
and the data sources are objects (a gate ring, a seal, a phone, source icons). Particles show what
FinGuard is doing; the mark only says who is doing it.

## Motion

- Tokens: `--motion-fast` 120 ms (presses, toggles), `--motion-base` 220 ms (cards, sheets),
  `--motion-slow` 420 ms (charts drawing, highlights), `--motion-stage` 700 ms per hand-off in the
  theater and the evidence chain; easing `--ease` for entrances, linear for progress.
- One focal motion per screen: the element the user should look at next. Lists stagger by 40 ms,
  at most eight items.
- Data animates once, when it first scrolls into view; counts finish within 600 ms; replays are
  the user's choice (Replay buttons).
- `transform` and `opacity` animate anywhere. Small elements (markers, rings, chips, seals) may
  also animate `filter` (glow), `clip-path`, SVG path shapes and `stroke-dashoffset`. Layout
  properties never animate. The FinGuard mark breathes while idle and runs its ring's dash while it
  works.
- The tricks we use: glow halos (a pre-blurred layer whose opacity and scale change), scale pops
  with a slight overshoot, cross-fades between states, shape morphs between paths with the same
  commands (the SkillGate ring opening or locking, a highlight becoming an evidence chip),
  highlighter strokes and connectors that draw in, and moves between stations done with
  transforms (FLIP).
- Particles (one canvas layer per view, `components/particles`) show the agent's working state:
  drifting while idle, gathering from a source while reading, streaming evidence to the next
  station, passing or stopping at SkillGate, and a burst when a receipt is sealed. Trusted
  particles are cool, untrusted ones warm. They pause in hidden tabs and off screen, and small
  surfaces get fewer, softer particles than the theater and the evidence chain.
- `prefers-reduced-motion` and hidden tabs show the final state at once.

## Assets

- Type: the system UI stack (`--font`) for all text.
- Icons: lucide-react with one stroke width. The FinGuard mark (a vector disc, ring and lucide
  glyph), the stage objects (phone, SkillGate ring, seal) and the skill and service icons (lucide
  in a small rounded square) are vector and drawn in code; no pixel art and no agency logos.
  Particle textures come from the Kenney Particle Pack (CC0) in `release/web/public/particles/`.
  App icons: `release/web/public/icon-*.png`.
- Every external asset is listed with its source and license next to the file.

## Enterprise checklist

- Roles: customer and operator today (`X-Demo-Role`); operators never see codes.
- Skills declare capabilities and hosts; SkillGate enforces them; the console shows them.
- Data labels: "Simulated" on demo data, "cached sample" on offline public data, live otherwise.
- Every number from code; every fact with an official source; no compliance or "prevents fraud"
  claims; no investment advice.
- Quality gates before every push: server tests, typecheck, web build, SkillGate eval,
  `npm run live:check` with the keys present.
- Budgets: each surface's first load under 200 KB of compressed JavaScript; a rules-brain turn
  under 50 ms on the server; WCAG AA contrast; full keyboard use on desktop.
