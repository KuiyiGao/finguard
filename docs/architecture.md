# FinGuard server architecture

One Node 22 + TypeScript process (`release/server`). No framework, two runtime dependencies
(`yaml`, and `spectrum-ts`, which loads only when `SPECTRUM_PROVIDER=imessage`), SQLite from
Node's built-in `node:sqlite`. Every external integration has a mock
mode, and the demo runs with no keys and no network.

## Request path

```
channel (app / iMessage / console scene)
  -> POST /api/chat -> runTurn (src/agent/turn.ts)
       records the customer's words (and any forwarded message, as untrusted) in the trace
  -> supervised agents (src/agent/supervisor.ts): orchestrator -> one specialist -> evaluator
       (rules brain, or the model brain: src/agent/llm.ts with AGENT_MODE=claude, or
       src/agent/gemini.ts with AGENT_MODE=gemini, and that vendor's key);
       a specialist proposes a tool call within its manifest; it never executes one
  -> runToolCall (src/policy/run.ts), the only path to execution
       1. SkillGate review, Gate.check (src/policy/gate.ts): consent, pause, capability,
          per-action and daily limits, provenance of every money field, cash-flow guard,
          ScamShield for payments to others -> allow | ask | deny
       2. ask: an approval request bound to sha256(tool + canonical args), answered with a
          4-digit code in the app; unanswered by the TTL = denied
       3. Gate.authorize: same action, same policy version, consent on file, approval
          consumed (one approval cannot cover another call)
       4. bank adapter runs under a per-call execution permit (src/bank)
       5. receipt for every action that moves money or changes the account
  -> every step is an event in the hash-chained trace (src/audit/trace.ts, data/trace.jsonl)
  -> SQLite read model (src/store/db.ts, data/steward.db) projects the trace
```

**Trace and read model (CQRS).** The append-only JSONL trace is the source of truth: each
event's hash covers the previous hash, so `GET /api/audit/verify` finds the first altered
or removed event. SQLite is only a projection for queries: on startup (and on demo reset)
it is rebuilt from `trace.list()` in one transaction, then kept current by
`trace.subscribe`. Tables: `events` (indexed by type, turn and time), `decisions`,
`approvals`, `receipts`, plus `kb_chunks` (embedding cache, kept across rebuilds). Deleting
the database loses nothing. A projection error is counted and logged; it never blocks the
trace. `GET /api/db/stats` (operators) returns counts by type, verdict and status, today's
receipts and total, size and rebuild time.

## Knowledge base and retrieval (RAG)

`release/server/kb/*.md`: short passages with front matter (`id`, `title`, `collection`,
`source_url`). Each passage summarizes a public source; citations use the exact doc id
(`kb:scams/safe-account`), never a generated one.

`HybridRetriever` (src/rag/hybrid.ts) fuses two rankings by Reciprocal Rank Fusion,
`score = sum of 1 / (60 + rank)`:

- **BM25** over section chunks (the existing `BM25Retriever`): exact tokens.
- **Local embeddings**: feature-hashed unigrams and bigrams of lightly stemmed tokens,
  TF-IDF weighted, L2-normalized, 512 dimensions, cosine similarity. Deterministic and
  offline. They add stemming, phrase evidence and a different length normalization; they
  have no semantic knowledge, so a dense hit must share a real term with the query.
  Vectors are stored as Float32 BLOBs in `kb_chunks` with a content hash. IDF depends on
  the whole KB, so the model id carries a corpus fingerprint and any KB change re-embeds.
- With `RAG_MODE=live` and `GEMINI_API_KEY`, Gemini embeddings (`gemini-embedding-2`)
  replace the local vectors; any error falls back to local ones for that query.

ScamShield, the savings engine and the agent share one retriever. `npm run eval:rag`
compares BM25, dense and hybrid on `eval/rag-cases.json` (24 written questions, 5 pending
until their docs exist): recall@1 0.583 / 0.417 / 0.583, recall@3 0.792 / 0.708 / 0.875,
MRR@10 0.719 / 0.574 / 0.733. The set is small and was not used for tuning.

