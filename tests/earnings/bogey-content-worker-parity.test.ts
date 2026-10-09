/**
 * Mac and Worker must give one answer to "does this bogey row hold anything?"
 * (owner ruling 2026-08-12: an all-empty row is not coverage).
 *
 *   Mac:    bogeyHasContent / bogeyHasContentSql   lib/mutations/earnings-bogeys.ts
 *   Worker: snapshotBogeyHasContent                workers/cron/src/bogey-content.ts
 *
 * The Worker cannot import the Mac module (it pulls better-sqlite3), so the
 * parity is pinned from this side: the Worker file has no imports.
 *
 * Three links, so drift anywhere fails:
 *   1. the two column lists are the same list;
 *   2. the two rules agree on every probe value in every column;
 *   3. end to end: rows the Mac's snapshot select lets through are rows the
 *      Worker counts, except the one named gap (a column the snapshot does not
 *      carry), which reads as empty in the cloud and is pinned as such.
 *
 * Invented issuers and round figures only: the repo is public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { bogeyHasContent, CONTENT_COLUMNS } from "@/lib/mutations/earnings-bogeys";
import { getBogeysWithContentForEvent } from "@/lib/queries/earnings-bogeys";
import { getEarningsBogeysForSnapshot } from "@/scripts/snapshot-state-to-r2";
import {
  snapshotBogeyHasContent,
  snapshotBogeysPrinted,
  SNAPSHOT_BOGEY_CONTENT_COLUMNS,
} from "@/workers/cron/src/bogey-content";
import { bogeysPrintedInPrompt } from "@/lib/earnings/bogey-prompt-entries";
import { bogeyClaim, VENDOR_BOGEY_SOURCE } from "@/lib/earnings/bogey-claim";
import {
  snapshotBogeyClaim,
  VENDOR_BOGEY_SOURCE as WORKER_VENDOR_BOGEY_SOURCE,
} from "@/workers/cron/src/bogey-claim";

/** Content columns the snapshot row does not carry. Adding one here is a
 *  decision: such a row counts on the Mac and reads as empty in the cloud. */
const NOT_IN_SNAPSHOT = ["extra_metrics_json"];

const PROBES: unknown[] = [
  null,
  undefined,
  0,
  1.5,
  -2,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "   ",
  "[]",
  " {} ",
  "{}",
  "watch the guide",
  '{"Cloud":{"consensus":100}}',
  '[{"label":"Bookings","value":"100"}]',
];

describe("bogey content rule: Mac and Worker agree", () => {
  it("the column lists are the same list", () => {
    expect([...SNAPSHOT_BOGEY_CONTENT_COLUMNS]).toEqual([...CONTENT_COLUMNS]);
  });

  it("an empty object is empty on both sides", () => {
    expect(bogeyHasContent({})).toBe(false);
    expect(snapshotBogeyHasContent({})).toBe(false);
  });

  it.each(CONTENT_COLUMNS.map((c) => [c]))("every probe value in %s gets the same answer", (col) => {
    for (const value of PROBES) {
      const row = { [col]: value };
      expect(snapshotBogeyHasContent(row), `${col} = ${JSON.stringify(value)}`).toBe(bogeyHasContent(row));
    }
  });
});

