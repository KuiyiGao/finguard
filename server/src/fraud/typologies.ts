import type { RedFlag } from "../types.ts";

export interface Typology {
  id: string;
  name: string;
  query: string;
  signals: RedFlag["signal"][]; // red flags that point to this pattern
  cue: RegExp;
  summary: string;
  advice: string[];
}

export const TYPOLOGIES: Typology[] = [
  {
    id: "safe-account",
    name: "Fake bank alert / safe account",
    query: "bank fraud department asks to move money to a safe account",
    signals: ["safe_account", "impersonation", "urgency"],
    cue: /\b(safe|secure|protected|holding) account\b|\bprotect your (money|funds|savings)\b|\bfraud (dept|department|team|alert)\b/i,
    summary: "Someone posing as your bank says your money is at risk and tells you to move it to a 'safe' account they control.",
    advice: [
      "Do not move money. Your bank will never ask you to transfer money to keep it safe.",
      "Call the number on the back of your card, not a number in the message.",
    ],
  },
  {
    id: "family-emergency",
    name: "Family emergency",
    query: "grandchild in trouble needs money urgently and asks for secrecy",
    signals: ["impersonation", "secrecy", "urgency"],
    cue: /\b(grandma|grandpa|grandson|granddaughter|mom|dad|it'?s me|jail|bail|accident|hospital|lawyer)\b/i,
    summary: "A message claims a relative is in trouble and needs money now, often asking you to keep it secret.",
    advice: ["Hang up and call your relative, or another family member, on a number you already know.", "Do not send money before you have checked."],
  },
  {
    id: "invoice-payee-swap",
    name: "Invoice with changed payment details",
    query: "invoice asks to pay a new account number for a known company",
    signals: ["payee_changed", "name_mismatch"],
    cue: /\b(invoice|bill|amount due|account|bank details|payment details)\b/i,
    summary: "An invoice or notice from a company you know asks you to pay a different account than the one on file.",
    advice: ["Pay only to the account already on file.", "Check any change of payment details with the company directly."],
  },
  {
    id: "government-impersonation",
    name: "Government or police impersonation",
    query: "IRS police social security demands immediate payment",
    signals: ["impersonation", "urgency", "unusual_method"],
    cue: /\b(irs|social security|medicare|police|sheriff|officer|court|warrant|government|tax)\b/i,
    summary: "Someone claims to be from a government agency or the police and demands immediate payment.",
    advice: ["Government agencies do not demand payment by text, gift card or crypto.", "Contact the agency through its official website."],
  },
  {
    id: "gift-card-crypto",
    name: "Gift card, crypto or wire demand",
    query: "asked to pay with gift cards crypto or bitcoin ATM",
    signals: ["unusual_method", "urgency"],
    cue: /\b(gift ?cards?|itunes|google play|bitcoin|crypto|btc|usdt|wire|western union|moneygram)\b/i,
    summary: "Anyone who insists on payment by gift card, cryptocurrency or wire is very likely a scammer.",
    advice: ["Do not buy gift cards or crypto to pay someone.", "If you already paid, contact the gift card company or your bank right away."],
  },
  {
    id: "tech-support",
    name: "Tech support",
    query: "computer virus tech support asks for remote access and payment",
    signals: ["impersonation", "urgency"],
    cue: /\b(virus|hacked|computer|remote access|tech support|apple support|microsoft|refund department)\b/i,
    summary: "A pop-up or caller claims your device or account is compromised and asks for access or payment.",
    advice: ["Do not give remote access or pay for unrequested support.", "Close the message and contact the company through its own website."],
  },
  {
    id: "investment-scam",
    name: "Investment scam",
    query: "investment pitch guarantees high daily or monthly returns on a crypto platform",
    signals: ["guaranteed_returns", "unusual_method", "urgency"],
    cue: /\b(invest\w*|profits?|trading|portfolio|(daily|weekly|monthly|guaranteed) returns)\b/i, // not "crypto" alone: that is gift-card-crypto
    summary: "Someone promises guaranteed or unusually high returns, often on a crypto platform, and pushes you to invest before you can check.",
    advice: [
      "No one can guarantee investment returns; treat that promise as a warning sign.",
      "Do not send money or crypto to a platform or wallet from an unexpected message. Check the seller independently first.",
    ],
  },
  {
    id: "loan-relief",
    name: "Loan relief with an upfront fee",
    query: "company wants an upfront fee to forgive student loans or give debt relief",
    signals: ["upfront_fee", "urgency", "secrecy", "impersonation"],
    cue: /\b(forgiv\w*|debt relief|debt settlement|loan relief|consolidat\w*|repayment plan|student aid|discharge\w*)\b/i, // not a plain "loan payment due"
    summary: "A company asks for a fee before it does anything to forgive, reduce or consolidate your loans or debts.",
    advice: [
      "Do not pay up front for loan forgiveness or debt relief.",
      "Federal student loan programs are free: use StudentAid.gov or call your loan servicer on a number you already know.",
    ],
  },
];
