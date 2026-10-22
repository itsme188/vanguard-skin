/** Filing-summary pushes: at most once, counts-only text. Synthetic data. */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { composeSummaryPush, sendSummaryPushIfDue, easternTimeText } from "@/lib/filing-summary/push";
import { createRun, insertFiling, listSections, markSendingAsUnknown, claimPushForSending, beginPush } from "@/lib/filing-summary/store";
import { DELIVERY_UNKNOWN, SENDING } from "@/lib/earnings/email-states";

let db: Database.Database;
let eventId: number;
const counts = { claims: 12, checked: 9, contradicted: 1, warning: 0, unconfirmed: 2, qualitative: 0 };

function setup(trigger: "auto" | "rerun", accession = "0000000001-26-000001", role: "earnings" | "companion" = "earnings") {
  const f = insertFiling(db, {
    eventId, accession, cik: "0000000001", form: role === "earnings" ? "8-K" : "PRE 14C", role, items: null,
    acceptedAt: "2026-10-22T16:12:00-04:00", discoveredAt: "2026-10-22T20:20:00.000Z",
    identityVerdict: "accepted", identityReason: null,
  });
  const filingId = typeof f === "number" ? f : (f as { id: number }).id;
  const runId = createRun(db, {
    eventId, trigger, choice: { family: "opus", effort: "high" }, modelId: "m", fallbackNote: null,
    requestKey: null, bogeySnapshotJson: "[]", filingIds: [filingId],
  });
  void runId;
  const sec = listSections(db, (db.prepare("SELECT MAX(id) id FROM filing_summary_runs").get() as { id: number }).id)[0];
  db.prepare("UPDATE filing_summary_sections SET status='done', checked_json=?, incomplete=0 WHERE id=?")
    .run(JSON.stringify({ headline: "x", claims: [], counts }), sec.id);
  return sec.id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db.prepare(`INSERT INTO calendar_events (source,event_type,event_date,title,source_key,symbol)
      VALUES ('finnhub','earnings','2026-10-22','META earnings','k','META')`).run().lastInsertRowid,
  );
});

describe("composeSummaryPush", () => {
  it("earnings text", () => {
    expect(composeSummaryPush({ symbol: "META", form: "8-K", role: "earnings", counts, incomplete: false, acceptedAtEt: "4:12 pm" }))
      .toEqual({ title: "META filing summary", message: "12 claims · 9 checked · 1 contradicted · 2 unconfirmed" });
  });
  it("incomplete suffix and companion text", () => {
    const c = { claims: 3, checked: 3, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 };
    expect(composeSummaryPush({ symbol: "META", form: "PRE 14C", role: "companion", counts: c, incomplete: true, acceptedAtEt: "4:12 pm" }))
      .toEqual({ title: "META · PRE 14C · 4:12 pm", message: "adds 3 claims · 3 checked · incomplete" });
  });
  it("formats Eastern time", () => {
    expect(easternTimeText("2026-10-22T20:12:00.000Z")).toBe("4:12 pm");
    expect(easternTimeText(null)).toBe("");
  });
});

