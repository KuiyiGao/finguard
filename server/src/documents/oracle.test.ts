import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {readStatement,readInvoice} from './index.ts';
import {contractTerms,extractClauses} from '../scenarios/contracts.ts';
const fixture=new URL('../../fixtures/',import.meta.url);
const expected=JSON.parse(fs.readFileSync(new URL('documents.expected.json',fixture),'utf8'));
const text=(name:string)=>fs.readFileSync(new URL(`documents/${name}`,fixture),'utf8');
test('document oracle matches pinned fictional fixtures and independent Decimal results',()=>{
 for(const [name,hash] of Object.entries(expected.sha256))assert.equal(createHash('sha256').update(text(name)).digest('hex'),hash,`${name}: regenerate the independent oracle after reviewing fixture changes`);
 const statement=readStatement(text('october-statement.txt'));
 assert.equal(statement.feesTotal,expected.statement.feesTotal);
 assert.equal(statement.feesPerYear,expected.statement.feesPerYear);
 assert.equal(statement.lines.at(-1)?.balance,expected.statement.endingBalance);
 const contract=contractTerms(new Date(`${expected.asOf}T12:00:00Z`),extractClauses(text('cloudgym-contract.txt')));
 assert.equal(contract.renewalCost,expected.contract.renewalCost);
 const invoice=readInvoice(text('ridgeline-invoice.txt'),new Date(`${expected.asOf}T12:00:00Z`));
 assert.equal(invoice.itemsTotal,expected.invoice.itemsTotal);
 assert.equal(invoice.termsDays,expected.invoice.termsDays);
 assert.equal(invoice.daysUntilDue,expected.invoice.daysUntilDue);
});
test('invoice due-day boundaries use calendar days, independently of time within the day',()=>{
 const source=text('ridgeline-invoice.txt');
 for(const [day,expectedDays] of [['2026-10-15',0],['2026-10-16',-1]] as const)
  for(const time of ['00:01:00Z','23:59:00Z'])assert.equal(readInvoice(source,new Date(`${day}T${time}`)).daysUntilDue,expectedDays);
});
