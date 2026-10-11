import { PERSONAS } from '../src/demo/personas.ts';
import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export interface SeedProfile{id:string;name:string;checking:number;savings:number;billAmount:number}
export function profilesForPersonas(now = new Date()): SeedProfile[] {
 return PERSONAS.map(persona => {
  const {household}=persona.build(now);
  const checking=household.accounts.find(a=>a._id==='acct-checking');
  const savings=household.accounts.find(a=>a._id==='acct-savings');
  const bill=[...household.bills].sort((a,b)=>a.payment_date.localeCompare(b.payment_date))[0];
  if(!checking||!savings||!bill)throw new Error('Persona seed requires checking, savings and a bill');
  return {id:persona.id,name:`Fictional ${persona.name}`,checking:checking.balance,savings:savings.balance,billAmount:bill.payment_amount};
 });
}
export const defaultProfiles=profilesForPersonas();
const validMoney=(v:number)=>Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<1e-7;

type State=Record<string,{customer?:string;checking?:string;savings?:string;bill?:string}>;
export async function seedLive(profiles:SeedProfile[],state:State,request:(path:string,body:unknown)=>Promise<string>,save:()=>void){
 for(const p of profiles)if(!/^[a-z0-9-]+$/.test(p.id)||!p.name||![p.checking,p.savings].every(v=>validMoney(v))||!validMoney(p.billAmount)||p.billAmount<=0)throw new Error('Invalid profile');
 if(new Set(profiles.map(p=>p.id)).size!==profiles.length)throw new Error('Duplicate profile');
 for(const p of profiles){const row=state[p.id]??(state[p.id]={});
  if(!row.customer){row.customer=await request('/customers',{first_name:'Steward Demo',last_name:p.name,address:{street_number:'100',street_name:'Fictional Lane',city:'Chapel Hill',state:'NC',zip:'27514'}});save();}
  for(const type of ['checking','savings'] as const)if(!row[type]){row[type]=await request(`/customers/${row.customer}/accounts`,{type:type==='checking'?'Checking':'Savings',nickname:`Steward Demo ${p.id} ${type}`,balance:p[type],rewards:0});save();}
  if(!row.bill){row.bill=await request(`/accounts/${row.checking}/bills`,{status:'pending',payee:'Fictional Utility',nickname:'Steward simulated obligation',payment_amount:p.billAmount,payment_date:new Date(Date.now()+2*86400000).toISOString().slice(0,10)});save();}
 }return state;
}
async function main(){
 const arg=process.argv.find(a=>a.startsWith('--profiles='));const profiles:SeedProfile[]=arg?JSON.parse(fs.readFileSync(arg.slice(11),'utf8')):defaultProfiles;
 if(!process.argv.includes('--apply')){console.log(JSON.stringify({mode:'plan',profiles,scope:'Customers/accounts/bills only; no transfers. Purchases absent from current official schema.'},null,2));return;}
 const key=process.env.NESSIE_API_KEY;if(!key)throw new Error('NESSIE_API_KEY missing');
 const file=process.env.NESSIE_SEED_CHECKPOINT??'data/nessie-seed.json';fs.mkdirSync('data',{recursive:true});
 const state:State=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
 const pending=file+'.pending';if(fs.existsSync(pending))throw new Error('Prior creation outcome unknown; reconcile before rerunning');
 const save=()=>{fs.writeFileSync(file,JSON.stringify(state,null,2)+'\n',{mode:0o600});if(fs.existsSync(pending))fs.unlinkSync(pending);};
 await seedLive(profiles,state,async(path,body)=>{
  fs.writeFileSync(pending,JSON.stringify({path,body}),{mode:0o600,flag:'wx'});
  const url=new URL(path,'https://prod-api.nessieisreal.com');url.searchParams.set('key',key);
  let r:Response;try{r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json'},body:JSON.stringify(body)});}catch{throw new Error('Request outcome unknown; reconcile before rerunning');}
  if(!r.ok){if(r.status>=400&&r.status<500)fs.unlinkSync(pending);throw new Error(`Sandbox creation HTTP ${r.status}; no automatic retry`);}
  let decoded:unknown;try{decoded=await r.json();}catch{throw new Error('Creation outcome unknown; reconcile before rerunning');}
  const data=decoded as {objectCreated?:{_id?:string};_id?:string};const id=data.objectCreated?._id??data._id;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('Creation outcome unknown; reconcile before rerunning');return id;
 },save);
 console.log(JSON.stringify({scope:'Nessie sandbox only',households:state,purchases:'Not seeded: absent from official schema',transfers:'Not attempted'},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e instanceof Error?e.message:'Seed failed');process.exitCode=1;});
