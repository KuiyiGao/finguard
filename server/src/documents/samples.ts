import fs from "node:fs";
import path from "node:path";
import { SERVER_ROOT } from "../config.ts";
import type { DocumentKind } from "./text.ts";

export interface DocumentSample {
  id: string;
  kind: DocumentKind;
  name: string;
  text: string;
  fictional: true;
}

export const SAMPLES_DIR = path.join(SERVER_ROOT, "fixtures", "documents");

const FILES: { id: string; kind: DocumentKind; name: string; file: string }[] = [
  { id: "cloudgym-contract", kind: "contract", name: "CloudGym membership agreement", file: "cloudgym-contract.txt" },
  { id: "october-statement", kind: "statement", name: "October checking statement", file: "october-statement.txt" },
  { id: "ridgeline-invoice", kind: "invoice", name: "Ridgeline Plumbing & Heating invoice", file: "ridgeline-invoice.txt" },
];

export const servedText = (raw: string) => raw.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

let cache: DocumentSample[] | undefined;

export function documentSamples(): DocumentSample[] {
  cache ??= FILES.map(({ file, ...s }) => ({ ...s, text: servedText(fs.readFileSync(path.join(SAMPLES_DIR, file), "utf8")), fictional: true as const }));
  return cache.map((s) => ({ ...s }));
}

export function sampleFor(text: string): DocumentSample | undefined {
  const served = servedText(text);
  return documentSamples().find((s) => s.text === served);
}
