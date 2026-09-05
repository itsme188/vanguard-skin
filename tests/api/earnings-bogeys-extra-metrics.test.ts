/**
 * Slice F, Task 4 — /api/earnings/bogeys carries the desk's extra metric lines
 * (spec §4.7) and re-derives the event's live sheet in the SAME transaction as
 * the bogey write.
 *
 * Every identifier here is synthetic (XMPL1, fixed uuids): the repo is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const A = "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3";
const B = "0c9e2d71-4a5b-4c6d-9e8f-1a2b3c4d5e6f";
const metric = (o: Record<string, unknown> = {}) => ({
  id: A, label: "Net new ARR", definition: "Sequential change in ARR.",
  unit: "usd", kind: "point", period: "Q", basis: "na", ...o,
});

// The route module does `import { db } from "@/lib/db"`; the getter keeps that
// live binding pointed at whatever in-memory DB this test just built.
const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;
let seq = 0;

/** `calendar_events.source_key` is UNIQUE NOT NULL (migration 013), so it is
 *  supplied rather than defaulted; the counter keeps it unique per seed. */
function seedEvent(): number {
  seq += 1;
  db.prepare(
    `INSERT INTO calendar_events (event_date, event_type, title, symbol, source, source_key)
     VALUES ('2026-09-10','earnings','XMPL1 Q3','XMPL1','manual', ?)`,
  ).run(`manual:XMPL1:earnings:2026-09-10:${seq}`);
  return Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

function seedPrint(eventId: number, state: string): number {
  db.prepare(
    `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL1', '2026-09-10', ?)`,
  ).run(eventId, state);
  return Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  vi.resetModules();
});

describe("POST /api/earnings/bogeys — extra_metrics_json", () => {
  it("stores a valid array and reports every parse error on an invalid one", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();

    const ok = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    expect(ok.status).toBe(200);
    const stored = db.prepare(`SELECT extra_metrics_json FROM earnings_bogeys WHERE event_id = ?`).get(eventId) as { extra_metrics_json: string };
    expect(JSON.parse(stored.extra_metrics_json)[0].id).toBe(A);

    const bad = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet B", extra_metrics_json: JSON.stringify([{ ...metric(), id: "nope" }]) }),
    }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ success: false, error: "Metric 1: id must be a full uuid (v4)." });
  });

  it("recompiles the event's live print after the write and says what changed", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    seedPrint(eventId, "window_open");

    const res = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", eps_consensus: 0.46, extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.recompiled.added).toContain(`x_${A}_Q`);
    const line = db.prepare(`SELECT state FROM print_watch_lines WHERE metric_id = ?`).get(`x_${A}_Q`) as { state: string };
    expect(line.state).toBe("pending");
  });

  it("does not recompile an expired print", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    seedPrint(eventId, "expired");
    const res = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    expect((await res.json()).recompiled).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });
  });

  it("does not recompile a disarmed print, and a no-print event is an ordinary no-op", async () => {
    const { POST } = await import("@/app/api/earnings/bogeys/route");
    const disarmed = seedEvent();
    seedPrint(disarmed, "disarmed");
    const one = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: disarmed, source_label: "Sheet A", extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    expect((await one.json()).recompiled).toBeUndefined();

    const unarmed = seedEvent();
    const two = await POST(new Request("http://localhost/api/earnings/bogeys", {
      method: "POST",
      body: JSON.stringify({ event_id: unarmed, source_label: "Sheet A", extra_metrics_json: JSON.stringify([metric()]) }),
    }));
    const body = await two.json();
    expect(body.success).toBe(true);
    expect(body.recompiled).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });
  });
});

describe("GET /api/earnings/bogeys — extraMetricConflicts", () => {
  it("names the id and the disagreeing fields when two rows disagree, and is empty otherwise", async () => {
    const { GET } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', ?, ?)`,
    );
    ins.run(eventId, "A", JSON.stringify([metric()]));
    const clean = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    expect(clean.success).toBe(true);
    expect(clean.extraMetricConflicts).toEqual([]);

    ins.run(eventId, "B", JSON.stringify([metric({ unit: "pct", kind: "range" })]));
    const dirty = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    expect(dirty.extraMetricConflicts).toEqual([{ id: A, fields: ["kind", "unit"] }]);
  });

  it("refuses a missing eventId with the failure envelope at the same status", async () => {
    const { GET } = await import("@/app/api/earnings/bogeys/route");
    const res = await GET(new Request("http://localhost/api/earnings/bogeys"));
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
  });
});

