/**
 * scripts/repair-requeue-failed-enrichment.ts — recovers articles the old
 * retry cap excluded during an account-level AI outage.
 *
 * Finding: research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns.
 *
 * The stored reasons are produced the way production produces them: the real
 * enrichment pass (lib/gmail/process.ts as it was BEFORE the fix would have
 * written the same text) records the first 200 characters of the real SDK
 * error's message. Here each reason is built from a real SDK error
 * (tests/helpers/ai-sdk-real-errors.ts) with the template process.ts uses.
 * In-memory database; the script is imported, never spawned.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  NAMED_ID_KIND,
  PRIVATE_OUTPUT_NOTICE,
  findNamedRequeueCandidates,
  findRequeueCandidates,
  formatRequeueReport,
  parseRequeueArgs,
  repairRequeueFailedEnrichment,
} from "@/scripts/repair-requeue-failed-enrichment";
import { ANTHROPIC_FAILURES, errorFromRealSdk, type AnthropicFailureName } from "../helpers/ai-sdk-real-errors";

const reasons = {} as Record<AnthropicFailureName, string>;

beforeAll(async () => {
  for (const name of Object.keys(ANTHROPIC_FAILURES) as AnthropicFailureName[]) {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES[name]);
    reasons[name] = `Enrichment failed 3 times — last failure: ${(error as Error).message.slice(0, 200)}`;
  }
});

/** Id of the source makeDb() registered (the migrations seed sources of their own). */
let sourceId = 0;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sourceId = db.prepare(`INSERT INTO research_sources (name) VALUES ('ZZ Test Letter')`).run()
    .lastInsertRowid as number;
  return db;
}

let seq = 0;
function insert(
  db: Database.Database,
  f: {
    category?: string | null;
    reason?: string | null;
    isRelevant?: 0 | 1;
    processedAt?: string | null;
    attempts?: number;
    receivedAt?: string;
    summary?: string | null;
  },
): number {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO research_articles
         (source_id, gmail_message_id, subject, sender, raw_text, received_at,
          is_relevant, excluded_category, excluded_reason, processed_at, enrich_attempts, summary)
       VALUES (?, ?, ?, 'letters@example.test', 'ZZ body text', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceId,
      `repair-${seq}`,
      `ZZ PRIVATE SUBJECT ${seq}`,
      f.receivedAt ?? "2026-01-05 12:00:00",
      f.isRelevant ?? 0,
      f.category === undefined ? "enrichment_failed" : f.category,
      f.reason ?? null,
      f.processedAt === undefined ? "2026-01-05 13:00:00" : f.processedAt,
      f.attempts ?? 3,
      f.summary ?? null,
    ).lastInsertRowid as number;
}

function titleOf(db: Database.Database, id: number): string {
  return (db.prepare(`SELECT subject FROM research_articles WHERE id = ?`).get(id) as { subject: string }).subject;
}

function snapshot(db: Database.Database): unknown[] {
  return db.prepare(`SELECT * FROM research_articles ORDER BY id`).all();
}

function seed(db: Database.Database) {
  return {
    billing: insert(db, { reason: reasons.billing400 }),
    rateLimit: insert(db, { reason: reasons.rateLimit429 }),
    overloaded: insert(db, { reason: reasons.overloaded529 }),
    gateway: insert(db, { reason: reasons.gatewayHtml502 }),
    auth: insert(db, { reason: reasons.auth401 }),
    // Not account-level: must be left alone.
    refusal: insert(db, { reason: reasons.refusal }),
    malformed: insert(db, { reason: reasons.malformedOutput }),
    tooLong: insert(db, { reason: reasons.promptTooLong400 }),
    emptyParse: insert(db, {
      reason: "Enrichment failed 3 times — last failure: empty enrichment (no summary, no themes)",
    }),
    noReason: insert(db, { reason: null }),
    // Not 'enrichment_failed' at all, even though the text mentions credit.
    offTopic: insert(db, {
      category: "off_topic",
      reason: "Your credit balance is too low is the headline of this off-topic piece",
      summary: "A real summary.",
    }),
    // Billing reason but no longer excluded: nothing to recover.
    alreadyRelevant: insert(db, { isRelevant: 1, category: null, reason: reasons.billing400 }),
  };
}

