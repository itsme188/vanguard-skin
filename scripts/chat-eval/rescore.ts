/**
 * rescore.ts: score saved golden answers again, offline.
 *
 * No server, no network, no model call, nothing spent. It reads the answer
 * text and the tool names a run saved (`run-golden.ts --show-answers` JSON),
 * derives the expected figures from the SAME eval database the run used, for
 * the run's own day, and applies today's checks (golden.ts) with the pure
 * scorer. The database is opened read-only, and the guard refuses any file
 * named vanguard.db and any database without the eval marker.
 *
 *   npx tsx scripts/chat-eval/rescore.ts --db data/chat-eval/eval-v2.db --today 2026-11-12 \
 *     data/chat-eval/run4-4a-Q*.json
 *
 * Prints one line per answer (pass or the failed checks) and the pass count
 * per file prefix.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { liveDbRefusal, readEvalMarker, resolvedDbPath } from "./db-guard";
import { readManifest } from "./manifest";
import { deriveExpected } from "./expected";
import { buildGolden } from "./golden";
import { scoreAnswer } from "./scorer";

interface SavedQuestion {
  id: string;
  answer?: string;
  toolCalls?: string[];
  finishReason?: string | null;
  status?: string;
}

function main(argv: string[]): number {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbArg = get("--db");
  const today = get("--today");
  const refusal = liveDbRefusal(dbArg);
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    console.error("--today YYYY-MM-DD (the run's own Eastern day) is required");
    return 2;
  }
  const flagValues = new Set([dbArg, today]);
  const files = argv.filter((a) => a.endsWith(".json") && !flagValues.has(a));
  const dbPath = resolvedDbPath(dbArg as string);
  console.log(`database: ${dbPath} (read-only)`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (readEvalMarker(db) === null) {
      console.error(`refusing ${dbPath}: no eval marker`);
      return 2;
    }
    const manifest = readManifest(db);
    if (!manifest) {
      console.error(`refusing ${dbPath}: the eval manifest is missing`);
      return 2;
    }
    const golden = Object.fromEntries(buildGolden(deriveExpected(db, manifest, today)).map((q) => [q.id, q]));
    const tally = new Map<string, { pass: number; total: number }>();
    for (const file of files) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { questions?: SavedQuestion[] };
      const prefix = path.basename(file).replace(/-Q\d+.*$/, "");
      for (const q of saved.questions ?? []) {
        const g = golden[q.id];
        if (!g || q.answer === undefined) continue;
        const r = scoreAnswer({ text: q.answer, toolCalls: q.toolCalls ?? [], finishReason: q.finishReason ?? null }, g.checks);
        const t = tally.get(prefix) ?? { pass: 0, total: 0 };
        t.total++;
        if (r.pass) t.pass++;
        tally.set(prefix, t);
        const failed = r.checks.filter((c) => !c.pass).map((c) => `${c.label} (${c.detail})`);
        console.log(`${prefix} ${q.id}: ${r.pass ? "PASS" : `FAIL${r.gate ? ` [${r.gate}]` : ""} ${failed.join("; ")}`}`);
      }
    }
    for (const [prefix, t] of tally) console.log(`${prefix}: ${t.pass}/${t.total}`);
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
