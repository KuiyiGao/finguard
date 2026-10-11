# Approval channel (T10)

`createApprovalChannel` in `imessage.ts` implements the existing `ApprovalChannel`
contract. `SPECTRUM_PROVIDER=terminal|off|imessage` selects the transport; the default
is `off`, which refuses approval. No provider calls a bank or executes an action.

## Offline terminal demo

Run from the repository root with Node 22.6+ (22.18+ recommended). The explicit
type-stripping flag also works on the development machine's Node 25.7.0.

```bash
SPECTRUM_PROVIDER=terminal APPROVAL_DEMO_CODE=4821 node --experimental-strip-types release/server/src/notify/demo.ts
```

The script prints a fresh request ID each run. Copy the exact command it displays:

```text
YES 4821 <request-id>
NO <request-id>
```

Try a wrong code first: it stays pending. A matching YES approves; a matching NO
denies. Silence expires after 60 seconds. Set `APPROVAL_DEMO_TTL_SECONDS=5` for a
short timeout. The script reports the answer and exits without moving money.
EOF leaves an already sent request pending until its original expiry; SIGINT closes
the channel and denies pending requests.

```bash
SPECTRUM_PROVIDER=off node --experimental-strip-types release/server/src/notify/demo.ts
node --experimental-strip-types --test release/server/src/notify/*.test.ts
```

Terminal/off require no packages, account, credentials, phone, or network. A
minimal service package manifest now records the optional SDK and TypeScript tooling;
these commands run independently of the server skeleton. Reinstall the locked dependencies with `npm ci` in
`release/server`. TypeScript 5.9.3 and Node 22 type definitions are development dependencies.

To type-check this module, run from `release/server`:

```bash
./node_modules/.bin/tsc --project src/notify/tsconfig.json
```

The local `tsconfig.json` lets editors use the same Node ESM settings and strict
array-index checks as the CLI, even before T1's server configuration is merged.
It covers the notify sources/tests and their imported shared types without changing
the team's server configuration. Pass `--project` rather than individual source files
so TypeScript loads these settings.

## Binding and one-use replies

Construct one channel per authenticated recipient/conversation. The transport's
reply envelope must contain an authenticated sender, conversation ID, message ID,
and exact request ID. The constructor binds the first two; `ask` snapshots the
request ID, call ID, action hash, code, summary and expiry. It accepts only pending
requests with a four-digit code, SHA-256-shaped hash, valid deadline, and a unique
printable request token. Wrong codes, extra text, and mismatched routes are ignored.

Reply IDs and request IDs cannot be reused within the channel's lifetime. A valid
reply that races a send acknowledgement is buffered, then takes effect only after
successful delivery and before expiry. Failed delivery denies, a hung send expires,
and `close()` denies all pending requests. Both YES and NO must name the request;
this supports concurrent requests even when their four-digit codes collide.
The Spectrum transport requires a nonempty returned message ID; an undefined send
result cannot release a buffered approval. This acknowledgement confirms SDK acceptance,
while phone delivery still needs live verification.

The terminal simulator gets the route from the delivered request. It is a local
console trust boundary, not remote authentication. The Spectrum adapter gets
identity from the SDK's authenticated stream and accepts only direct, inbound,
plain-text iMessages on the resolved line. It rejects outbound echoes, groups,
non-text content, mismatched space IDs, repeated message IDs, and timestamps outside
a bounded 30-second clock tolerance around bridge startup/current time. Invalid
timestamps fail closed. Request IDs must be globally unique; the channel's absolute
expiry still applies without a grace period. Use a normal new message for the displayed command; quoted
reply content is not interpreted by this spike.

## Spectrum cloud and phone setup

The cloud bridge in `spectrum.ts` is implemented and tested through an injected
Spectrum runtime. It lazy-loads `spectrum-ts` only for `imessage`. The shared SDK
dependency `spectrum-ts@12.10.1` is recorded in the server manifest/lockfile. Actual SDK exports load successfully and
installed declarations/source match the bridge API. Strict TypeScript 5.9.3 checking
validates the local bridge; dynamic import assertions do not enforce SDK assignability.
All 86 offline notify tests pass. Live project authentication and shared-pool SDK
initialization also pass. The demo iPhone's exact debug-reported address is registered,
but fresh sends still return `Target not allowed for this project`; delivery and a
phone approval round trip remain unverified. Photon-side tracing is pending. The
tests pass on Node 25.7.0 and Node 22.13.1.

