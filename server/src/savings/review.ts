import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createMockNessie } from '../../mock-nessie/server.ts';
import { seedCashflowScenario, seedHousehold } from '../../mock-nessie/seed.ts';
import { loadConfig } from '../config.ts';
import { createApp } from '../gateway/app.ts';
import { buildTianjiaServices } from './integration.ts';

export async function startReview(port = 8791) {
  let state = seedCashflowScenario(new Date());
  const mock = createMockNessie(state);
  await new Promise<void>(r => mock.listen(0,'127.0.0.1',r));
  const address = mock.address(); if (!address || typeof address === 'string') throw new Error('Mock port missing');
  const base = `http://127.0.0.1:${address.port}`;
  const config = loadConfig({ NESSIE_MODE:'mock', APPROVAL_TTL_SECONDS:'60' });
  let runtime = await buildTianjiaServices(config,base,() => state.observedAt);
  let app = createApp(runtime.services);
  const server = createServer(async(req,res) => {
    const json = (status:number,body:unknown) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(body)); };
    const url = new URL(req.url ?? '/','http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'"});
        return res.end(await readFile(new URL('./review.html',import.meta.url),'utf8'));
      }
      if (req.method === 'GET' && url.pathname === '/review/state') return json(200,{ accounts:state.accounts, bills:state.bills,
        policy:runtime.services.policy.current(), needsConsent:!runtime.services.policy.consent(),
        approvals:runtime.services.gate.pendingApprovals(), outcomes:[...runtime.outcomes.values()], trace:runtime.services.trace.list(), mock:true });
      if (req.method === 'POST' && url.pathname.startsWith('/review/')) {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403,{error:'Cross-origin requests rejected'});
        let raw=''; for await (const chunk of req) {raw+=chunk;if(raw.length>16000) return json(413,{error:'Body too large'});}
        const body=JSON.parse(raw || '{}');
        if (url.pathname === '/review/reset') {
          if (runtime.services.gate.pendingApprovals().length) return json(409,{error:'Resolve pending approval before resetting'});
          const next = body.scenario === 'household' ? seedHousehold(new Date()) : seedCashflowScenario(new Date());
          Object.assign(state,next);
          runtime=await buildTianjiaServices(config,base,() => state.observedAt); app=createApp(runtime.services);
          return json(200,{ok:true,scenario:body.scenario ?? 'cashflow'});
        }
        if (url.pathname === '/review/preview') return json(200,await runtime.preview(body.action,body.buffer,body.horizon));
        if (url.pathname === '/review/execute') {
          let sent=false;
          const respond=(status:number,result:unknown)=>{if(!sent){sent=true;json(status,result);}};
          const result=await runtime.execute(body.id,body.actionHash,{onApprovalRequested:approval=>respond(202,{status:'awaiting_approval',approval})});
          respond(200,result); return;
        }
      }
      if (url.pathname.startsWith('/api/demo/')) return json(409,{error:'Use /review/reset to reset the local bank and composed modules together'});
      return app(req,res);
    } catch(error) { if (!res.headersSent) return json(400,{error:error instanceof Error ? error.message : 'Review failed'}); }
  });
  await new Promise<void>(r=>server.listen(port,'127.0.0.1',r));
  return {server,mock,state,getRuntime:()=>runtime,close:async()=>{for(const a of runtime.services.gate.pendingApprovals()) runtime.services.gate.answer(a.id,false,undefined);await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>mock.close(()=>r()))]);}};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) startReview(Number(process.env.TIANJIA_REVIEW_PORT ?? 8791)).then(({server})=>console.log(`FinGuard action review: http://127.0.0.1:${(server.address() as {port:number}).port}`)).catch(e=>{console.error(e.message);process.exitCode=1;});