describe("DELETE /api/earnings/bogeys", () => {
  it("recompiles after removing a sheet, retiring a line that had a value", async () => {
    const { DELETE } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', 'A', ?)`,
    ).run(eventId, JSON.stringify([metric()]));
    const bogeyId = Number((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    const printId = seedPrint(eventId, "acquired");
    db.prepare(
      `INSERT INTO print_watch_lines (print_id, metric_id, contract_json, state, value, candidates_json)
       VALUES (?, ?, ?, 'accepted', 275000000, '[]')`,
    ).run(printId, `x_${A}_Q`, JSON.stringify({ metric_id: `x_${A}_Q`, label: "Net new ARR", definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null }));

    const res = await DELETE(new Request(`http://localhost/api/earnings/bogeys?id=${bogeyId}`, { method: "DELETE" }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(true);
    expect(body.recompiled.retired).toEqual([`x_${A}_Q~retired~0`]);
  });

  it("reports a no-op honestly when the row is already gone", async () => {
    const { DELETE } = await import("@/app/api/earnings/bogeys/route");
    const res = await DELETE(new Request("http://localhost/api/earnings/bogeys?id=4242", { method: "DELETE" }));
    const body = await res.json();
    expect(body).toEqual({ success: true, deleted: false });
  });
});

describe("extra-metric identity is the id: add + remove, never an edit (R-F2)", () => {
  it("dropping id A while adding id B retires A's evidenced line and compiles B", async () => {
    const { POST, GET } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    seedPrint(eventId, "acquired");

    const save = (extra: unknown[]) =>
      POST(new Request("http://localhost/api/earnings/bogeys", {
        method: "POST",
        body: JSON.stringify({ event_id: eventId, source_label: "Sheet A", extra_metrics_json: JSON.stringify(extra) }),
      }));

    await save([metric()]);
    // The desk accepted a reading against A's definition.
    db.prepare(`UPDATE print_watch_lines SET state = 'accepted', value = 275000000 WHERE metric_id = ?`).run(`x_${A}_Q`);

    const res = await save([metric({ id: B, label: "Net new ARR (re-minted)" })]);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.recompiled.retired).toEqual([`x_${A}_Q~retired~0`]);
    expect(body.recompiled.added).toEqual([`x_${B}_Q`]);

    const rows = db.prepare(`SELECT metric_id, state, value FROM print_watch_lines ORDER BY metric_id`).all() as
      Array<{ metric_id: string; state: string; value: number | null }>;
    const retired = rows.find((r) => r.metric_id === `x_${A}_Q~retired~0`)!;
    expect(retired.state).toBe("retired");
    expect(retired.value).toBe(275_000_000);      // the reading survives a re-mint
    expect(rows.find((r) => r.metric_id === `x_${B}_Q`)!.state).toBe("pending");

    // …and the GET hands the surviving id back so the modal can preserve it.
    const read = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    expect(read.bogeys[0].extraMetrics.map((s: { id: string }) => s.id)).toEqual([B]);
  });
});

describe("the bogey write and the recompile are ONE transaction (Codex 6)", () => {
  it("a throwing recompile rolls the bogey write back — and the same call commits when nothing throws", async () => {
    const { saveBogeyWithRecompile } = await import("@/lib/mutations/earnings-bogeys");
    const eventId = seedEvent();
    seedPrint(eventId, "acquired");
    const count = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get() as { n: number }).n;

    // CONTROL (review M-5): the identical call down the identical path, with the
    // sheet table intact, DOES write. Without it the assertion below cannot tell
    // "rolled back" from "never written at all" — a refactor that moved the
    // recompile ahead of the upsert would keep the old test green while proving
    // nothing about atomicity.
    saveBogeyWithRecompile(db, {
      event_id: eventId, source: "manual", source_label: "Sheet A", eps_consensus: 0.46,
    });
    expect(count()).toBe(1);

    // A print row whose FK target the recompile's INSERT cannot satisfy is hard
    // to fake honestly, so break the sheet table for the duration instead: the
    // point is that ANY throw inside the recompile unwinds the outer write.
    db.exec(`DROP TABLE print_watch_lines`);
    expect(() =>
      // A DIFFERENT source_label, so this is a second INSERT rather than an
      // update of the row the control wrote — the count below can see it.
      saveBogeyWithRecompile(db, { event_id: eventId, source: "manual", source_label: "Sheet B", eps_consensus: 0.46 }),
    ).toThrow();
    expect(count()).toBe(1);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE source_label = 'Sheet B'`).get(),
    ).toEqual({ n: 0 });
  });

  it("the bogey is written BEFORE the recompile, so its absence afterwards is a rollback", async () => {
    const { saveBogeyWithRecompile } = await import("@/lib/mutations/earnings-bogeys");
    const eventId = seedEvent();
    seedPrint(eventId, "acquired");
    // A sheet-line write that refuses ONLY once this very call's bogey row is
    // visible. Dropping the table (above) proves "a throw unwinds the write",
    // but it throws before the recompile can observe anything, so it cannot
    // tell a rollback from a write that never happened — a refactor moving the
    // recompile ahead of the upsert would keep it green (review M-5). Here the
    // same refactor makes the guard silent, the call succeed, and this test red.
    const guard =
      `WHEN (SELECT COUNT(*) FROM earnings_bogeys WHERE source_label = 'Sheet B') = 1 ` +
      `BEGIN SELECT RAISE(ABORT, 'the bogey row was already written'); END`;
    db.exec(`CREATE TRIGGER t_line_ins AFTER INSERT ON print_watch_lines ${guard};`);
    db.exec(`CREATE TRIGGER t_line_upd AFTER UPDATE ON print_watch_lines ${guard};`);

    expect(() =>
      saveBogeyWithRecompile(db, {
        event_id: eventId, source: "manual", source_label: "Sheet B", eps_consensus: 0.46,
      }),
    ).toThrow(/already written/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });
  });
});

describe("the GET republishes each row's stored specs (Codex 1)", () => {
  it("returns parsed specs with their stored ids, and reports an unreadable value instead of hiding it", async () => {
    const { GET } = await import("@/app/api/earnings/bogeys/route");
    const eventId = seedEvent();
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, extra_metrics_json) VALUES (?, 'manual', ?, ?)`,
    );
    ins.run(eventId, "A", JSON.stringify([metric()]));
    ins.run(eventId, "B", "{not json");
    const body = await (await GET(new Request(`http://localhost/api/earnings/bogeys?eventId=${eventId}`))).json();
    const a = body.bogeys.find((b: { source_label: string }) => b.source_label === "A");
    const b = body.bogeys.find((x: { source_label: string }) => x.source_label === "B");
    expect(a.extraMetrics.map((s: { id: string }) => s.id)).toEqual([A]);
    expect(a.extraMetricErrors).toEqual([]);
    expect(b.extraMetrics).toEqual([]);
    expect(b.extraMetricErrors).toEqual(["Extra metrics must be valid JSON."]);
  });
});
