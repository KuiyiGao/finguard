---
id: kb:fees/mock
title: Fictional fee schedule
collection: fees
source_url: https://www.consumerfinance.gov/ask-cfpb/what-can-i-do-if-my-bank-charged-me-a-fee-for-overdrawing-my-account-en-1037/
---
## Mock fees
Fernhollow Bank, NA and this fee schedule are simulated. Amounts are stored in `mock-fees.json` as USD values under each entry's `amountUsd`. These examples are reference material; the mock bank does not assess them and the savings engine does not read this schedule.

| Mock fee entry | Fictional assessment condition | Frequency |
|---|---|---|
| `late-payment` | A fictional bill remains unpaid past its agreed due date | Per missed due date |
| `overdraft` | The illustrative bank covers a check or recurring debit without enough balance | Per covered transaction |
| `nsf` | The illustrative bank returns a check or recurring debit for insufficient funds | Per returned transaction |

## Check actual account terms
Whether a bank covers or declines a payment affects which fees might apply. The CFPB distinguishes overdraft charges from returned-payment costs; check your own agreement and transaction type. A past fee is a recorded event, not a quote for a future charge. Asking about a fee does not guarantee a waiver or refund.
