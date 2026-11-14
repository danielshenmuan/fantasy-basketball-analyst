#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { analyze, type AnalyzeInput } from "./analyze";
import type { Snapshot } from "./snapshot";

const USAGE = `Usage: analyze.mjs --snapshot <snapshot.json> [--input <request.json>]
Reads a request as JSON from --input or stdin:
  {"league":{"teams":12,"roster_spots":13},"roster":[{"name":"Nikola Jokic"},{"name":"Max Strus","status":"IL"}]}
Prints the team assessment as JSON.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
  } else {
    const snapPath = arg("--snapshot");
    if (!snapPath) throw new Error("missing --snapshot <file>");
    const snapshot = JSON.parse(readFileSync(snapPath, "utf8")) as Snapshot;
    const inputPath = arg("--input");
    const input = JSON.parse(readFileSync(inputPath ?? 0, "utf8")) as AnalyzeInput;
    console.log(JSON.stringify(analyze(input, snapshot), null, 2));
  }
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), usage: USAGE }));
  process.exit(1);
}
