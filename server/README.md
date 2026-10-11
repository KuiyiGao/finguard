# Steward server

Node 22 + TypeScript (run by tsx). No keys or network needed: every integration defaults to
a mock.

```bash
npm install
npm run dev        # http://localhost:8787, restarts on change
npm test           # node:test, all src/**/*.test.ts
npm run typecheck
npm run reset      # delete data/trace.jsonl (policy, consent, receipts start over)
```

API: [`../docs/openapi.yaml`](../docs/openapi.yaml). Contracts: [`src/types.ts`](src/types.ts).

| Folder | What it does |
|---|---|
| `src/gateway` | REST + SSE, mock roles (`X-Demo-Role: customer` or `operator`) |
| `src/audit` | hash-chained trace (`data/trace.jsonl`); policy, consent and receipts live in it |
| `src/policy` | delegation policy and consent, provenance, approvals, SkillGate, `runToolCall` |
| `src/tools` | tool contracts (`specs.ts`), registry, mock merchant subscription cancellation |
| `policy/default.json` | the default limits the user agrees to |

Every tool call goes through `runToolCall`: SkillGate review, approval bound to the exact
action when needed, a last check, execution, then a receipt for money actions.

Try it:

```bash
curl -s localhost:8787/api/policy | jq .statement
curl -s -XPOST localhost:8787/api/consent -H 'content-type: application/json' -d '{"policyVersion":1}'
curl -s -XPOST localhost:8787/api/actions -H 'content-type: application/json' \
  -d '{"tool":"bank.move_own","args":{"from_account":"acct-checking","to_account":"acct-savings","amount":300}}' | jq .receipt
curl -s localhost:8787/api/audit/verify -H 'X-Demo-Role: operator'
```

## Bank, retrieval and savings

`npm run dev` now uses the T6 bank adapters and T9 evidence engine. In default
`NESSIE_MODE=mock`, the household runs in process with the same REST backend as
`npm run mock-nessie` (port 8788); a second process and network are unnecessary.
`RAG_MODE=mock` indexes the Markdown corpus in `kb/` by section with BM25.

`GET /api/savings` returns transaction evidence, KB citations and explicit financial
assumptions. Its bill, own-account move and subscription cancellation actions use
`POST /api/actions`, existing SkillGate approvals and receipts. Cancelled subscriptions
stop appearing as opportunities. A past one-off fee contributes zero to recurring totals.
Default demo data and the cheaper internet offer are fictional. The standard household
retains the previous demo's checking balance, rent and policy buffer; the independent
savings oracle uses a different fixed household.

Run `npm run review` for the detailed local impact/authorization/reconciliation demo
on port 8791. This harness blocks cash-flow shortfalls; the standard app retains the
existing policy behavior of asking for approval. A receipt records authorization and
execution; it is not proof of external settlement or realized savings.

Live bank mode requires `NESSIE_MODE=live`, `NESSIE_API_KEY` in the process environment,
and a policy whose own-account and saved-payee IDs match the authenticated sandbox.
Use actual returned account IDs with `/api/actions`; the replay chat agent's fixed demo
account aliases are not a live account-discovery implementation. Live HTTPS reads and
transfer requests have transport tests, but authenticated calls have not been verified.
Live bill mutation stays disabled until the provider's payment/settlement semantics
are verified. Live savings does not assume mock offers, non-use or interest rates.
Subscription tools remain a mock merchant even with live banking.

`RAG_MODE=live` requires a supplied embeddings implementation; the offline retriever
exports an injectable live factory hook and does not silently claim live operation.

### Current Nessie endpoint

The current official documentation uses `https://prod-api.nessieisreal.com`, now the
default `NESSIE_BASE_URL`. Legacy `https://api.nessieisreal.com` remains accepted as an
explicit override. A 200 response containing an empty account list does not prove the
key works; an authenticated endpoint can still reject it with 401. Check the personal
Profile key and the environment used to start the process. The current published
OpenAPI describes bill updates, not payment settlement, and omits account-scoped
transfer creation; keep live claims limited to operations independently verified.

## Model agent, read model, hybrid retrieval and metrics

Details: [`../docs/architecture.md`](../docs/architecture.md).

- Agents are supervised specialists in every mode (`src/agent/supervisor.ts`): an
  orchestrator picks one of guardian, payments, savings or advisor; each has a
  least-privilege tool manifest; a deterministic evaluator (`src/agent/evaluator.ts`) checks
  every reply before it is sent; each stage is an `agent_step` trace event. Without a key the
  rules brain runs all of it. `AGENT_MODE=claude` with `ANTHROPIC_API_KEY` (`LLM_MODEL`,
  default `claude-sonnet-5-5`; `LLM_TIMEOUT_MS`, default 20000) uses the model brain
  (`src/agent/llm.ts`); a timeout, an API error or a refusal hands that turn to rules.
- `data/steward.db` (`src/store/db.ts`, `node:sqlite`): a SQLite projection of the trace,
  rebuilt from the trace on every start and reset. The trace stays the source of truth.
  `GET /api/db/stats` (operator).
- Retrieval is hybrid (`src/rag/hybrid.ts`): BM25 plus deterministic local embeddings,
  fused by Reciprocal Rank Fusion; `RAG_MODE=live` with `GEMINI_API_KEY` adds Gemini
  embeddings. `npm run eval:rag` prints recall@1, recall@3 and MRR for BM25 and hybrid and
  writes `eval/rag-result.json`.
- `GET /api/metrics` (operator): counters and p50/p95/max latencies for `gate.check`,
  `tool.run:<tool>`, `agent.turn`, `llm.request`, `rag.search` and each route.

## Personas and the parallel runner

- `src/demo/personas.ts`: five simulated households, all fictional. `maya` is the original demo
  household (the default, unchanged); `grace` (retiree, scam target, son as trusted contact,
  $300 daily limit), `diego-ana` (rent, car loan and daycare in one week: the cash-flow guard),
  `sam` (gig worker, irregular payouts, $150 buffer) and `priya` (investor, higher limits).
  `buildServices(config, { persona })`; operators switch with `POST /api/demo/reset {"persona": "grace"}`
  (no persona: back to maya); `GET /api/demo/personas` lists them. Mock Nessie only.
- `npm run parallel` plays each persona's scripted session (nudges, a move within limits, a bill
  paid with the code, a forwarded scam that must be blocked, an over-limit request, a cancel)
  concurrently, each on its own in-memory services, checks every expected outcome and that each
  audit chain verifies, and writes `eval/parallel-result.json`. `-- --repeat 20` runs 5 x 20
  sessions at once for load (turn latency p50/p95/max and turns per second).

### Fictional Nessie household preparation

Run `node --import tsx mock-nessie/seed-live.ts` to print the plan. With
`NESSIE_API_KEY` configured in the environment, add `--apply` to create fictional
customers, checking/savings accounts and pending bills in the Nessie sandbox.
`--profiles=<file>` accepts an array of `{id,name,checking,savings,billAmount}`;
checking/savings balances are nonnegative whole dollars. The default five profiles
are temporary fixtures pending the final persona mapping. No purchases or transfers
are created. Keep `data/nessie-seed.json` and its unresolved `.pending` journal local;
reconcile an uncertain request before rerunning. Set `NESSIE_CUSTOMER_ID` to select
one household for live reads. Live money tools remain disabled. Account/purchase
reads were verified; checking/customer bill reads currently return HTTP 400.