describe("selection", () => {
  it("selects only excluded rows whose recorded failure is account-level", () => {
    const db = makeDb();
    const ids = seed(db);

    const { scanned, matched } = findRequeueCandidates(db);

    expect(scanned).toBe(10);
    expect(matched.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: ids.billing, kind: "billing" },
      { id: ids.rateLimit, kind: "retried_transient" },
      { id: ids.overloaded, kind: "retried_transient" },
      { id: ids.gateway, kind: "retried_transient" },
      { id: ids.auth, kind: "auth" },
    ]);
    for (const m of matched) expect(m.title).toBe(titleOf(db, m.id));
  });

  it("--since / --until narrow by received date, inclusive", () => {
    const db = makeDb();
    const early = insert(db, { reason: reasons.billing400, receivedAt: "2026-01-04 23:59:59" });
    const first = insert(db, { reason: reasons.billing400, receivedAt: "2026-01-05 00:00:00" });
    const last = insert(db, { reason: reasons.billing400, receivedAt: "2026-01-07 23:59:59" });
    const late = insert(db, { reason: reasons.billing400, receivedAt: "2026-01-08 00:00:00" });

    const ids = (w: { since?: string; until?: string }) => findRequeueCandidates(db, w).matched.map((m) => m.id);
    expect(ids({ since: "2026-01-05", until: "2026-01-07" })).toEqual([first, last]);
    expect(ids({ since: "2026-01-05" })).toEqual([first, last, late]);
    expect(ids({ until: "2026-01-04" })).toEqual([early]);
    expect(ids({})).toEqual([early, first, last, late]);
  });

  it("rejects a malformed or inverted window instead of guessing", () => {
    const db = makeDb();
    expect(() => findRequeueCandidates(db, { since: "01/05/2026" })).toThrow(/--since must be a date/);
    expect(() => findRequeueCandidates(db, { since: "2026-01-07", until: "2026-01-05" })).toThrow(/is after/);
  });
});

describe("dry run", () => {
  it("changes nothing", () => {
    const db = makeDb();
    seed(db);
    const before = snapshot(db);

    const result = repairRequeueFailedEnrichment(db, { apply: false });

    expect(result).toMatchObject({ scanned: 10, skipped: 5, requeued: 0 });
    expect(result.matched).toHaveLength(5);
    expect(snapshot(db)).toEqual(before);
  });
});