describe("sendSummaryPushIfDue", () => {
  it("sends once, then never again for the same section", async () => {
    const id = setup("auto");
    const sent: { title: string; url: string }[] = [];
    const send = async (m: { title: string; message: string; url: string }) => { sent.push(m); return { sent: true }; };
    await sendSummaryPushIfDue(db, id, send);
    await sendSummaryPushIfDue(db, id, send);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(new RegExp(`/dashboard/print/${eventId}/filings$`));
    expect((db.prepare("SELECT state FROM filing_summary_pushes").get() as { state: string }).state).toBe("sent");
  });
  it("sends nothing for a rerun", async () => {
    const id = setup("rerun");
    let n = 0;
    await sendSummaryPushIfDue(db, id, async () => { n++; return { sent: true }; });
    expect(n).toBe(0);
  });
  it("sends nothing for a failed section", async () => {
    const id = setup("auto");
    db.prepare("UPDATE filing_summary_sections SET status='failed' WHERE id=?").run(id);
    let n = 0;
    await sendSummaryPushIfDue(db, id, async () => { n++; return { sent: true }; });
    expect(n).toBe(0);
  });
  it("a later auto run for the same filing never re-pushes", async () => {
    const id = setup("auto");
    let n = 0;
    const send = async () => { n++; return { sent: true }; };
    await sendSummaryPushIfDue(db, id, send);
    // a second section row for the same accession (new run) under the same key
    db.prepare("UPDATE filing_summary_runs SET trigger='auto'").run();
    await sendSummaryPushIfDue(db, id, send);
    expect(n).toBe(1);
  });
  it("a crash mid-send becomes delivery_unknown and is not resent", async () => {
    const id = setup("auto");
    const key = "fs:0000000001:0000000001-26-000001";
    beginPush(db, key, eventId, "t", "m");
    expect(claimPushForSending(db, key)).toBe(true);
    expect(claimPushForSending(db, key)).toBe(false);
    expect(markSendingAsUnknown(db)).toBe(1);
    let n = 0;
    await sendSummaryPushIfDue(db, id, async () => { n++; return { sent: true }; });
    expect(n).toBe(0);
    expect((db.prepare("SELECT state FROM filing_summary_pushes").get() as { state: string }).state).toBe(DELIVERY_UNKNOWN);
  });
  it("survives an event merge: no second send once the rows move to another event", async () => {
    const id = setup("auto");
    let n = 0;
    const send = async () => { n++; return { sent: true }; };
    await sendSummaryPushIfDue(db, id, send);
    const other = Number(
      db.prepare(`INSERT INTO calendar_events (source,event_type,event_date,title,source_key,symbol)
        VALUES ('finnhub','earnings','2026-10-23','META earnings','k2','META')`).run().lastInsertRowid,
    );
    db.prepare("UPDATE filing_summary_runs SET event_id=?").run(other);
    db.prepare("UPDATE filing_summary_filings SET event_id=?").run(other);
    db.prepare("UPDATE filing_summary_pushes SET event_id=?").run(other);
    await sendSummaryPushIfDue(db, id, send);
    expect(n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM filing_summary_pushes").get()).toEqual({ c: 1 });
  });
  it("a network-style reason is delivery_unknown; not-configured and http errors are failed", async () => {
    const cases: [string, string][] = [
      ["fetch failed", DELIVERY_UNKNOWN],
      ["pushover_not_configured", "failed"],
      ["http_500", "failed"],
    ];
    for (const [i, [reason, state]] of cases.entries()) {
      const id = setup("auto", `0000000001-26-00010${i}`);
      await sendSummaryPushIfDue(db, id, async () => ({ sent: false, reason }));
      const r = db.prepare("SELECT state FROM filing_summary_pushes WHERE push_key LIKE ?").get(`%00010${i}`) as { state: string };
      expect(r.state).toBe(state);
    }
  });
  it("a refused send is failed and not retried; a throw is delivery_unknown", async () => {
    const id = setup("auto");
    await sendSummaryPushIfDue(db, id, async () => ({ sent: false, reason: "x" }));
    expect((db.prepare("SELECT state FROM filing_summary_pushes").get() as { state: string }).state).toBe("failed");
    const id2 = setup("auto", "0000000001-26-000002", "companion");
    await sendSummaryPushIfDue(db, id2, async () => { throw new Error("net"); });
    const st = db.prepare("SELECT state FROM filing_summary_pushes WHERE push_key LIKE '%000002'").get() as { state: string };
    expect(st.state).toBe(DELIVERY_UNKNOWN);
  });
});

describe("migration 099 push states", () => {
  it("CHECK literals match the shared constants", () => {
    const sql = readFileSync("lib/db/migrations/099_filing_summary.sql", "utf8");
    const block = sql.slice(sql.indexOf("CREATE TABLE filing_summary_pushes"));
    const check = block.slice(0, block.indexOf(");"));
    expect(check).toContain(`'${SENDING}'`);
    expect(check).toContain(`'${DELIVERY_UNKNOWN}'`);
  });
});