## Agents: supervised specialists (v2)

Same structure with or without a key. Without the vendor's key (or with `AGENT_MODE=replay`)
every stage runs on the rules brain; with `AGENT_MODE=claude` (or `gemini`) and a key, the router and the
specialists run on the model brain and fall back to rules per turn.

```
customer words (+ "a message was forwarded": yes/no, never its text)
  -> orchestrator          picks exactly one specialist
       model: one structured call, JSON {specialist, why}; bad JSON or any error -> rules routing
       rules: the rule agent's intent detection (classifyIntent)
  -> specialist            least-privilege manifest: tools outside it are neither offered
       guardian | payments | savings | advisor      nor executable (rejected in code)
       every allowed bank/subscription call -> runToolCall -> SkillGate -> approval -> receipt
  -> evaluator             deterministic critic on every draft reply
       pass -> reply; fail -> one repair (model) -> else a reply built only from this turn's outcomes
  -> ctx.say -> agent_reply
```

| Specialist | Handles | May use | Reads forwarded text |
|---|---|---|---|
| guardian | scams, forwarded messages, pause | `check_message`, `knowledge_search`, `list_findings(protection)`, `pause_all` | yes, as data |
| payments | balances, own-account moves, bills, sending | `bank.get_accounts`, `bank.list_bills`, `bank.list_payees`, `bank.move_own`, `bank.pay_bill`, `bank.transfer`, `check_message` (risk signals only), trusted-contact alert (recorded, not sent) | no |
| savings | subscriptions, cancelling, saving, cash flow | `savings_report`, `list_findings(subscriptions, everyday, bills)`, `subscriptions.list`, `subscriptions.cancel` | no |
| advisor | loans, contracts, investments (education), anything else | `list_findings(loans, contracts, investments)`, `knowledge_search` | no |

Rules routing: check a forwarded message -> guardian; act on one ("send it anyway") ->
payments; pause -> guardian; cancel and saving -> savings; move, pay a bill, send, balances ->
payments; loans, contracts, investments and anything unrecognized -> advisor (read-only, the
safest default). In rules mode the payments handler still proposes the forwarded message's
transfer on purpose, the way an injected model might; SkillGate is what stops it.

**Why each layer**

- *Orchestrator*: one decision per turn, made from the customer's words only, so a forwarded
  message cannot pick tools. A failed model router costs nothing: rules routing takes over.
- *Specialists*: least privilege. The advisor and guardian hold no money tools, so even a fully
  confused model cannot propose a payment from them; payments cannot read forwarded text.
- *Evaluator*: model-agnostic checks that are cheap (p50 0.06 ms) and explainable:
  (a) every dollar amount and 4+ digit account number in the reply appears in this turn's
  tool results, findings, receipts, policy or the customer's words; (b) "done / paid / moved /
  sent / cancelled" only with a receipt from this turn, "waiting for your code" only with a
  pending approval; (c) every `kb:` id exists in the knowledge base; (d) no buy / sell /
  invest-in advice, never asks for codes, passwords or card numbers. Negated sentences
  ("nothing was sent") make no claim, so a correct SkillGate denial always passes.
- *SkillGate* stays the last word on every action; the layers above only narrow what reaches it.

**Trace.** Each stage appends an `agent_step` event:
`{agent: orchestrator|guardian|payments|savings|advisor|evaluator, step: route|scope|evaluate|repair|fallback, detail, tools?, ok?, problems?}`.
No secrets or approval codes. A normal turn is `orchestrator/route -> <specialist>/scope ->
evaluator/evaluate`, then SkillGate's own events. Metrics: `agent.route.<specialist>`,
`agent.route.source.<claude|gemini|rules>`, `agent.evaluator.pass|fail|repair|repaired|deterministic`,
`agent.scope.rejected`, and timings `agent.stage.route|specialist|evaluate`.