describe("end to end: Mac send reader, snapshot select and Worker count the same rows", () => {
  let db: Database.Database;
  let eventId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of)
           VALUES ('manual', 'earnings', '2026-04-28', 'ZZA earnings', 'ZZA', 'manual:ZZA:2026-04-28:earnings', '2026-04-27')`,
        )
        .run().lastInsertRowid,
    );
  });

  function seedRow(label: string, cols: Record<string, unknown> = {}): number {
    const names = Object.keys(cols);
    return Number(
      db
        .prepare(
          `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at${names.map((n) => `, ${n}`).join("")})
           VALUES (?, 'newsletter', ?, datetime('now')${names.map(() => ", ?").join("")})`,
        )
        .run(eventId, label, ...Object.values(cols)).lastInsertRowid,
    );
  }

  const SAMPLE: Record<string, unknown> = {
    eps_consensus: 0,
    eps_whisper: 1.5,
    revenue_consensus_usd: 100_000_000,
    revenue_whisper_usd: 110_000_000,
    expected_move_pct: 5,
    eps_consensus_vendor: 1,
    segment_breakdown_json: '{"Cloud":{"consensus":100}}',
    guidance_notes: "watch the guide",
    notes: "a note",
    extra_metrics_json: '[{"label":"Bookings","value":"100"}]',
  };

  const macIds = () => getBogeysWithContentForEvent(db, eventId).map((b) => b.id).sort((a, b) => a - b);
  const workerIds = () =>
    getEarningsBogeysForSnapshot(db, "2026-04-01", "2026-05-31")
      // What resolveBogeysForEvent does with the snapshot rows.
      .filter((b) => b.event_id === eventId && snapshotBogeyHasContent(b))
      .map((b) => b.id)
      .sort((a, b) => a - b);

  it("only-empty rows: no bogeys on either side", () => {
    seedRow("empty");
    seedRow("blank", { notes: " ", guidance_notes: "", segment_breakdown_json: "{}", extra_metrics_json: "[]" });
    expect(macIds()).toEqual([]);
    expect(workerIds()).toEqual([]);
  });

  it("one row per snapshot-carried content column: both sides count every one", () => {
    seedRow("empty");
    const ids = CONTENT_COLUMNS.filter((c) => !NOT_IN_SNAPSHOT.includes(c)).map((c) =>
      seedRow(`only ${c}`, { [c]: SAMPLE[c] }),
    );
    expect(macIds()).toEqual(ids);
    expect(workerIds()).toEqual(ids);
  });

  it("the named gap: a row whose only content is a column the snapshot does not carry counts on the Mac only", () => {
    const ids = NOT_IN_SNAPSHOT.map((c) => seedRow(`only ${c}`, { [c]: SAMPLE[c] }));
    expect(macIds()).toEqual(ids);
    expect(workerIds()).toEqual([]);
  });

  /**
   * Review follow-up (2026-10-08): the composers count a row only if they PRINT
   * something from it (holding something is not enough).
   *
   *   Mac:    bogeysPrintedInPrompt    lib/earnings/bogey-prompt-entries.ts
   *   Worker: snapshotBogeysPrinted    workers/cron/src/bogey-content.ts
   *
   * The two agree on every column the snapshot carries. The ONE documented
   * difference: the snapshot has no extra_metrics_json, so an extras-only row
   * is an entry in the Mac's prompt and not in the cloud email.
   */
  const macPrinted = () =>
    bogeysPrintedInPrompt(getBogeysWithContentForEvent(db, eventId)).map((e) => e.bogey.id).sort((a, b) => a - b);
  const workerPrinted = () =>
    snapshotBogeysPrinted(
      getEarningsBogeysForSnapshot(db, "2026-04-01", "2026-05-31").filter(
        (b) => b.event_id === eventId && snapshotBogeyHasContent(b),
      ),
    )
      .map((e) => e.bogey.id)
      .sort((a, b) => a - b);

  const EXTRAS = JSON.stringify([
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Bookings",
      definition: "Total bookings in the quarter",
      unit: "usd",
      kind: "point",
      period: "Q",
      basis: "na",
      consensus: 250_000_000,
    },
  ]);

  it.each([
    ["vendor-EPS-only", { eps_consensus_vendor: 1.05 }, true, true],
    ["move-only", { expected_move_pct: 5 }, true, true],
    ["segments-only", { segment_breakdown_json: '{"Cloud":{"consensus":40000000}}' }, true, true],
    ["extras-only (the documented difference)", { extra_metrics_json: EXTRAS }, true, false],
    ["empty", {}, false, false],
  ] as Array<[string, Record<string, unknown>, boolean, boolean]>)(
    "single-column shape %s: printed on the Mac and in the cloud as documented",
    (_name, cols, onMac, inCloud) => {
      const id = seedRow("only this", cols);
      expect(macPrinted()).toEqual(onMac ? [id] : []);
      expect(workerPrinted()).toEqual(inCloud ? [id] : []);
    },
  );

  it("one row per snapshot-carried column: both composers print every one", () => {
    const ids = CONTENT_COLUMNS.filter((c) => !NOT_IN_SNAPSHOT.includes(c)).map((c) =>
      seedRow(`only ${c}`, { [c]: SAMPLE[c] }),
    );
    expect(macPrinted()).toEqual(ids);
    expect(workerPrinted()).toEqual(ids);
  });

  it.each([
    ["a segment with no figure", { segment_breakdown_json: '{"Cloud":{}}' }],
    ["segments that are not JSON", { segment_breakdown_json: "{not json" }],
    ["segments that are a list", { segment_breakdown_json: "[1]" }],
  ] as Array<[string, Record<string, unknown>]>)(
    "%s passes the content rule and is printed by neither composer",
    (_name, cols) => {
      const id = seedRow("holds, prints nothing", cols);
      expect(macIds()).toEqual([id]);
      expect(macPrinted()).toEqual([]);
      expect(workerPrinted()).toEqual([]);
    },
  );

  it("extras that hold no figure, or do not validate, are printed by neither", () => {
    seedRow("no figure", { extra_metrics_json: JSON.stringify([{ ...JSON.parse(EXTRAS)[0], consensus: null }]) });
    seedRow("invalid", { extra_metrics_json: '[{"label":"Bookings","value":"100"}]' });
    expect(macPrinted()).toEqual([]);
    expect(workerPrinted()).toEqual([]);
  });

  /**
   * Wording follow-up (2026-10-08): what each side may SAY about its printed
   * entries. "curated" only when a printed entry is not the vendor's; every
   * printed entry the vendor's reads "vendor_only"; nothing printed is "none".
   *
   *   Mac:    bogeyClaim            lib/earnings/bogey-claim.ts
   *   Worker: snapshotBogeyClaim    workers/cron/src/bogey-claim.ts
   *
   * Each side reads the claim off its own printed list, so the two agree
   * wherever the printed lists agree. The one documented difference carries
   * over: a curated row whose only printed content is extra_metrics_json is
   * not in the cloud email, so beside a vendor row the cloud says vendor-only.
   */
  function seedSourced(source: string, label: string, cols: Record<string, unknown>): number {
    const names = Object.keys(cols);
    return Number(
      db
        .prepare(
          `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at${names.map((n) => `, ${n}`).join("")})
           VALUES (?, ?, ?, datetime('now')${names.map(() => ", ?").join("")})`,
        )
        .run(eventId, source, label, ...Object.values(cols)).lastInsertRowid,
    );
  }
  const macClaim = () =>
    bogeyClaim(bogeysPrintedInPrompt(getBogeysWithContentForEvent(db, eventId)).map((e) => e.bogey));
  const workerClaim = () =>
    snapshotBogeyClaim(
      snapshotBogeysPrinted(
        getEarningsBogeysForSnapshot(db, "2026-04-01", "2026-05-31").filter(
          (b) => b.event_id === eventId && snapshotBogeyHasContent(b),
        ),
      ).map((e) => e.bogey),
    );

  it("the vendor source is the same token on both sides", () => {
    expect(WORKER_VENDOR_BOGEY_SOURCE).toBe(VENDOR_BOGEY_SOURCE);
    expect(VENDOR_BOGEY_SOURCE).toBe("finnhub");
  });

  const VENDOR = { eps_consensus_vendor: 1.05, revenue_consensus_usd: 100_000_000, notes: "Vendor consensus" };
  type Seed = [source: string, cols: Record<string, unknown>];
  it.each([
    ["no rows", [], "none", "none"],
    ["only an empty row", [["manual", {}]], "none", "none"],
    ["only the vendor row", [["finnhub", VENDOR]], "vendor_only", "vendor_only"],
    ["the vendor row and an empty curated row", [["finnhub", VENDOR], ["newsletter", {}]], "vendor_only", "vendor_only"],
    [
      "the vendor row and a curated row that holds something nobody prints",
      [["finnhub", VENDOR], ["manual", { segment_breakdown_json: '{"Cloud":{}}' }]],
      "vendor_only",
      "vendor_only",
    ],
    ["the vendor row and a curated row", [["finnhub", VENDOR], ["pdf_upload", { eps_consensus: 1.02 }]], "curated", "curated"],
    ["only a curated row", [["manual", { eps_whisper: 1.08 }]], "curated", "curated"],
    ["a notes-only curated row beside the vendor row", [["finnhub", VENDOR], ["manual", { notes: "watch margins" }]], "curated", "curated"],
    [
      "a hand-entered row filling only the vendor column (the source decides)",
      [["manual", { eps_consensus_vendor: 1.05 }]],
      "curated",
      "curated",
    ],
    [
      "the vendor row and an extras-only curated row (the documented difference)",
      [["finnhub", VENDOR], ["manual", { extra_metrics_json: EXTRAS }]],
      "curated",
      "vendor_only",
    ],
  ] as Array<[string, Seed[], string, string]>)("claim for %s", (_name, seeds, onMac, inCloud) => {
    seeds.forEach(([source, cols], i) => seedSourced(source, `row ${i}`, cols));
    expect(macClaim()).toBe(onMac);
    expect(workerClaim()).toBe(inCloud);
  });
});
