/**
 * filing-summary-replay.ts — runs the armed-print filing summary end to end on
 * SAVED SEC filings, with the REAL model call (spec "Verification the owner
 * will see", R10). It spends money: one paid call per section.
 *
 * What it does:
 *   1. Opens a database: `--db <path>` or `REPAIR_DB_PATH`, else a migrated
 *      in-memory database (the default). The path is printed first. A path
 *      whose file name is `vanguard.db` (the live database's name) is refused.
 *   2. Seeds a synthetic earnings event (`--symbol`, `--date`, `--slot`) and
 *      the security row (`--name`), and pre-print bogey rows parsed from
 *      `--bogeys <file>` (see `parseBogeyDump`).
 *   3. Reads every `<accession>-index-headers.html` in `--dir`, inserts each
 *      filing and its documents as the poller would (same skip rule, same
 *      earnings/companion classification), pointing each fetched document at
 *      the saved copy in the same folder.
 *   4. startRun + runNextSection until idle, with the real
 *      `generateObjectWithModel`. The push hook is replaced by a no-op.
 *   5. Prints counts, every claim with its status and reasons, each section's
 *      usage, wall time and cost; writes the share page and a JSON dump of the
 *      FullView to `--out`.
 *
 * Flags: --dir <folder> (required) · --family sonnet|opus|fable (opus) ·
 *   --effort medium|high (high) · --only-earnings (drop companions) ·
 *   --bogeys <file> · --env <file> (reads ONLY ANTHROPIC_API_KEY from it; never
 *   printed) · --out <folder> (default: the OS temp folder) · --db <path> ·
 *   --symbol / --name / --date / --slot.
 *
 * Run FROM THE REPO ROOT (tsx resolves the `@/` alias off the cwd's tsconfig):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/filing-summary-replay.ts \
 *     --dir tests/fixtures/real/filing-summary/<folder> --family opus --effort high \
 *     --bogeys <file> --env <path to .env.local> --out <scratch folder>
 *
 * Nothing in this file carries a real figure; every figure comes from the
 * input files at run time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- args

interface Args {
  dir: string;
  family: "sonnet" | "opus" | "fable";
  effort: "medium" | "high";
  onlyEarnings: boolean;
  bogeys: string | null;
  env: string | null;
  out: string;
  db: string | null;
  symbol: string;
  name: string;
  date: string;
  slot: "AMC" | "BMO";
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const dir = get("--dir");
  if (!dir) throw new Error("--dir <folder of saved filings> is required");
  const family = (get("--family") ?? "opus") as Args["family"];
  if (!["sonnet", "opus", "fable"].includes(family)) throw new Error("--family: sonnet | opus | fable");
  const effort = (get("--effort") ?? "high") as Args["effort"];
  if (!["medium", "high"].includes(effort)) throw new Error("--effort: medium | high");
  const slot = (get("--slot") ?? "AMC").toUpperCase() as Args["slot"];
  if (!["AMC", "BMO"].includes(slot)) throw new Error("--slot: AMC | BMO");
  const date = get("--date") ?? "2026-10-21";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date: YYYY-MM-DD");
  return {
    dir: path.resolve(dir),
    family,
    effort,
    onlyEarnings: argv.includes("--only-earnings"),
    bogeys: get("--bogeys"),
    env: get("--env"),
    out: path.resolve(get("--out") ?? path.join(os.tmpdir(), "filing-summary-replay")),
    db: get("--db") ?? process.env.REPAIR_DB_PATH ?? null,
    symbol: (get("--symbol") ?? "META").toUpperCase(),
    name: get("--name") ?? "Meta Platforms, Inc.",
    date,
    slot,
  };
}

/** Reads ONLY `ANTHROPIC_API_KEY` from a dotenv file into process.env. Never prints it. */
function loadApiKey(file: string): void {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) process.env.ANTHROPIC_API_KEY = v;
  }
}

// ---------------------------------------------------------------- bogey dump

export interface DumpedBogeyRow {
  label: string;
  source: "newsletter" | "finnhub";
  revenueConsensusUsd: number | null;
  revenueWhisperUsd: number | null;
  uploadedAt: string; // "YYYY-MM-DD 12:00:00" UTC-stored
}

/**
 * The pre-print bogey text dump: one row per line,
 * `label | revenue consensus (USD) | revenue whisper (USD) | guidance notes | notes`.
 * Only the two figure columns are seeded (notes never reach the prompt, R15).
 * A label with "(Finnhub)" is the vendor row; a label ending in `MM/DD` is
 * dated that day of the event's year; any other row is dated the day before
 * the event. Rows with no figure are dropped (they add nothing to a snapshot).
 */
