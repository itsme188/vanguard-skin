import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet, disarmWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { deleteCalendarEvent } from "@/lib/mutations/calendar";
import {
  ARMED_EVENT_PROJECTION_KEYS,
  buildArmedEventsEntries,
  readArmedGeneration,
} from "@/lib/earnings/armed-events-projection";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const seed = (symbol: string, date: string) =>
  Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol, consensus_value)
         VALUES ('manual','earnings',?,'AMC','16:15',?,?,?,'EPS 0.50 · Rev 1,234,000,000')`,
      )
      .run(date, symbol, `manual:${symbol}:${date}:earnings`, symbol).lastInsertRowid,
  );

describe("armed-events projection + outbox generations", () => {
  it("projects exactly the minimal fields and only armed events", () => {
    const a = seed("ACME", "2026-09-02");
    seed("BETA", "2026-09-03");
    armWorksheet(db, a);
    expect(buildArmedEventsEntries(db, { today: "2026-09-02" })).toEqual([
      {
        eventId: a,
        symbol: "ACME",
        eventDate: "2026-09-02",
        eventTime: "AMC",
        releaseTime: "16:15",
        sourceKey: "manual:ACME:2026-09-02:earnings",
        source: "manual",
        consensusValue: "EPS 0.50 · Rev 1,234,000,000",
        expectedImpact: null,
        securityId: null,
        epsConsensusVendor: null,
      },
    ]);
  });

  it("carries the vendor EPS from the event's finnhub bogey row (D1)", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, eps_consensus_vendor)
       VALUES (?, 'finnhub', 'Finnhub', NULL, 1.23)`,
    ).run(a);
    expect(buildArmedEventsEntries(db, { today: "2026-09-02" })[0].epsConsensusVendor).toBe(1.23);
  });

  it("generation is monotonic across arm/disarm; a disarm leaves a tombstone kept >=48h after removal and >=2 ET days after the event (D7)", () => {
    const a = seed("ACME", "2026-09-02");
    expect(readArmedGeneration(db)).toBe(0);
    armWorksheet(db, a); // gen 1 (arm writes the row)
    disarmWorksheet(db, a); // gen 2
    expect(readArmedGeneration(db)).toBe(2);
    const gen2 = JSON.parse(
      (
        db.prepare(`SELECT payload_json FROM cloud_outbox WHERE generation = 2`).get() as {
          payload_json: string;
        }
      ).payload_json,
    );
    expect(gen2.entries).toEqual([
      expect.objectContaining({ eventId: a, removed: true, removedAt: expect.any(String) }),
    ]);
    const removedAt = Date.parse(gen2.entries[0].removedAt);
    // Event-date rule alone would drop it on 09-05; the 48h rule keeps it while the removal is fresh.
    expect(buildArmedEventsEntries(db, { today: "2026-09-04", nowMs: removedAt + 1 })).toEqual([
      expect.objectContaining({ eventId: a, removed: true }),
    ]);
    expect(
      buildArmedEventsEntries(db, { today: "2026-09-05", nowMs: removedAt + 47 * 3_600_000 }),
    ).toEqual([expect.objectContaining({ eventId: a, removed: true })]);
    expect(
      buildArmedEventsEntries(db, { today: "2026-09-05", nowMs: removedAt + 49 * 3_600_000 }),
    ).toEqual([]);
  });

  /**
   * [R23] The live list is limited to a 14-day lookback. An armed event that
   * ages past the horizon simply DROPS OUT — it is never tombstoned: nothing
   * in the Worker selects a 15-day-old event, and a tombstone would be
   * re-carried for two days for nothing.
   */
  it("[R23] emits live entries only for armed events inside the 14-day lookback", () => {
    const fresh = seed("ACME", "2026-08-20"); // today - 13
    const stale = seed("BETA", "2026-08-18"); // today - 15
    armWorksheet(db, fresh);
    armWorksheet(db, stale);
    const entries = buildArmedEventsEntries(db, { today: "2026-09-02" });
    expect(entries.map((e) => e.eventId)).toEqual([fresh]);
    // The boundary day itself is inside the horizon.
    const edge = seed("GAMMA", "2026-08-19"); // today - 14
    armWorksheet(db, edge);
    expect(
      buildArmedEventsEntries(db, { today: "2026-09-02" })
        .map((e) => e.symbol)
        .sort(),
    ).toEqual(["ACME", "GAMMA"]);
  });

  it("[R23] an event that ages past the horizon leaves NO tombstone behind", () => {
    const a = seed("ACME", "2026-08-20");
    armWorksheet(db, a); // gen 1, today's real ET date is irrelevant: entries carry the event
    db.transaction(() =>
      writeArmedEventsOutboxRow(db, { today: "2026-08-20" }),
    ).immediate();
    // 15 days later the event is still ARMED — it has simply aged out.
    const later = db
      .transaction(() => writeArmedEventsOutboxRow(db, { today: "2026-09-04" }))
      .immediate();
    expect(later.written).toBe(true);
    const payload = JSON.parse(
      (
        db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as {
          payload_json: string;
        }
      ).payload_json,
    ) as { entries: unknown[] };
    expect(payload.entries).toEqual([]); // no live row, and NO tombstone
    expect(buildArmedEventsEntries(db, { today: "2026-09-04" })).toEqual([]);
  });

  it("re-arming an event drops its tombstone instead of carrying both", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);
    disarmWorksheet(db, a);
    armWorksheet(db, a); // gen 3
    const entries = buildArmedEventsEntries(db, { today: "2026-09-02" });
    expect(entries).toEqual([expect.objectContaining({ eventId: a, symbol: "ACME" })]);
    expect(entries[0].removed).toBeUndefined();
  });

  it("[C-7] deleting an armed manual event writes a tombstone row", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);
    deleteCalendarEvent(db, a, { today: "2026-09-02" });
    const last = JSON.parse(
      (
        db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as {
          payload_json: string;
        }
      ).payload_json,
    );
    expect(last.entries).toEqual([expect.objectContaining({ eventId: a, removed: true })]);
  });

  it("[C-7] deleting an UNARMED manual event writes no outbox row", () => {
    const a = seed("ACME", "2026-09-02");
    deleteCalendarEvent(db, a, { today: "2026-09-02" });
    expect(readArmedGeneration(db)).toBe(0);
  });

  it("[D10] an unchanged projection writes no row; a changed one gets the next generation", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a); // gen 1
    const write = () =>
      db.transaction(() => writeArmedEventsOutboxRow(db, { today: "2026-09-02" })).immediate();
    expect(write()).toEqual({ generation: 1, written: false });
    db.prepare(`UPDATE calendar_events SET release_time = '16:30' WHERE id = ?`).run(a);
    expect(write()).toEqual({ generation: 2, written: true });
    expect(() => writeArmedEventsOutboxRow(db)).toThrow(/inside a transaction/);
  });
});

