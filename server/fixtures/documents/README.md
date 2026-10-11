# Fictional document samples

These three documents are original, fictional samples for the document turn
(`POST /api/documents/review`) and the desk's Documents page (`GET /api/documents/samples`).
Every company, bank, person and account number in them is made up. They describe the
simulated demo household (persona `maya`); no real account, bill or offer is involved.

| File | Kind | What it shows | Proposed action and SkillGate |
|---|---|---|---|
| `cloudgym-contract.txt` | contract | The CloudGym membership agreement: six clauses (auto-renewal, notice by certified mail, early termination fee, annual fee, price changes, arbitration) | Cancel `sub-gym`: asks for the customer's code |
| `october-statement.txt` | statement | A checking statement (Sep 10 to Oct 9, 2026) from Fernhollow Bank, NA, a simulated bank: two overdraft fees, a monthly maintenance fee, and the balance falling to $23.17 before the rent payment | Move from savings to checking before the next bill, sized from the live balance, the bill on file and the policy buffer; proposed only when checking is short |
| `ridgeline-invoice.txt` | invoice | An invoice from Ridgeline Plumbing & Heating, a fictional contractor saved as a payee in the demo persona, that says the bank details changed and gives a new account number | Pay the account written in the invoice: denied, because that account appears only in the document and differs from the payee on file |

`cloudgym-contract.txt` is exactly `contractText()` from `src/scenarios/data.ts` (a test keeps
them equal). The server serves each file with `\r\n` turned into `\n` and the trailing newline
removed; mark offsets (`start`, `end`) index into that served text.

## Numbers the document turn computes

Everything below is computed in code from the text (and, where named, from trusted records);
an independent check can recompute it from these files.

- Contract: if it renews, 12 months x $29.99 dues (the subscription on file) + $49 annual
  fee = $408.88. The card's metric stays the $199 early termination fee written in the text.
- Statement: fees on the statement = the fee lines ($20.00 + $20.00 + $12.00) = $52.00;
  fees per year at this rate = $52.00 x 12 statements = $624.00. The running balance is
  consistent: $348.70 at the start, $4,210.55 at the end, deposits $6,400.00, other debits
  $2,486.15. The low balance marked is $23.17 on Sep 15, the last balance before the
  account went negative (the Maple Court Apartments rent).
- Statement move: bill + buffer - live checking balance, using the next unpaid bill on file,
  the policy's cash-flow buffer and the bank's checking balance. None of these come from the
  document. With the default household (checking $4,210.55, next bill $84.20, buffer $500)
  the result is negative, so no move is proposed.
- Invoice: labor 4 hours x $160.00 = $640.00; total = $640.00 + $225.00 parts = $865.00,
  equal to the amount due; days from the invoice date (Oct 8, 2026) to the due date
  (Oct 15, 2026) = 7; days until due = the due date minus today.
