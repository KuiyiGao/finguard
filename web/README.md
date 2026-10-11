# Steward web

One React app with three routes:

| Route | Who | Layout |
|---|---|---|
| `/` | the demo stage: phone app and console side by side | desktop |
| `/app` | the customer (phone) | 390 px wide; full screen on a phone, in a phone frame on desktop |
| `/console` | operations (bank staff, judges) | desktop, three columns; one column under 1024 px |

```bash
npm install
npm run dev     # http://localhost:5173, /api is proxied to the server on :8787
```

Start the server first (`cd ../server && npm run dev`). Everything works offline with mocks.

## Visual rules

Use these rules for every screen, so the pieces built by different people read as one product.

**Color carries meaning, and is never the only signal.** Every colored chip or badge also
has a word and an icon.

- **Verdicts** (`--allow`, `--ask`, `--deny`): green "Allowed", amber "Needs approval", red
  "Blocked". Use the badge component; never invent new verdict colors.
- **Where a value came from** (provenance chips): cool colors are trusted, warm colors are not.

  | Origin | Label | Token |
  |---|---|---|
  | `user` | You said | `--origin-user` (blue) |
  | `system` | Bank record | `--origin-system` (teal) |
  | `inbound_message` | Forwarded message | `--origin-inbound` (red) |
  | `tool_text` | Memo or invoice text | `--origin-tooltext` (orange) |
  | `skill_text` | Extension | `--origin-skill` (purple) |
  | `kb` | Knowledge base | `--origin-kb` (gray) |

- **Brand** `--brand` (deep teal) is for primary actions and the Steward mark only.

**Type.** System font stack (works offline). Money and counts use tabular numbers
(`.num`). Hashes and ids use the mono stack and are shortened to 8 characters with the full
value in a tooltip.

**Words.** Plain, sentence case, short. Say what happened and why in the user's terms:
"Blocked: account 9917 appears only in the forwarded message." Never say "safe",
"guaranteed", "compliant" or "fraud-proof". Mock data is labeled "Demo data".

**Money.** Format with `formatUsd` from `src/lib/format.ts`. Only show numbers that come from
the API; the browser never computes amounts.

**States.** Every view has loading, empty and error states. Buttons that call the server are
disabled while the call is in flight. Approvals show their countdown.

**Motion.** Follow "Motion" and "One agent on screen" in
[release/docs/product.md](../docs/product.md): motion tokens, one focal motion per screen,
transform and opacity (plus filter, clip-path, SVG path and stroke-dashoffset on small
elements), particles from `components/particles` for the agent's working state, and the final
state at once under `prefers-reduced-motion` or in a hidden tab.

**Light and dark.** Tokens in `src/styles/tokens.css` define both; use tokens, not hex values.

## Code layout

| Path | What |
|---|---|
| `src/styles/` | tokens and base styles |
| `src/lib/` | API client (`api.ts`, sets the demo role), live events (`events.ts`), formatting |
| `src/components/` | shared pieces: verdict badge, origin chip, rule list, money, hash, buttons, cards |
| `src/app/` | customer app screens (`savings/` is T19) |
| `src/console/` | operations console panels |

Types come from the server's contracts (`import type { ... } from "@contracts"`, which points
at `../server/src/types.ts`). Add no UI library; ask in PLAN.md before adding a dependency.

## Savings acceptance (T19)

The Savings tab consumes the API report with evidence, KB source links and projection
assumptions. Actions pass through the existing gateway and code approval sheet; live trace
events update outcomes and receipts. Report refresh removes cancelled subscriptions and
paid-bill opportunities while retaining the completed action receipt. Amounts remain
server-calculated; a receipt is not proof of realized savings. Unknown outcomes require
checking Activity before retrying. Loading, empty, error, consent and pause states are
handled; demo households are visibly labeled.