export function parseBogeyDump(text: string, eventDate: string): DumpedBogeyRow[] {
  const year = eventDate.slice(0, 4);
  const dayBefore = new Date(Date.parse(`${eventDate}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const num = (s: string | undefined): number | null => {
    const t = (s ?? "").trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const out: DumpedBogeyRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cols = line.split("|").map((c) => c.trim());
    const label = cols[0];
    const cons = num(cols[1]);
    const whisper = num(cols[2]);
    if (!label || (cons === null && whisper === null)) continue;
    const md = /(\d{1,2})\/(\d{1,2})\s*$/.exec(label);
    const day = md ? `${year}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}` : dayBefore;
    out.push({
      label,
      source: /\(finnhub\)/i.test(label) ? "finnhub" : "newsletter",
      revenueConsensusUsd: cons,
      revenueWhisperUsd: whisper,
      uploadedAt: `${day} 12:00:00`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- prices

/** Published list prices, USD per million tokens (input, output). Thinking bills as output. */
const PRICES: Record<string, { label: string; input: number; output: number }> = {
  sonnet: { label: "Sonnet 5.5", input: 2, output: 10 },
  opus: { label: "Opus 5.5", input: 4, output: 20 },
  fable: { label: "Fable 5.1", input: 10, output: 50 },
};

function costOf(u: Record<string, number>, p: { input: number; output: number }): number {
  return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output) / 1_000_000;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbLabel = args.db ? path.resolve(args.db) : ":memory:";
  console.log(`database: ${dbLabel}`);
  if (args.db && path.basename(args.db) === "vanguard.db") {
    console.error("refused: a file named vanguard.db is the live database's name; use a copy");
    process.exit(2);
  }
  // Any module that imports the db singleton by accident opens this throwaway
  // file, never the live database.
  fs.mkdirSync(args.out, { recursive: true });
  const decoy = path.join(args.out, "decoy-singleton.db");
  process.env.DATABASE_PATH = decoy;
  if (args.env) loadApiKey(args.env);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set (pass --env <file>)");
    process.exit(2);
  }

  const { default: Database } = await import("better-sqlite3");
  const { runMigrations } = await import("@/lib/db/migrate");
  const { getRawAnthropicClient } = await import("@/lib/ai/provider");
  const { generateObjectWithModel } = await import("@/lib/ai/generate");
  const { resolveFamilyModel } = await import("@/lib/ai/model-families");
  const edgar = await import("@/lib/filing-summary/edgar");
  const store = await import("@/lib/filing-summary/store");
  const runner = await import("@/lib/filing-summary/runner");
  const { getFullView } = await import("@/lib/filing-summary/view");
  const { renderSharePage, shareFileName } = await import("@/lib/filing-summary/share-page");

  const db = new Database(args.db ? path.resolve(args.db) : ":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // ---- seed the event, the security and the bogeys
  const secId = (() => {
    const r = db.prepare("SELECT id FROM securities WHERE symbol = ?").get(args.symbol) as { id: number } | undefined;
    if (r) return r.id;
    return Number(
      db
        .prepare("INSERT INTO securities (symbol, name, security_type, source_key) VALUES (?, ?, 'Stock', ?)")
        .run(args.symbol, args.name, `replay:${args.symbol}`).lastInsertRowid,
    );
  })();
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, security_id, symbol, source_key)
         VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.date,
        args.slot,
        `${args.symbol} earnings (replay)`,
        secId,
        args.symbol,
        `replay:${args.symbol}:${args.date}:${Date.now()}`,
      ).lastInsertRowid,
  );
  let bogeyRows: DumpedBogeyRow[] = [];
  if (args.bogeys) {
    bogeyRows = parseBogeyDump(fs.readFileSync(args.bogeys, "utf8"), args.date);
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, revenue_consensus_usd, revenue_whisper_usd, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bogeyRows) {
      ins.run(eventId, b.source, b.label, b.revenueConsensusUsd, b.revenueWhisperUsd, b.uploadedAt);
    }
  }
  store.setChoice(db, eventId, { family: args.family, effort: args.effort });
  store.upsertEventState(db, eventId, { pollState: "found" });

  // ---- the filings, as the poller would store them
  const headers = fs.readdirSync(args.dir).filter((f) => /^\d{10}-\d{2}-\d{6}-index-headers\.html$/.test(f)).sort();
  if (headers.length === 0) throw new Error(`no <accession>-index-headers.html in ${args.dir}`);
  const filingsInfo: Array<{ accession: string; form: string; role: string; docs: string[] }> = [];
  const parsedFilings = headers.map((h) => {
    const html = fs.readFileSync(path.join(args.dir, h), "utf8");
    const raw = html.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const header = edgar.parseFilingHeader(html);
    const form = /<TYPE>([^\r\n<]+)/.exec(raw)?.[1].trim() ?? "unknown";
    const cik = /<CIK>0*(\d+)/.exec(raw)?.[1] ?? "";
    const role = edgar.classifyFiling(form, header.items, header.documents, "domestic");
    return { accession: h.slice(0, 20), form, cik, header, role };
  });
  // Earnings first, then companions by acceptance time (discovery order).
  parsedFilings.sort(
    (a, b) =>
      (a.role === "earnings" ? 0 : 1) - (b.role === "earnings" ? 0 : 1) ||
      (a.header.acceptanceMs ?? 0) - (b.header.acceptanceMs ?? 0),
  );
  for (const f of parsedFilings) {
    if (f.role === "ignored") continue;
    if (args.onlyEarnings && f.role !== "earnings") continue;
    const documents = f.header.documents.map((d) => {
      const skip = edgar.shouldSkipDocument(d.type, d.fileName);
      if (skip) return { d, status: "skipped" as const, reason: skip, stored: null as string | null, bytes: null as number | null };
      const p = path.join(args.dir, d.fileName);
      if (!fs.existsSync(p)) return { d, status: "failed" as const, reason: "not saved locally", stored: null, bytes: null };
      return { d, status: "fetched" as const, reason: null, stored: p, bytes: fs.statSync(p).size };
    });
    const allFetched = documents.every((x) => x.status !== "failed");
    const { id } = store.insertFiling(db, {
      eventId,
      accession: f.accession,
      cik: f.cik,
      form: f.form,
      role: f.role as "earnings" | "companion",
      items: f.header.items.join(",") || null,
      acceptedAt: f.header.acceptanceMs === null ? null : new Date(f.header.acceptanceMs).toISOString(),
      discoveredAt: new Date().toISOString(),
      identityVerdict: "accepted",
      identityReason: null,
      fetchState: allFetched ? "fetched" : "failed",
    });
    for (const x of documents) {
      store.upsertDocument(db, {
        filingId: id,
        fileName: x.d.fileName,
        docType: x.d.type,
        sequence: x.d.sequence,
        status: x.status,
        skipReason: x.reason,
        sha256: null,
        byteLen: x.bytes,
        storedPath: x.stored,
      });
    }
    filingsInfo.push({
      accession: f.accession,
      form: f.form,
      role: f.role,
      docs: documents.filter((x) => x.status === "fetched").map((x) => `${x.d.type} ${x.d.fileName}`),
    });
  }
  console.log("\n== filings");
  for (const f of filingsInfo) console.log(`  ${f.role.padEnd(9)} ${f.form.padEnd(8)} ${f.accession}  read: ${f.docs.join(", ")}`);
  console.log(`\n== bogey rows seeded: ${bogeyRows.length}`);
  for (const b of bogeyRows) {
    console.log(`  ${b.source.padEnd(10)} ${b.label} · rev cons ${b.revenueConsensusUsd ?? "-"} · rev whisper ${b.revenueWhisperUsd ?? "-"}`);
  }

  // ---- the model catalog (listed ids; no probe calls)
  const client = getRawAnthropicClient("printFilingSummary");
  const catalog: string[] = [];
  for await (const m of client.models.list()) if (typeof m.id === "string") catalog.push(m.id);
  const resolved = resolveFamilyModel(args.family, catalog);
  console.log(`\n== model: ${resolved?.modelId ?? "none"} (family ${args.family}, effort ${args.effort})`);

  const started = runner.startRun(db, eventId, "manual_run", {
    choice: { family: args.family, effort: args.effort },
    catalogIds: catalog,
  });
  if (!started.ok) throw new Error(`startRun refused: ${started.reason}`);

  // ---- run every section with the real call; record wall time and any call error
  const callLog: Array<{ ms: number; error: string | null }> = [];
  const generate: typeof generateObjectWithModel = async (feature, target, opts) => {
    const t0 = Date.now();
    try {
      const res = await generateObjectWithModel(feature, target, opts);
      callLog.push({ ms: Date.now() - t0, error: null });
      return res;
    } catch (err) {
      const e = err as { name?: string; statusCode?: number; message?: string; responseBody?: string };
      const body = typeof e.responseBody === "string" ? e.responseBody.slice(0, 2000) : "";
      const detail = `${e.name ?? "Error"}${e.statusCode ? ` (HTTP ${e.statusCode})` : ""}: ${e.message ?? String(err)}${body ? ` | body: ${body}` : ""}`;
      callLog.push({ ms: Date.now() - t0, error: detail });
      throw err;
    }
  };
  const tRun = Date.now();
  for (let i = 0; i < 10; i++) {
    const r = await runner.runNextSection(db, eventId, { generate, onSectionDone: async () => {} });
    if (r === "idle") break;
  }
  const runMs = Date.now() - tRun;

  // ---- report
  const view = getFullView(db, eventId, catalog);
  if (!view) throw new Error("no view");
  const run = view.runs.find((r) => r.runId === started.runId);
  if (!run) throw new Error("run missing from view");
  const price = PRICES[run.family] ?? PRICES[args.family];

  console.log(`\n== run ${run.runNo}: ${run.status} · ${run.modelLabel} · ${run.effort} · incomplete=${run.incomplete}`);
  console.log(`   counts: ${JSON.stringify(run.counts)}`);
  for (const s of run.sections) {
    console.log(`\n-- section ${s.seq}: ${s.form} ${s.accession} · ${s.status} · attempts ${s.attempts}${s.errorClass ? ` · ${s.errorClass}: ${s.errorText ?? ""}` : ""}`);
    console.log(`   coverage: ${s.coverage.map((c) => `${c.fileName}=${c.status}${c.reason ? `(${c.reason})` : ""}`).join(", ")}`);
    if (s.headline) console.log(`   headline: ${s.headline}`);
    if (s.counts) console.log(`   counts: ${JSON.stringify(s.counts)}`);
    for (const c of s.claims) {
      console.log(`   [${c.claimId}] ${c.status.toUpperCase()}${c.top ? " TOP" : ""}${c.routine ? " routine" : ""}: ${c.renderedText}`);
      const reasons = [
        ...c.reasons,
        ...c.figureChecks.flatMap((f) => f.reasons),
        ...c.comparisonChecks.flatMap((k) => k.reasons),
      ];
      const seen = new Set<string>();
      for (const r of reasons) {
        const key = `${r.code}|${r.figureId}|${r.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`       - ${r.code}${r.figureId ? ` (${r.figureId})` : ""}: ${r.detail}`);
      }
      for (const k of c.comparisonChecks) {
        console.log(`       ~ ${k.relation} → ${k.verdict}${k.shownText ? ` (${k.shownText})` : ""}`);
      }
      for (const fn of c.footnotes) {
        console.log(`       ^ ${fn.citationId} ${fn.document} ${fn.status} p${fn.page ?? "?"} ¶${fn.para ?? "?"}: ${(fn.sentence ?? "").slice(0, 140)}`);
      }
    }
    const u = s.usage ?? {};
    console.log(`   usage: ${JSON.stringify(u)} · cost at ${price.label} $${costOf(u, price).toFixed(4)}`);
  }
  console.log("\n== calls");
  callLog.forEach((c, i) => console.log(`  call ${i + 1}: ${(c.ms / 1000).toFixed(1)} s${c.error ? ` · ERROR ${c.error}` : ""}`));
  const tot = run.usage;
  console.log(`\n== run usage: ${JSON.stringify(tot)} · wall ${(runMs / 1000).toFixed(1)} s`);
  console.log("   cost of the same tokens at each family's list price (output includes thinking tokens; Anthropic bills thinking as output):");
  for (const p of Object.values(PRICES)) console.log(`     ${p.label.padEnd(10)} $${costOf(tot, p).toFixed(4)}`);
  if (tot.reasoningTokens !== undefined) {
    console.log("   note: reasoningTokens is reported separately but is already inside outputTokens; it is not added twice.");
  }

  const pagePath = path.join(args.out, shareFileName(view, run.runNo));
  fs.writeFileSync(pagePath, renderSharePage(view, run.runId));
  const jsonPath = path.join(args.out, `${args.symbol}-${args.date}-full-view-run${run.runNo}-${args.family}-${args.effort}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ view, callLog, runMs }, null, 2));
  console.log(`\nshare page: ${pagePath}\nfull view JSON: ${jsonPath}`);
  if (fs.existsSync(decoy)) console.log(`WARNING: something opened the db singleton (${decoy})`);
  db.close();
}

if (process.argv[1] && /filing-summary-replay\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
