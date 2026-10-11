import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedHousehold } from '../../mock-nessie/seed.ts';
import { createMockNessie } from '../../mock-nessie/server.ts';
import { createBankAdapters } from '../bank/index.ts';
import { createRetriever } from '../rag/index.ts';
import { EvidenceSavingsEngine } from './index.ts';

export const demoOptions = {
  reserve: 2000, apy: 0.04, currentApy: 0,
  unusedMerchantIds: ['gym', 'music'], // not 'stream': the Paramount+ trial is about to convert to paid, it is no charge marked unused
  internetOffer: { billId: 'internet-bill', monthlyPrice: 55, label: 'AT&T Fiber 300', mock: true },
  pastLateFeePurchaseIds: ['p-fee'],
};
export async function startDemo(port = 8790) {
  const now = new Date('2026-10-10T16:00:00Z');
  const mock = createMockNessie(seedHousehold(now));
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address(); if (!address || typeof address === 'string') throw new Error('No mock port');
  const bank = createBankAdapters({ mode: 'mock', baseUrl: `http://127.0.0.1:${address.port}` });
  const rag = await createRetriever(fileURLToPath(new URL('../rag/fixtures/kb/', import.meta.url)), 'mock');
  const engine = new EvidenceSavingsEngine(bank, rag, { ...demoOptions, now: () => now });
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'GET') return json(405, { error: 'This prototype offers read-only demonstrations' });
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'" });
        return res.end(await readFile(new URL('./demo.html', import.meta.url), 'utf8'));
      }
      if (url.pathname === '/demo/report') return json(200, await engine.report());
      if (url.pathname === '/demo/accounts') return json(200, await bank['bank.get_accounts']!.run({}));
      if (url.pathname === '/demo/provenance') return json(200, await bank['bank.list_purchases']!.run({ account_id: 'acct-checking' }));
      if (url.pathname === '/demo/search') return json(200, await rag.search(url.searchParams.get('q') ?? '', { k: 3 }));
      return json(404, { error: 'Unknown demo route' });
    } catch { return json(500, { error: 'Demo failed; inspect the local server and data configuration' }); }
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, mock, close: async () => { await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => mock.close(() => r()))]); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDemo(Number(process.env.TIANJIA_DEMO_PORT ?? 8790)).then(() => console.log('FinGuard prototype: http://127.0.0.1:8790')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
