import test from 'node:test';import assert from 'node:assert/strict';import {seedLive,defaultProfiles,profilesForPersonas} from '../../mock-nessie/seed-live.ts';
test('sandbox seed saves confirmed creations and does not duplicate completed households',async()=>{
 const state={};let calls=0,saves=0;const paths:string[]=[];
 const request=async(path:string)=>{paths.push(path);return `id-${++calls}`;};
 await seedLive(defaultProfiles,state,request,()=>saves++);assert.equal(calls,20);assert.equal(saves,20);
 await seedLive(defaultProfiles,state,request,()=>saves++);assert.equal(calls,20);assert.ok(paths.every(p=>!p.includes('transfers')));
});
test('invalid seed inputs cannot issue external calls',async()=>{let calls=0;await assert.rejects(seedLive([{...defaultProfiles[0]!,checking:-1}],{},async()=>{calls++;return 'id';},()=>{}));assert.equal(calls,0);});

test('live seed plan matches T40 personas and preserves cents',()=>{
 const profiles=profilesForPersonas(new Date('2026-10-10T16:00:00Z'));
 assert.deepEqual(profiles.map(p=>p.id),['maya','grace','diego-ana','sam','priya']);
 assert.equal(profiles[0]!.checking,4210.55);
});

test('fractional-cent seed balances fail before provider calls',async()=>{
 let calls=0;
 await assert.rejects(seedLive([{...defaultProfiles[0]!,checking:1.001}],{},async()=>{calls++;return 'id';},()=>{}));
 assert.equal(calls,0);
});
