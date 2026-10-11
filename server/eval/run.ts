import path from "node:path";
import fs from "node:fs";
import { SERVER_ROOT } from "../src/config.ts";
import { EVAL_ROOT, printScorecard, runCaseSet, scorecardExitCode, writeScorecard } from "./runner.ts";
import { InputError, loadCaseSet } from "./schema.ts";

function canonicalPath(file: string): string {
  if (fs.existsSync(file)) return fs.realpathSync(file);
  const parent = path.dirname(file);
  return parent === file ? file : path.join(canonicalPath(parent), path.basename(file));
}

function outputPath(input: string, output: string): string {
  const destination = canonicalPath(output);
  const relative = path.relative(canonicalPath(SERVER_ROOT), destination);
  if (destination === canonicalPath(input)) throw new InputError("Output must not replace the input dataset");
  if (path.extname(destination) !== ".json") throw new InputError("Custom output must be a JSON scorecard, never an audit JSONL file");
  if (relative !== "eval/last-result.json" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    throw new InputError("Within the server, output may only replace eval/last-result.json");
  return output;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 2) {
    console.error("Usage: npm run eval -- [cases-file] [result-file]");
    return 3;
  }
  let dataset;
  let output: string;
  try {
    const input = args[0] ? path.resolve(args[0]) : path.join(EVAL_ROOT, "cases.json");
    dataset = loadCaseSet(input);
    output = outputPath(input, args[1] ? path.resolve(args[1]) : path.join(EVAL_ROOT, "last-result.json"));
  }
  catch (error) {
    console.error(`Invalid eval input: ${error instanceof Error ? error.message : "validation failed"}. Previous scorecard retained. Exit 3.`);
    return 3;
  }
  const result = await runCaseSet(dataset);
  printScorecard(result);
  try { writeScorecard(output, result); }
  catch {
    console.error("Could not publish the complete scorecard. Previous scorecard retained. Exit 4.");
    return 4;
  }
  const code = scorecardExitCode(result);
  console.log(`Exit ${code}: ${code === 2 ? "runner error(s)" : code === 1 ? "verdict mismatch(es)" : "all verdicts matched"}. Complete scorecard written.`);
  return code;
}

process.exitCode = await main();
