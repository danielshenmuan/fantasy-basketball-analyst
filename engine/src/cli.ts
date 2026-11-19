#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { analyze, type AnalyzeInput } from "./analyze";
import type { Snapshot } from "./snapshot";

const USAGE = `Usage: analyze.mjs --snapshot <snapshot.json | https://url> [--input <request.json>]
Reads a request as JSON from --input or stdin:
  {"league":{"teams":12,"roster_spots":13},"roster":[{"name":"Nikola Jokic"},{"name":"Max Strus","status":"IL"}]}
Prints the team assessment as JSON.`;

async function loadSnapshot(src: string): Promise<Snapshot> {
  if (!src.startsWith("https://")) return JSON.parse(readFileSync(src, "utf8")) as Snapshot;
  const r = await fetch(src, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`could not download the snapshot (HTTP ${r.status})`);
  return (await r.json()) as Snapshot;
}

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
    const snapshot = await loadSnapshot(snapPath);
    const inputPath = arg("--input");
    const input = JSON.parse(readFileSync(inputPath ?? 0, "utf8")) as AnalyzeInput;
    console.log(JSON.stringify(analyze(input, snapshot), null, 2));
  }
} catch (e) {
  console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), usage: USAGE }));
  process.exit(1);
}