/**
 * [C-9] The generation must be allocated under SQLite's write lock, so two
 * PROCESSES holding separate connections can never mint the same one.
 *
 * better-sqlite3 is synchronous, so a real race needs a second process: the
 * parent holds the write lock while a child arms another event through the
 * REAL mutation. The child runs under Node's built-in TypeScript stripping
 * (node >= 23.6) plus a tiny resolve hook for the "@/" alias and extensionless
 * imports — this repo does not vendor `tsx`, so `--import tsx` is not
 * available here.
 */
describe("[C-9] two processes cannot mint the same generation", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("the second process waits on the busy timeout, then takes the next generation", async () => {
    const root = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-"));
    const file = path.join(dir, "t.db");

    fs.writeFileSync(
      path.join(dir, "hooks.mjs"),
      `import { existsSync } from "node:fs";
       import { pathToFileURL, fileURLToPath } from "node:url";
       const ROOT = pathToFileURL(process.env.REPO_ROOT + "/").href;
       export async function resolve(specifier, context, nextResolve) {
         const alias = specifier.startsWith("@/");
         const rel = specifier.startsWith("./") || specifier.startsWith("../");
         if (alias || rel) {
           const base = alias ? ROOT : context.parentURL;
           const target = new URL(alias ? specifier.slice(2) : specifier, base);
           for (const ext of ["", ".ts", ".tsx", ".js", "/index.ts"]) {
             const cand = new URL(target.href + ext);
             if (existsSync(fileURLToPath(cand))) return { url: cand.href, shortCircuit: true };
           }
         }
         return nextResolve(specifier, context);
       }`,
    );
    fs.writeFileSync(
      path.join(dir, "boot.mjs"),
      `import { register } from "node:module";
       import { pathToFileURL } from "node:url";
       register(pathToFileURL(process.env.HOOKS_PATH).href);`,
    );
    fs.writeFileSync(
      path.join(dir, "child.mjs"),
      `import { pathToFileURL } from "node:url";
       import { createRequire } from "node:module";
       const ROOT = process.env.REPO_ROOT;
       const Database = createRequire(ROOT + "/package.json")("better-sqlite3");
       const { armWorksheet } = await import(
         pathToFileURL(ROOT + "/lib/mutations/earnings-worksheet-flags.ts").href
       );
       const db = new Database(process.env.DB_FILE, { timeout: 5000 });
       db.pragma("foreign_keys = ON");
       process.stdout.write("READY\\n");
       process.stdout.write(String(armWorksheet(db, Number(process.env.EVENT_ID))));`,
    );

    const a1 = new Database(file, { timeout: 5000 });
    a1.pragma("journal_mode = WAL");
    a1.pragma("foreign_keys = ON");
    runMigrations(a1);
    const e1 = Number(
      a1
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-02','A','k1','AAA')`,
        )
        .run().lastInsertRowid,
    );
    const e2 = Number(
      a1
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('manual','earnings','2026-09-03','B','k2','BBB')`,
        )
        .run().lastInsertRowid,
    );
    armWorksheet(a1, e1); // gen 1
    a1.prepare("BEGIN IMMEDIATE").run(); // hold the write lock

    const child = spawn(
      process.execPath,
      ["--import", path.join(dir, "boot.mjs"), path.join(dir, "child.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          REPO_ROOT: root,
          HOOKS_PATH: path.join(dir, "hooks.mjs"),
          DB_FILE: file,
          EVENT_ID: String(e2),
        },
      },
    );
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const exited = new Promise<number>((r) => child.on("exit", (c) => r(c ?? -1)));

    // Wait until the child has opened its connection and is about to arm.
    const deadline = Date.now() + 10_000;
    while (!out.includes("READY") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(out, `child never signalled READY. stderr:\n${stderr}`).toContain("READY");
    await new Promise((r) => setTimeout(r, 300)); // child is now blocked on the write lock
    expect(out.replace("READY\n", "")).toBe(""); // still blocked — it has not armed yet

    a1.prepare("COMMIT").run();
    const code = await exited;
    expect(code, `child failed. stderr:\n${stderr}`).toBe(0);
    expect(out.replace("READY\n", "")).toBe("true");

    const gens = (
      a1.prepare(`SELECT generation FROM cloud_outbox ORDER BY generation`).all() as {
        generation: number;
      }[]
    ).map((r) => r.generation);
    expect(gens).toEqual([1, 2]); // never a UNIQUE violation, never a duplicate
    a1.close();
  }, 20_000);
});

/**
 * The snapshot slice (Task 8): what scripts/snapshot-state-to-r2.ts embeds as
 * `armedEvents` / `armedGeneration` in a v11 snapshot.
 *
 * The script calls main() at import (deviation D9), so it cannot be imported
 * here — the projection module IS the shared source it calls, and these tests
 * pin the two properties the snapshot depends on: the data-flow contract
 * (exactly the declared key set, survives JSON serialisation) and the
 * one-transaction read (watermark and list describe the same instant).
 */
describe("snapshot slice — data-flow contract", () => {
  it("carries EXACTLY the declared key set — never notes, reads, callouts, or document text", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);
    const entries = buildArmedEventsEntries(db, { today: "2026-09-02" });
    expect(entries).toHaveLength(1);

    const allowed = new Set<string>(ARMED_EVENT_PROJECTION_KEYS as readonly string[]);
    for (const e of entries) {
      for (const k of Object.keys(e)) expect(allowed.has(k)).toBe(true);
    }
    // A live row carries every field except the two tombstone-only ones.
    expect(Object.keys(entries[0]).sort()).toEqual(
      (ARMED_EVENT_PROJECTION_KEYS as readonly string[])
        .filter((k) => k !== "removed" && k !== "removedAt")
        .slice()
        .sort(),
    );
  });

  it("a tombstone adds removed + removedAt and nothing else", () => {
    const a = seed("ACME", "2026-09-02");
    db.transaction(() => {
      armWorksheet(db, a);
      writeArmedEventsOutboxRow(db, { today: "2026-09-02" });
    })();
    disarmWorksheet(db, a);

    const entries = buildArmedEventsEntries(db, { today: "2026-09-02" });
    expect(entries).toHaveLength(1);
    expect(entries[0].removed).toBe(true);
    expect(typeof entries[0].removedAt).toBe("string");
    const allowed = new Set<string>(ARMED_EVENT_PROJECTION_KEYS as readonly string[]);
    for (const k of Object.keys(entries[0])) expect(allowed.has(k)).toBe(true);
  });

  it("survives the JSON round-trip the gzipped snapshot upload performs", () => {
    const a = seed("ACME", "2026-09-02");
    armWorksheet(db, a);
    const entries = buildArmedEventsEntries(db, { today: "2026-09-02" });
    // putGzippedJson serialises with JSON.stringify — what the Worker parses
    // must be byte-for-byte what the projection produced (no undefined holes,
    // no Date objects, no NaN).
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });
});

describe("snapshot slice — buildSnapshot's single read transaction (D9)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "armed-snapshot-"));
    dbPath = path.join(dir, "vanguard.db");
    const w = new Database(dbPath);
    w.pragma("journal_mode = WAL");
    w.pragma("foreign_keys = ON");
    runMigrations(w);
    const insert = (symbol: string, date: string) =>
      Number(
        w
          .prepare(
            `INSERT INTO calendar_events (source, event_type, event_date, event_time, release_time, title, source_key, symbol)
             VALUES ('manual','earnings',?,'AMC','16:15',?,?,?)`,
          )
          .run(date, symbol, `manual:${symbol}:${date}:earnings`, symbol).lastInsertRowid,
      );
    const a = insert("ACME", "2026-09-02");
    insert("BETA", "2026-09-02");
    w.transaction(() => {
      armWorksheet(w, a);
      writeArmedEventsOutboxRow(w, { today: "2026-09-02" });
    })();
    w.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the watermark and the armed list at ONE instant on a read-only connection", () => {
    const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
    const writer = new Database(dbPath);
    writer.pragma("foreign_keys = ON");

    try {
      const observed = ro.transaction(() => {
        // First read establishes this transaction's snapshot of the file.
        const before = {
          generation: readArmedGeneration(ro),
          entries: buildArmedEventsEntries(ro, { today: "2026-09-02" }),
        };

        // A concurrent Mac arm commits a NEWER generation mid-read.
        const b = writer
          .prepare(`SELECT id FROM calendar_events WHERE symbol = 'BETA'`)
          .get() as { id: number };
        writer.transaction(() => {
          armWorksheet(writer, b.id);
          writeArmedEventsOutboxRow(writer, { today: "2026-09-02" });
        })();

        // Same transaction, second read: must NOT see it. A watermark newer
        // than the list it stamps would make the Worker discard the very
        // delta that fills the gap.
        const after = {
          generation: readArmedGeneration(ro),
          entries: buildArmedEventsEntries(ro, { today: "2026-09-02" }),
        };
        expect(after.generation).toBe(before.generation);
        expect(after.entries).toEqual(before.entries);
        return after;
      })();

      // The watermark equals the outbox maximum as seen inside that same
      // transaction — one armed event, generation 1.
      expect(observed.generation).toBe(1);
      expect(observed.entries.map((e) => e.symbol)).toEqual(["ACME"]);

      // ...and a FRESH read outside it does see the concurrent write, proving
      // the stability above came from the transaction, not from staleness.
      expect(readArmedGeneration(new Database(dbPath, { readonly: true }))).toBe(2);
    } finally {
      ro.close();
      writer.close();
    }
  });
});

/**
 * The script itself cannot be imported (it calls main() at import — D9), so
 * its two structural promises are pinned at the source level instead. Both
 * are one-line regressions away from silently breaking the Worker.
 */
describe("snapshot slice — scripts/snapshot-state-to-r2.ts structure (D9)", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "scripts/snapshot-state-to-r2.ts"),
    "utf-8",
  );

  it("builds the snapshot inside ONE db.transaction", () => {
    expect(source).toMatch(/function buildSnapshot\([^)]*\)[^{]*\{\s*return db\.transaction\(/);
  });

  it("ships v11 with the armed watermark, the armed list, and the vendor EPS column", () => {
    expect(source).toContain("schemaVersion: 11");
    expect(source).toContain("armedGeneration: readArmedGeneration(db)");
    expect(source).toContain("armedEvents: buildArmedEventsEntries(db,");
    expect(source).toContain("b.eps_consensus_vendor");
    // ET day math, never UTC — snapshotDate names the R2 key the Worker reads.
    expect(source).toContain("snapshotDate: todayET()");
    expect(source).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });
});