describe("apply", () => {
  it("re-queues the matched rows and leaves every other row byte-for-byte alone", () => {
    const db = makeDb();
    const ids = seed(db);
    const before = snapshot(db) as Array<{ id: number }>;
    const matchedIds = new Set([ids.billing, ids.rateLimit, ids.overloaded, ids.gateway, ids.auth]);

    const result = repairRequeueFailedEnrichment(db, { apply: true });

    expect(result).toMatchObject({ scanned: 10, skipped: 5, requeued: 5 });
    const after = snapshot(db) as Array<Record<string, unknown> & { id: number }>;
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      const original = before.find((b) => b.id === row.id);
      if (matchedIds.has(row.id)) {
        expect(row).toEqual({
          ...original,
          is_relevant: 1,
          excluded_category: null,
          excluded_reason: null,
          processed_at: null,
          enrich_attempts: 0,
        });
      } else {
        expect(row).toEqual(original);
      }
    }
  });

  it("is idempotent: a second apply selects nothing and writes nothing", () => {
    const db = makeDb();
    seed(db);
    repairRequeueFailedEnrichment(db, { apply: true });
    const afterFirst = snapshot(db);

    const second = repairRequeueFailedEnrichment(db, { apply: true });

    expect(second).toMatchObject({ scanned: 5, skipped: 5, requeued: 0 });
    expect(second.matched).toEqual([]);
    expect(snapshot(db)).toEqual(afterFirst);
  });

  it("the re-queued rows are what the enrichment queue selects", () => {
    const db = makeDb();
    const ids = seed(db);
    repairRequeueFailedEnrichment(db, { apply: true });

    const queued = (
      db
        .prepare(
          `SELECT id FROM research_articles
            WHERE processed_at IS NULL AND COALESCE(is_relevant, 1) = 1 AND COALESCE(enrich_attempts, 0) < 3
            ORDER BY id`,
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
    expect(queued).toEqual([ids.billing, ids.rateLimit, ids.overloaded, ids.gateway, ids.auth]);
  });
});

describe("report and flags", () => {
  it("prints counts, then id, class and title per selected row, under a do-not-commit notice", () => {
    const db = makeDb();
    const ids = seed(db);
    const lines = formatRequeueReport(repairRequeueFailedEnrichment(db, { apply: false }), false);
    const dry = lines.join("\n");

    expect(dry).toContain("Excluded as enrichment_failed in scope: 10");
    expect(dry).toContain("Recorded failure is account-level:      5");
    expect(dry).toContain(`billing: 1 row(s), ids ${ids.billing}`);
    expect(dry).toContain(`retried_transient: 3 row(s), ids ${ids.rateLimit}, ${ids.overloaded}, ${ids.gateway}`);
    expect(dry).toMatch(/Dry run: 5 row\(s\) would be re-queued/);

    // The notice comes before the first title.
    const noticeAt = lines.indexOf(PRIVATE_OUTPUT_NOTICE);
    expect(noticeAt).toBeGreaterThan(-1);
    expect(PRIVATE_OUTPUT_NOTICE).toMatch(/Do not paste this into a committed file/);
    const titleLines = lines.filter((l) => l.startsWith("  id "));
    expect(titleLines).toEqual([
      `  id ${ids.billing}  [billing]  ${titleOf(db, ids.billing)}`,
      `  id ${ids.rateLimit}  [retried_transient]  ${titleOf(db, ids.rateLimit)}`,
      `  id ${ids.overloaded}  [retried_transient]  ${titleOf(db, ids.overloaded)}`,
      `  id ${ids.gateway}  [retried_transient]  ${titleOf(db, ids.gateway)}`,
      `  id ${ids.auth}  [auth]  ${titleOf(db, ids.auth)}`,
    ]);
    expect(lines.indexOf(titleLines[0])).toBeGreaterThan(noticeAt);

    // Rows left alone are not named, and no sender, reason or body is printed.
    for (const skipped of [ids.refusal, ids.malformed, ids.tooLong, ids.emptyParse, ids.noReason, ids.offTopic]) {
      expect(dry).not.toContain(titleOf(db, skipped));
    }
    expect(dry).not.toMatch(/example\.test|credit balance|Failed after|ZZ body/);

    const applied = formatRequeueReport(repairRequeueFailedEnrichment(db, { apply: true }), true).join("\n");
    expect(applied).toMatch(/Re-queued 5 row\(s\)/);

    const again = formatRequeueReport(repairRequeueFailedEnrichment(db, { apply: true }), true);
    expect(again.join("\n")).toMatch(/Nothing to re-queue/);
    expect(again).not.toContain(PRIVATE_OUTPUT_NOTICE);
  });

  it("a title is printed on one line: newlines and control characters flattened, long ones cut", () => {
    const db = makeDb();
    const id = insert(db, { reason: reasons.billing400 });
    db.prepare(`UPDATE research_articles SET subject = ? WHERE id = ?`).run(`ZZ first line\nZZ second\u001b[31m line ${"x".repeat(200)}`, id);

    const titleLine = formatRequeueReport(repairRequeueFailedEnrichment(db, { apply: false }), false).find((l) =>
      l.startsWith(`  id ${id}  `),
    );

    expect(titleLine).toBeDefined();
    expect(titleLine).not.toMatch(/[\u0000-\u001f]/);
    expect(titleLine).toContain("ZZ first line ZZ second [31m line");
    expect(titleLine!.length).toBeLessThanOrEqual(`  id ${id}  [billing]  `.length + 100);
  });

  it("is a dry run unless --apply is given, and refuses flags it does not know", () => {
    expect(parseRequeueArgs([])).toEqual({ apply: false });
    expect(parseRequeueArgs(["--apply"])).toEqual({ apply: true });
    expect(parseRequeueArgs(["--since", "2026-01-05", "--until", "2026-01-07"])).toEqual({
      apply: false,
      since: "2026-01-05",
      until: "2026-01-07",
    });
    expect(() => parseRequeueArgs(["--aply"])).toThrow(/Unknown argument/);
    expect(() => parseRequeueArgs(["--since"])).toThrow(/needs a date/);
    expect(() => parseRequeueArgs(["--since", "--apply"])).toThrow(/needs a date/);
    expect(() => parseRequeueArgs(["--since", "yesterday"])).toThrow(/must be a date/);
  });
});

describe("--ids: named rows only", () => {
  it("selects exactly the named rows, even when the stored reason is not account-level", () => {
    const db = makeDb();
    const ids = seed(db);

    const found = findNamedRequeueCandidates(db, [ids.refusal, ids.noReason, ids.billing]);

    expect(found.matched.map((m) => [m.id, m.kind])).toEqual([
      [ids.refusal, NAMED_ID_KIND],
      [ids.noReason, NAMED_ID_KIND],
      [ids.billing, "billing"],
    ]);
    expect(found.notEligible).toEqual([]);
  });

  it("does not add the automatic selection: account-level rows that were not named are left alone", () => {
    const db = makeDb();
    const ids = seed(db);
    const before = snapshot(db);

    const result = repairRequeueFailedEnrichment(db, { apply: true, ids: [ids.malformed] });

    expect(result.matched.map((m) => m.id)).toEqual([ids.malformed]);
    expect(result.requeued).toBe(1);
    const after = snapshot(db) as { id: number }[];
    for (const row of before as { id: number }[]) {
      if (row.id === ids.malformed) continue;
      expect(after.find((r) => r.id === row.id)).toEqual(row);
    }
    expect(
      db
        .prepare(
          `SELECT is_relevant, excluded_category, excluded_reason, processed_at, enrich_attempts
             FROM research_articles WHERE id = ?`,
        )
        .get(ids.malformed),
    ).toEqual({ is_relevant: 1, excluded_category: null, excluded_reason: null, processed_at: null, enrich_attempts: 0 });
  });

  it("a named row that is not currently enrichment_failed with is_relevant = 0 is never written", () => {
    const db = makeDb();
    const ids = seed(db);
    const missing = 999_999;
    const before = snapshot(db);

    const result = repairRequeueFailedEnrichment(db, {
      apply: true,
      ids: [ids.offTopic, ids.alreadyRelevant, missing],
    });

    expect(result.matched).toEqual([]);
    expect(result.requeued).toBe(0);
    expect(result.named).toEqual({
      requested: [ids.offTopic, ids.alreadyRelevant, missing],
      notEligible: [ids.offTopic, ids.alreadyRelevant, missing],
    });
    expect(snapshot(db)).toEqual(before);
  });

  it("is a dry run unless apply is set, and a second apply writes nothing", () => {
    const db = makeDb();
    const ids = seed(db);
    const before = snapshot(db);

    const dry = repairRequeueFailedEnrichment(db, { apply: false, ids: [ids.refusal, ids.tooLong] });
    expect(dry.matched).toHaveLength(2);
    expect(dry.requeued).toBe(0);
    expect(snapshot(db)).toEqual(before);

    expect(repairRequeueFailedEnrichment(db, { apply: true, ids: [ids.refusal, ids.tooLong] }).requeued).toBe(2);
    const again = repairRequeueFailedEnrichment(db, { apply: true, ids: [ids.refusal, ids.tooLong] });
    expect(again.requeued).toBe(0);
    expect(again.named?.notEligible).toEqual([ids.refusal, ids.tooLong]);
  });

  it("a repeated id is taken once; an id that is not a positive whole number is refused", () => {
    const db = makeDb();
    const ids = seed(db);

    const result = repairRequeueFailedEnrichment(db, { apply: true, ids: [ids.refusal, ids.refusal] });
    expect(result.named?.requested).toEqual([ids.refusal]);
    expect(result.requeued).toBe(1);

    for (const bad of [[], [0], [-3], [1.5], [Number.NaN]]) {
      expect(() => repairRequeueFailedEnrichment(db, { apply: false, ids: bad })).toThrow(/--ids/);
    }
  });

  it("refuses to combine with --since / --until, in the flags and in the function", () => {
    const db = makeDb();
    const ids = seed(db);
    const before = snapshot(db);

    expect(() => parseRequeueArgs(["--ids", "1,2", "--since", "2026-01-05"])).toThrow(/cannot be combined/);
    expect(() => parseRequeueArgs(["--until", "2026-01-05", "--ids", "1,2"])).toThrow(/cannot be combined/);
    expect(() =>
      repairRequeueFailedEnrichment(db, { apply: true, ids: [ids.refusal], since: "2026-01-01" }),
    ).toThrow(/cannot be combined/);
    expect(snapshot(db)).toEqual(before);
  });

  it("parses --ids as one comma list and refuses anything else", () => {
    expect(parseRequeueArgs(["--ids", "3,1,2"])).toEqual({ apply: false, ids: [3, 1, 2] });
    expect(parseRequeueArgs(["--ids", "7, 7 ,8", "--apply"])).toEqual({ apply: true, ids: [7, 8] });
    expect(() => parseRequeueArgs(["--ids"])).toThrow(/needs a list/);
    expect(() => parseRequeueArgs(["--ids", "--apply"])).toThrow(/needs a list/);
    for (const bad of ["", "1,,2", "1,x", "0", "-4", "1.5", "1e3", "all"]) {
      expect(() => parseRequeueArgs(["--ids", bad])).toThrow(/positive whole numbers/);
    }
    expect(() => parseRequeueArgs(["--ids", "1", "--ids", "2"])).toThrow(/given twice/);
  });

  it("the report says only the named rows were selected, and keeps the private-output notice", () => {
    const db = makeDb();
    const ids = seed(db);
    const missing = 999_999;
    const opts = { apply: false, ids: [ids.refusal, ids.billing, ids.offTopic, missing] };
    const lines = formatRequeueReport(repairRequeueFailedEnrichment(db, opts), false);
    const text = lines.join("\n");

    expect(lines[0]).toMatch(/--ids given: selecting ONLY the 4 named row\(s\)/);
    expect(lines[0]).toMatch(/automatic account-level selection was not run/);
    expect(text).toContain(`not eligible: ids ${ids.offTopic}, ${missing}`);
    expect(text).toMatch(/will fail again/);
    expect(text).not.toContain("Recorded failure is account-level:");

    const noticeAt = lines.indexOf(PRIVATE_OUTPUT_NOTICE);
    expect(noticeAt).toBeGreaterThan(-1);
    const titleLines = lines.filter((l) => l.startsWith("  id "));
    expect(titleLines).toEqual([
      `  id ${ids.refusal}  [${NAMED_ID_KIND}]  ${titleOf(db, ids.refusal)}`,
      `  id ${ids.billing}  [billing]  ${titleOf(db, ids.billing)}`,
    ]);
    expect(lines.indexOf(titleLines[0])).toBeGreaterThan(noticeAt);
    expect(text).toMatch(/Dry run: 2 row\(s\) would be re-queued/);

    // Rows that were not named, or not eligible, are never titled; no reason, sender or body.
    for (const other of [ids.rateLimit, ids.auth, ids.offTopic]) expect(text).not.toContain(titleOf(db, other));
    expect(text).not.toMatch(/example\.test|credit balance|Failed after|ZZ body/);

    const none = formatRequeueReport(repairRequeueFailedEnrichment(db, { apply: false, ids: [missing] }), false);
    expect(none.join("\n")).toMatch(/Nothing to re-queue/);
    expect(none).not.toContain(PRIVATE_OUTPUT_NOTICE);
  });

  it("without --ids the selection and the report are unchanged", () => {
    const db = makeDb();
    const ids = seed(db);
    const result = repairRequeueFailedEnrichment(db, { apply: false });
    expect(result.named).toBeUndefined();
    expect(result.matched.map((m) => m.id)).toEqual([ids.billing, ids.rateLimit, ids.overloaded, ids.gateway, ids.auth]);
    expect(formatRequeueReport(result, false)[0]).toBe("Excluded as enrichment_failed in scope: 10");
  });
});
