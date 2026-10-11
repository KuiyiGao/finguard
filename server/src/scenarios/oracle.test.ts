import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { monthlyPayment, compareRefinance } from './loans.ts';
import { growthPath, feeDrag } from './investments.ts';
const fixture=JSON.parse(fs.readFileSync(new URL('../../fixtures/scenarios.expected.json',import.meta.url),'utf8'));
test('loan and refinance numbers match independent discounted-cashflow Decimal oracle',()=>{
 for(const c of fixture.loans) assert.ok(Math.abs(monthlyPayment(c.principal,c.apr,c.months)-c.payment)<=.0051);
 for(const c of fixture.refinance) assert.deepEqual(compareRefinance(c.loan,c.offer),c.expected);
});
test('fee drag endpoint matches independent Decimal oracle, including zero fee gap',()=>{
 const c=fixture.feeDrag,d=feeDrag();
 for(const field of ['heldFinal','indexFinal','drag'] as const) assert.equal(d[field],c[field]);
 assert.equal(growthPath(100,0,0,20).at(-1),100);
 assert.equal(growthPath(100,.06,0,0).at(-1),100);
});
