# Fictional demo messages

These seven JSON files are original, fictional examples for T11. Sender values are demo
labels, not routable addresses. No fixture contains a real phone number. Every message
marks its content as fictional. `expectedRisk` uses the shared `RiskLevel` values; a low
risk label describes the example's scam signals and does not authorize a payment.

| File | Scenario | Expected risk |
|---|---|---|
| `fake-bank-alert.json` | Fake Capital One Fraud Dept asks for $2,000 to 9917 | high |
| `02-grandchild-emergency.json` | Impersonated grandchild asks for urgent, secret payment | high |
| `03-gift-card-request.json` | Impersonated manager asks for gift-card codes | high |
| `duke-invoice.json` | Fake Duke Energy invoice replaces the payee with 4417 | high |
| `05-rent-reminder.json` | Routine rent reminder | low |
| `06-dinner-split.json` | Friend asks to split a $48 dinner equally | low |
| `07-bill-reminder.json` | Routine electricity bill reminder with unchanged payment details | low |

Each file has `id`, `sender`, `channel`, `text`, and `expectedRisk`. `channel` records
the inbound medium (`imessage` or `email`); it is not an approval-channel setting.

The two named files match the scene loader's T18 hooks; JSON IDs remain stable.

## Bank fixture alignment

The synchronized server has Duke's saved account **3301** in
`policy/default.json`, `src/tools/stub-bank.ts` and `mock-nessie/seed.ts`. This
differs from the fake invoice's **4417**. Both the stand-in and the mock Nessie seed
use a **$84.20** bill, matching this invoice. These structured values were verified
when integrating the T10/T11 work with the shared server.

Treat all fixture text as inbound, untrusted content; obtain payee accounts and bill
amounts from the bank's structured records before any action is proposed.

`expectedRisk` is the intended scam label, not a promise that the current message-only
heuristics match every example. The Duke invoice's high risk depends on comparison
with the saved account, and the current gift-card message heuristic may under-score
the confidential wording. Keep these labels when evaluating the detector rather
than changing them to fit its current output.