**Model brain** (`src/agent/llm.ts`, Anthropic Messages API over `fetch`, no SDK):

- Default `claude-sonnet-5-5` with `thinking: {type: "between_tools"}` and `max_tokens` 2000
  (progress notes between tool calls count toward it); that model rejects a non-default
  `temperature`, so none is sent. The router asks for JSON with `output_config.format`.
- Prompt caching: a fixed base prompt plus the specialist's prompt and its fixed tool list,
  with `cache_control` on the system block and the last tool. Per-turn facts go in the user
  message.
- Tool results are compact JSON (status, `executed`, verdict, reasons, receipt id, data for
  reads); approval codes never reach the model; untrusted text is fenced and labeled.
- At most 6 model calls per turn, a timeout per request (`LLM_TIMEOUT_MS`, default 20 s),
  429/500/502/503/529 retried twice with exponential backoff and jitter, `Retry-After`
  honored up to 8 s, `fallbacks: "default"` for refusals (`LLM_SERVER_FALLBACK=off` turns it
  off), and a `refusal` stop reason handled as an error.
- Fallback: no key, a timeout, a non-retryable status, a refusal or an empty reply -> the
  rules brain answers that turn (logged, `llm.fallback.<reason>`). If an action was already
  proposed, it stops and answers from the turn's outcomes instead, so nothing runs twice.
- Keys come from the environment on demand (`config.secret()`), errors are redacted, and
  health shows only whether a key is present.

## Agent core: nothing happens outside a turn

`src/agent/core.ts`. Every finding, check, document review, research note and action comes
from one supervised turn, and every turn starts with `turn_started {kind, source, summary}`
(`kind`: chat | inbound | review | action | document | research; `source`: app | imessage |
desk | console | system). Reads go through `runToolCall` like actions (the gate allows them by
capability), so each one leaves `tool_proposed -> decision -> tool_executed`.

| Turn | Started by | Event sequence |
|---|---|---|
| chat / inbound | `POST /api/chat` (`runTurn`) | turn_started, (inbound_shared), user_message, orchestrator/route, specialist/scope, tool events, evaluator/evaluate, agent_reply |
| review | server start, demo reset, 2 s after a receipt, `GET /api/findings` when the trace moved, `POST /api/agent/review`, `POST /api/nudges/run` (also sends nudges) | turn_started, orchestrator/route, then savings, guardian, payments, advisor: scope + their `household.*` reads, (nudge_sent), evaluator/evaluate, agent_reply "FinGuard reviewed your money: N findings in 7 areas" |
| action | `POST /api/actions` | turn_started, (inbound_shared: a document proposal whose document left SkillGate's context), user_message (the tap), orchestrator/route by tool (subscriptions.* -> savings; bank.move_own, pay_bill, transfer -> payments; anything else -> advisor, whose empty action scope refuses it before SkillGate), specialist/scope, tool_proposed, decision, (approval), tool_executed, receipt_issued, evaluator/evaluate, agent_reply |
| document | `POST /api/documents/review` (and `POST /api/contracts/review`, kind contract) | turn_started, (inbound_shared: an invoice), orchestrator/route by kind -> advisor, payments or guardian /scope, `documents.annotate` and that specialist's `household.*` reads, (scam_assessed: an invoice), evaluator/evaluate, agent_reply |
| research | `POST /api/research/brief` | turn_started, advisor/scope, research tool events |

The panel (`GET /api/findings`) is the latest review's view: every card carries `turnId` (the
review) and `agent` (protection and scams -> guardian; cash flow and bills -> payments; loans,
contracts, investments and research -> advisor; savings and subscriptions -> savings). The view
is served from memory until another turn writes to the trace or the hour changes. The
`household.*` reads (`bank.read`) and `documents.annotate` (`research.read`, read-only) return
no provenance sightings, so a review never vouches for a money value and never pushes the
customer's own words out of SkillGate's provenance window. The one exception is deliberate: a
shared invoice is recorded as untrusted inbound content (below).

