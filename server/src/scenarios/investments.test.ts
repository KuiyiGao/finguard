import assert from "node:assert/strict";
import { test } from "node:test";
import { feeDrag, growthPath, investmentTotal } from "./investments.ts";

test("fee drag matches an independent compound-growth calculation", () => {
  const d = feeDrag();
  const held = 12_480 * (1 + 0.06 - 0.0062) ** 20;
  const index = 12_480 * (1 + 0.06 - 0.0004) ** 20;
  assert.ok(Math.abs(d.heldFinal - held) < 0.01, `${d.heldFinal} vs ${held}`);
  assert.ok(Math.abs(d.indexFinal - index) < 0.01, `${d.indexFinal} vs ${index}`);
  assert.ok(Math.abs(d.drag - (index - held)) < 0.02);
  assert.equal(d.heldPath.length, 21);
  assert.equal(d.heldPath[0], 12_480);
  assert.equal(d.feesThisYearHeld, 77.38);
  assert.equal(d.feesThisYearIndex, 4.99);
  assert.deepEqual(growthPath(100, 0.05, 0, 2), [100, 105, 110.25]);
});

test("the simulated allocation adds up", () => {
  assert.equal(investmentTotal(), 12_480 + 18_900 + 2_600);
});