1. Register at [Photon Dashboard](https://app.photon.codes) and create a project.
   Try the HackNC promo code `HACKNC`, then `HACKWITHPHOTON` if needed.
2. Get the project ID and secret from project Settings. Keep them in the team's
   existing ignored secret store and export them into the process environment.
3. Add the demo iPhone's actual iMessage handle under Users. Free/Pro lines accept
   registered handles only. If your Apple ID email is used instead of your phone
   number, confirm it with [Photon debug](https://debug.photon.codes) and register
   the reported handle. Set the full matching address in `SPECTRUM_RECIPIENT_ID`;
   the SDK user resolver preserves the supplied handle rather than normalizing it.
4. The SDK is installed locally. Other checkouts run `npm ci` in `release/server`.
   Connect/configure the cloud line in Dashboard and restart after adding lines.
5. Export the variables below, then run the same demo with `SPECTRUM_PROVIDER=imessage`.
   `connectSpectrum` resolves the supplied user and creates/resolves their DM;
   an optional configured conversation must match that DM. It never sends to an
   arbitrary supplied chat GUID. Shared-pool user/DM resolution is local and does
   not verify registration or delivery. The demo starts its answer deadline after
   connection setup; an acknowledgement still does not prove phone delivery.
6. On the phone, send the exact YES/code/request-ID command as a new text. Repeat
   with NO, wrong code, silence, an old request ID, and a different user's reply.
   Finish with the demo script; production money execution belongs to SkillGate.

| Variable | Use |
|---|---|
| `SPECTRUM_PROVIDER` | `terminal`, `off` (default), or `imessage` |
| `SPECTRUM_PROJECT_ID` | Dashboard project identifier; required for cloud |
| `SPECTRUM_PROJECT_SECRET` | Secret exported from the ignored secret store |
| `SPECTRUM_RECIPIENT_ID` | Registered iMessage phone/email handle; required for phone demo |
| `SPECTRUM_CONVERSATION_ID` | Optional expected DM GUID; mismatch refuses connection |
| `SPECTRUM_IMESSAGE_PHONE` | The line the recipient texts on (Photon dashboard -> Users -> Texts on). Required on the shared pool: without it the SDK can send from another pool line, and Photon refuses with "Target not allowed for this project" even though inbound works |
| `APPROVAL_DEMO_CODE` | Optional four-digit demo override; defaults to a random code |
| `APPROVAL_DEMO_TTL_SECONDS` | Demo deadline in seconds, default 60, maximum 3600 |

The adapter uses `Spectrum(...)`, `imessage(app).user(...)`,
`imessage(app).space.create(...)`, `space.send(...)`, `app.messages`, and `app.stop()`.
Shutdown closes the channel immediately; await `channel.shutdown()` for owned SDK
cleanup. Injected transports belong to the caller and must be closed by that caller.
Stream failure prevents new sends and leaves already pending requests to expire.
SDK failures surface a sanitized error without credentials.

## Handoff to SkillGate

Keep request IDs globally unique, including across process restarts, and retain a
single channel for each authenticated recipient/DM. Pending approvals and dedupe
sets are in memory; restarting abandons them and must never restore an approved
answer. SkillGate owns durable status, a cryptographically random four-digit code,
canonical action hashing, audit events, and the final action-hash recheck before
execution. This channel returns only the outcome required by the shared interface;
it does not make a receipt or authorize a changed action.

## Sources

API shape was checked against [Photon Getting Started](https://photon.codes/docs/spectrum-ts/getting-started),
[iMessage routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing),
and [lifecycle](https://photon.codes/docs/spectrum-ts/custom-events-and-lifecycle).
Spectrum cloud uses gRPC; [webhook Events](https://photon.codes/docs/webhooks/events)
documents no public HTTP send endpoint. The request-ID command also avoids relying
on the reply/thread metadata that native webhook plain-text replies omit. This
implementation consumes the authenticated SDK stream and exposes no webhook route.

## In the running server (T21)

`src/notify/server.ts` connects this channel to the FinGuard server when
`SPECTRUM_PROVIDER=imessage` and `STEWARD_USER_HANDLE` (the customer's registered E.164
handle) are set, through `release/.env`:

- **Approvals.** SkillGate texts every approval request here as well as showing it in the app.
  "YES 4821" approves when exactly one request is pending (otherwise add the request ID, as
  above); "NO" declines. The channel runs with `abstainOnFailure`, so a request it cannot
  deliver settles "expired" (ignored by SkillGate) instead of "denied": an undeliverable text
  never blocks the app's answer.
- **Chat.** Any other text from the bound handle in the bound DM runs a turn with source
  `imessage`; FinGuard's replies for that turn are texted back.
- **Texts first.** Nudges are batched into one text, each kind and title at most once in six
  hours (`DATA_DIR/imessage-nudges-<hash>.json`, one file per handle, named by the first 8 hex
  digits of the handle's SHA-256), so dev restarts do not text the phone again.

Until the handle is listed under Users in the Photon dashboard, Photon answers
`Target not allowed for this project`; the server logs it once and the app keeps working.
Tests: `src/notify/server.test.ts` (fictional runtime, no network).