**Documents** (`src/documents/`, `POST /api/documents/review`, samples at
`GET /api/documents/samples` from `fixtures/documents/`). A document turn reads a contract, a
bank statement or an invoice; the kind is given or found by keyword rules (named in the
evidence as `calc:documents/kind`), and the orchestrator routes by kind to one read-only
specialist. Keyword rules mark the passages that matter (the card's `clauses` viz and `marks`,
always `text.slice(start, end) === quote`), code computes every number, the card cites one KB
document by exact id, and it proposes at most one action, which reaches SkillGate only when the
customer taps it (an action turn). Three chains, three permission outcomes:

| Kind | Specialist and reads | Evidence and calculation | Proposed action and SkillGate |
|---|---|---|---|
| contract (area contracts) | advisor: `household.subscriptions` | six clause kinds; renewal cost (12 x dues on file + annual fee); `kb:contracts/auto-renewal` | `subscriptions.cancel`: asks, approved with a code |
| statement (everyday) | payments: `household.accounts`, `household.bills` | fee lines and the low balance; fees per statement and x 12 a year; `kb:savings/overdraft` | `bank.move_own` savings -> checking only when checking is short: next bill - live balance + policy buffer, never a number from the document. Allowed as a standing instruction up to the $500 no-ask limit, asks above it. The demo household (checking $4,210.55) needs no move, so none is proposed |
| invoice (protection) | guardian: `household.payees`, plus ScamShield's message check | payee, account, amount due, due date, red-flag sentences; line items added up; days until due; the payee on file; `kb:scams/invoice-payee-swap` | `bank.transfer` "as written": denied (provenance: the account and amount appear only in the invoice; ScamShield: high, invoice with changed payment details) |

