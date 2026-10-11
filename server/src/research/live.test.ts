import assert from "node:assert/strict";
import { test } from "node:test";
import { createResearchAdapters, RESEARCH_TOOLS } from "./index.ts";

const live = process.env.LIVE === "1";
const ua = process.env.SEC_USER_AGENT;

test("live: Treasury, FDIC and CFPB answer without a key", { skip: !live && "set LIVE=1" }, async () => {
  const tools = Object.fromEntries(createResearchAdapters().map((a) => [a.spec.name, a]));
  const rates = await tools[RESEARCH_TOOLS.treasuryRates.name]!.run({});
  assert.equal(rates.ok, true, rates.error);
  const bank = await tools[RESEARCH_TOOLS.fdicBank.name]!.run({ name: "Capital One" });
  assert.equal((bank.data as { listed: boolean }).listed, true, bank.error);
  const complaints = await tools[RESEARCH_TOOLS.cfpbComplaints.name]!.run({ company: "Capital One" });
  assert.ok((complaints.data as { total: number }).total > 0, complaints.error);
});

test("live: SEC filings and facts with SEC_USER_AGENT", { skip: (!live || !ua) && "set LIVE=1 and SEC_USER_AGENT" }, async () => {
  const tools = Object.fromEntries(createResearchAdapters({ secUserAgent: ua }).map((a) => [a.spec.name, a]));
  const facts = await tools[RESEARCH_TOOLS.secFacts.name]!.run({ ticker: "AAPL" });
  assert.equal(facts.ok, true, facts.error);
  assert.equal((facts.data as { live: boolean }).live, true);
  const filings = await tools[RESEARCH_TOOLS.secFilings.name]!.run({ ticker: "MSFT" });
  assert.equal(filings.ok, true, filings.error);
});
