import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Retriever, RagHit } from '../types.ts';

export type KnowledgeDocument = { id: string; title: string; collection: 'savings' | 'plans' | 'fees' | 'scams' | 'investments' | 'loans' | 'contracts'; source_url?: string; body: string };
const tokenize = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export async function loadKnowledgeBase(directory: string): Promise<KnowledgeDocument[]> {
  const documents: KnowledgeDocument[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { documents.push(...await loadKnowledgeBase(path)); continue; }
    if (!entry.name.endsWith('.md')) continue;
    const text = await readFile(path, 'utf8');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error(`Missing KB frontmatter: ${entry.name}`);
    const fields = Object.fromEntries(match[1]!.split(/\r?\n/).filter(Boolean).map(line => {
      const colon = line.indexOf(':'); if (colon < 1) throw new Error('Invalid KB frontmatter');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '')];
    }));
    if (!fields.id || !fields.title || !['savings', 'plans', 'fees', 'scams', 'investments', 'loans', 'contracts'].includes(fields.collection ?? '')) throw new Error('Invalid KB metadata');
    if (fields.source_url && !/^https:\/\//.test(fields.source_url)) throw new Error('KB sources must use HTTPS');
    documents.push({ ...fields, body: match[2] } as KnowledgeDocument);
  }
  if (new Set(documents.map(d => d.id)).size !== documents.length) throw new Error('Duplicate KB ids');
  return documents;
}
export function loadKnowledgeBaseSync(directory: string): KnowledgeDocument[] {
  const docs: KnowledgeDocument[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { docs.push(...loadKnowledgeBaseSync(path)); continue; }
    if (!entry.name.endsWith('.md')) continue;
    const match = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error(`Missing KB frontmatter: ${entry.name}`);
    const fields = Object.fromEntries(match[1]!.split(/\r?\n/).filter(Boolean).map(line => {
      const colon = line.indexOf(':'); if (colon < 1) throw new Error('Invalid KB frontmatter');
      return [line.slice(0,colon).trim(), line.slice(colon+1).trim().replace(/^['"]|['"]$/g, '')];
    }));
    if (!fields.id || !fields.title || !['savings','plans','fees','scams','investments','loans','contracts'].includes(fields.collection ?? '') || !/^https:\/\//.test(fields.source_url ?? '')) throw new Error('Invalid KB metadata');
    docs.push({ ...fields, body: match[2] } as KnowledgeDocument);
  }
  if (new Set(docs.map(d => d.id)).size !== docs.length) throw new Error('Duplicate KB ids');
  return docs;
}
export class BM25Retriever implements Retriever {
  private chunks: { document: KnowledgeDocument; body: string; tokens: string[] }[];
  constructor(documents: KnowledgeDocument[]) {
    this.chunks = documents.flatMap(document => document.body.split(/\n(?=## )/).filter(s => s.trim()).map(body => ({ document, body, tokens: tokenize(document.title + ' ' + body) })));
  }
  async search(query: string, opts: { collection?: KnowledgeDocument['collection']; k?: number } = {}): Promise<RagHit[]> {
    const k = opts.k ?? 3;
    if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error('k must be an integer from 1 to 50');
    if (query.length > 2000) throw new Error('Query too long');
    const chunks = this.chunks.filter(c => !opts.collection || c.document.collection === opts.collection);
    if (!chunks.length) return [];
    const terms = [...new Set(tokenize(query))];
    const avg = chunks.reduce((s, c) => s + c.tokens.length, 0) / chunks.length || 1;
    const hits = chunks.map(c => {
      let score = 0;
      for (const term of terms) {
        const frequency = c.tokens.filter(t => t === term).length;
        const df = chunks.filter(x => x.tokens.includes(term)).length;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * c.tokens.length / avg));
      }
      return { docId: c.document.id, title: c.document.title, excerpt: c.body.slice(0, 600),
        ...(c.document.source_url ? { url: c.document.source_url } : {}), score };
    }).filter(h => h.score > 0).sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));
    return hits.filter((h, i) => hits.findIndex(x => x.docId === h.docId) === i).slice(0, k);
  }
}
export async function createRetriever(directory: string, mode = process.env.RAG_MODE ?? 'mock', liveFactory?: (docs: KnowledgeDocument[]) => Promise<Retriever>): Promise<Retriever> {
  const docs = await loadKnowledgeBase(directory);
  if (mode === 'mock') return new BM25Retriever(docs);
  if (mode === 'live' && liveFactory) return liveFactory(docs);
  throw new Error('Live RAG requires an injected embeddings retriever; no silent mock fallback');
}