An invoice is someone else's payment instructions, so the document turn records its text with
`recordInbound` (`inbound:invoice-<hash>`), like a forwarded message, and remembers the values it
copied into its proposal. In the action turn a tap normally counts as the customer's words; a
tap of that exact proposal is recorded without the account and amount (a tap of any other action
to that account, without the account), so they keep the invoice as their only origin and
SkillGate's provenance rule denies them exactly as it would in chat. If the invoice has left SkillGate's 5-turn context, the action turn shares it
again first, so ScamShield still sees it. The fictional contractor on file is `RIDGELINE_PAYEE`
in `src/demo/personas.ts` (maya's only addition).

## Gemini (MLH "Best Use of Gemini API")

Gemini over REST (`fetch`, no SDK): `POST .../v1beta/models/{model}:generateContent`, key only
in the `x-goog-api-key` header, never in a URL, log, trace or error.

- **Brain** (`src/agent/gemini.ts`, `AGENT_MODE=gemini`, `GEMINI_MODEL`, default
  `gemini-3.5-flash-lite`): a `Provider` like the Anthropic one, so the same router, manifests,
  evaluator, retries (429/5xx with backoff, `Retry-After`) and per-turn fallback to rules apply.
  Tools go as `functionDeclarations` with `parametersJsonSchema`; `functionCall` parts map to
  the manifest's tools and results go back as `functionResponse` parts; the model's turn is
  kept unchanged, so Gemini 3 thought signatures are returned. The router uses
  `responseMimeType: application/json` + `responseJsonSchema`. Thinking: `MINIMAL` on 3.5
  Flash-Lite (about 0.6 s a call), `LOW` on 3.8 Flash (which rejects `MINIMAL`).
- **ScamShield second opinion** (`src/fraud/second-opinion.ts`, `SCAM_LLM=gemini|off`, default
  `gemini` when `GEMINI_API_KEY` is set; `SCAM_LLM_MODEL`, default `gemini-3.5-flash-lite`).
  Message checks only (forwarded messages, `check_message`, scenario cards); transfers stay on
  the rules, so the model never decides a money action. One call per distinct message (cached by
  sha256 of model + text), 4 s timeout, no retry. The message is sent inside `<message>` tags as
  untrusted data with an instruction never to follow it. JSON schema: `{signals: [{signal,
  quote}], typology, risk, why}`. Merge, in code: a model flag is kept only when its quote is in
  the message (case, quote marks and spacing may differ, words may not; partial words do not
  count), is weighted like the rule flag and its evidence ends with `(via: gemini)`; a rule flag
  is never removed or replaced; final risk = max(rules risk, risk of the merged score, model
  risk), so a model can raise risk but never lower it. On a timeout or error the rules result
  stands. Metrics: latency `scam.llm`; counters `scam.llm.ok|cached|timeout|error|kept_rules`,
  `scam.llm.agreed|raised`, `scam.llm.signals.added|dropped`.

## Skill pack: public-data research

`src/research/` is the first skill pack. Its manifest (`GET /api/research/skills`) declares one
capability, `research.read`, a host allowlist and five read-only tools: `research.sec_filings`,
`research.sec_facts` (SEC EDGAR), `research.treasury_rates` (Treasury FiscalData),
`research.fdic_bank` (FDIC BankFind) and `research.cfpb_complaints` (CFPB). Each tool reaches
only its own hosts (checked in code before any request, https only, no redirects), times out
after 10 s and caches answers for 10 minutes. Results carry official source URLs and add no
`systemValues` or `texts`, so public data can never vouch for an account or amount in
SkillGate's provenance check.

The pack is registered with SkillGate as an approved extension pinned to its manifest hash
(`researchExtensions()` in `services.ts`). Brief calls carry `skill: "research"`, so the gate
needs both the user's `research.read` grant (policy v1 grants it with `approval: never`) and the
manifest; a research call to any bank tool is denied. `POST /api/research/brief` runs the skills
in one turn (`tool_proposed`, `decision`, `tool_executed` per call) and returns `investments`
Findings (`from: "research"`): a revenue and net income curve, a filings timeline, Treasury bill
vs. note rates, complaint-issue bars and the FDIC check. In chat, the advisor specialist has the
same tools; the rules brain answers "research Apple", "how is MSFT doing" and "is First Example
Bank real?" with 2-3 facts and one source, and the evaluator checks every number against the
tool results. Without `SEC_USER_AGENT` the SEC tools answer from a hand-built sample (AAPL,
MSFT) labeled "cached sample, not live"; Treasury, FDIC and CFPB need no key. Facts only, no
recommendations. Contract, statement and invoice review is the document turn (Documents, above).

## Metrics

`src/metrics.ts`: in-process counters and latency summaries (p50, p95, max and mean over
the last 500 samples). Series: `gate.check`, `tool.run:<tool>`, `agent.turn`,
`llm.request`, `rag.search`, `http:<METHOD /route>`, plus LLM token, retry and fallback
counters. `GET /api/metrics` (operators). Measured in-process with the mock bank on a
laptop (140 rules-brain turns): `agent.turn` p50 0.8 ms (p95 4.9 ms), of which routing 0.01 ms
and evaluation 0.06 ms; `gate.check` p50 0.5 ms; `rag.search` p50 0.06 ms; rebuilding the read
model takes 0.2 ms for 23 events and 59 ms for 9,180.

## What is simulated

- The bank: an offline Nessie-shaped household (`mock-nessie`) unless `NESSIE_MODE=live`;
  subscriptions and plan offers are mock merchants. With `NESSIE_MODE=live`, reads are live
  and approved actions settle on a simulated ledger over them (`src/bank/ledger.ts`).
- Trusted-contact alerts are recorded in the trace; FinGuard does not send them yet.
- Roles: `X-Demo-Role` is a demo switch, not authentication.
- Approval delivery: the app answers approvals; iMessage delivery depends on the Spectrum
  channel being configured.
- The knowledge base is a small set of summaries for the demo, not advice.
- Model calls are real only with a key; tests mock `fetch` and never use the network.
