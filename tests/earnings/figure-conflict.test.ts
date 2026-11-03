/**
 * T1 chip-and-hold (2026-11-01 ruling, item 1): the disagreement formula, the
 * chip view, and the hold on the AUTO-recap. Synthetic figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  CONFLICT_THRESHOLD,
  EPS_FLOOR,
  REVENUE_FLOOR,
  disagreementRatio,
  findMetricConflicts,
  getRecapHold,
  recapHoldChipView,
  UNCHECKED_REASON,
} from "@/lib/earnings/figure-conflict";
import { sendEarningsCandidate } from "@/lib/earnings/send-service";
import { saveManualActuals, clearManualActuals } from "@/lib/earnings/actuals";
import { evaluatePrintOutputs } from "@/lib/earnings/print-outputs";
import { upsertPrint } from "@/lib/print-watch/store";
import type { ComposeEarningsResult } from "@/lib/digest/send-earnings-email";

const STAMP = "2026-09-10 21:00:00";
const pair = (actual: string, vendor: string | null, stamped = true) => ({
  actualValue: actual,
  manualActualsAt: stamped ? STAMP : null,
  vendorActualValue: vendor,
});

describe("threshold and formula", () => {
  it("the constant is 2%", () => {
    expect(CONFLICT_THRESHOLD).toBe(0.02);
  });

  it("exactly 2% is NOT a conflict (float noise rounded away); just over is", () => {
    // 1.02 - 1.00 is 0.020000000000000018 in floats.
    expect(findMetricConflicts(pair("EPS 1.00", "EPS 1.02"))).toEqual([]);
    expect(findMetricConflicts(pair("EPS 100", "EPS 102"))).toEqual([]);
    const over = findMetricConflicts(pair("EPS 10.00", "EPS 10.21"));
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ metric: "EPS", accepted: 10, vendor: 10.21 });
  });

  it("just under is clear", () => {
    expect(findMetricConflicts(pair("EPS 10.00", "EPS 10.19"))).toEqual([]);
  });

  it("is relative to the ACCEPTED figure", () => {
    // 100 -> 102 is 2.0% of accepted; 102 -> 100 is 1.96% of 102 but 2.0% of... accepted=102 base 102.
    expect(disagreementRatio(100, 102, 0)).toBe(0.02);
    expect(disagreementRatio(102, 100, 0)).toBe(0.019608);
  });

  it("revenue is compared in dollars", () => {
    expect(
      findMetricConflicts(pair("EPS 1.00 · Rev 1000000000", "EPS 1.00 · Rev 1020000000")),
    ).toEqual([]);
    const c = findMetricConflicts(pair("EPS 1.00 · Rev 1000000000", "EPS 1.00 · Rev 1030000000"));
    expect(c.map((x) => x.metric)).toEqual(["Revenue"]);
  });

  it("negative accepted EPS uses its magnitude as the base", () => {
    expect(findMetricConflicts(pair("EPS -2.00", "EPS -2.04"))).toEqual([]);
    expect(findMetricConflicts(pair("EPS -2.00", "EPS -2.05"))).toHaveLength(1);
  });

  it("a sign flip is a conflict", () => {
    expect(findMetricConflicts(pair("EPS -0.50", "EPS 0.50"))).toHaveLength(1);
  });

  it("near-zero accepted EPS divides by the floor, never by ~0", () => {
    expect(EPS_FLOOR).toBe(0.25);
    expect(findMetricConflicts(pair("EPS 0.00", "EPS 0.00"))).toEqual([]);
    // 1 cent over a $0.25 base is 4%.
    expect(findMetricConflicts(pair("EPS 0.00", "EPS 0.01"))).toHaveLength(1);
    // half a cent is exactly 2%: clear (EPS prints at cents, so this is the floor of the tolerance).
    expect(disagreementRatio(0, 0.005, EPS_FLOOR)).toBe(0.02);
    expect(Number.isFinite(disagreementRatio(0, 0.3, EPS_FLOOR))).toBe(true);
  });

  it("near-zero accepted revenue divides by the floor", () => {
    expect(REVENUE_FLOOR).toBe(1_000_000);
    expect(findMetricConflicts(pair("Rev 100", "Rev 5000"))).toEqual([]);
    expect(findMetricConflicts(pair("Rev 100", "Rev 50000"))).toHaveLength(1);
  });

  it("compares only metrics present on both sides", () => {
    expect(findMetricConflicts(pair("EPS 1.00", "Rev 5000000000"))).toEqual([]);
    expect(findMetricConflicts(pair("EPS 1.00 · Rev 1000000000", "EPS 2.00"))).toHaveLength(1);
  });

  it("an unstamped row has no accepted figure; no vendor figure kept is clear", () => {
    expect(findMetricConflicts(pair("EPS 1.00", "EPS 9.00", false))).toEqual([]);
    expect(findMetricConflicts(pair("EPS 1.00", null))).toEqual([]);
  });
});

describe("chip view", () => {
  it("names both figures and their sources", () => {
    const hold = getHoldFor("EPS 1.20 · Rev 5000000000", "EPS 1.10 · Rev 5000000000");
    const view = recapHoldChipView(hold)!;
    expect(view.kind).toBe("conflict");
    expect(view.label).toContain("EPS filing $1.20 vs vendor $1.10");
    expect(view.label).toContain("recap held");
    expect(view.title).toContain("filing");
    expect(view.title).toContain("vendor");
  });
  it("is null when nothing is held", () => {
    expect(recapHoldChipView({ held: false })).toBeNull();
  });
  it("an unchecked hold says the figures were not compared", () => {
    const v = recapHoldChipView({ held: true, kind: "unchecked", reason: UNCHECKED_REASON })!;
    expect(v.label).toMatch(/not compared/);
  });
});

// ── DB-backed ──────────────────────────────────────────────────────────────
let db: Database.Database;
let eventId: number;
const RECIPIENT = "desk@example.com";
const composed: ComposeEarningsResult = {
  symbol: "XMPL",
  title: "XMPL Earnings Recap",
  markdown: "# XMPL\n\nbody",
  aiMarkdown: "body",
  html: "<p>body</p>",
  promptHash: "h",
};

function seed(actual: string, vendor: string | null, stamped: boolean): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key,
                                      actual_value, vendor_actual_value, manual_actuals_at, enriched_at)
         VALUES ('manual','earnings','2026-09-10','XMPL earnings','XMPL','k1',?,?,?, datetime('now'))`,
      )
      .run(actual, vendor, stamped ? STAMP : null).lastInsertRowid,
  );
}
function getHoldFor(actual: string, vendor: string) {
  const conn = new Database(":memory:");
  runMigrations(conn);
  const id = Number(
    conn
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key,
                                      actual_value, vendor_actual_value, manual_actuals_at)
         VALUES ('manual','earnings','2026-09-10','X','XMPL','k1',?,?,?)`,
      )
      .run(actual, vendor, STAMP).lastInsertRowid,
  );
  const h = getRecapHold(conn, id);
  conn.close();
  return h;
}

const send = (mode: "sweep" | "nudge" | "manual") =>
  sendEarningsCandidate(
    db,
    { eventId, symbol: "XMPL", phase: "recap" },
    {
      mode,
      recipient: RECIPIENT,
      seams: {
        compose: async () => composed,
        sendEmail: async (o: { messageId?: string }) => ({ messageId: o.messageId!, response: "250" }),
        markers: {
          setRunning: async () => {},
          clearRunning: async () => {},
          writeMacSent: async () => {},
        },
        checkCloudMarker: async () => null,
      },
    },
  );

beforeEach(() => {
  vi.stubEnv("WORKER_MARKER_URL", "");
  vi.stubEnv("CRON_SHARED_SECRET", "");
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe("the auto-recap hold", () => {
  it("the sweep does not send a recap whose figures disagree, and writes nothing", async () => {
    eventId = seed("EPS 1.20 · Rev 5000000000", "EPS 1.10 · Rev 5000000000", true);
    const res = await send("sweep");
    expect(res).toMatchObject({ outcome: "refused", status: 409, hold: "conflict" });
    expect((res as { reason: string }).reason).toMatch(/filing \$1\.20 vs vendor \$1\.10/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails`).get()).toEqual({ n: 0 });
  });

  it("releases through the human path: the nudge and the manual route send", async () => {
    eventId = seed("EPS 1.20", "EPS 1.10", true);
    expect(await send("sweep")).toMatchObject({ hold: "conflict" });
    expect(await send("nudge")).toMatchObject({ outcome: "sent" });
    // And once a recap exists the sweep has nothing left to hold or send.
    expect((await send("sweep")).outcome).not.toBe("sent");
  });

  it("the manual route is never held", async () => {
    eventId = seed("EPS 1.20", "EPS 1.10", true);
    expect(await send("manual")).toMatchObject({ outcome: "sent" });
  });

  it("releases when the figures stop disagreeing (Save actuals within 2%)", async () => {
    eventId = seed("EPS 1.20", "EPS 1.10", true);
    expect(getRecapHold(db, eventId).held).toBe(true);
    // a hand save of a figure that now agrees with the kept vendor figure
    const r = saveManualActuals(db, { eventId, epsActual: 1.1, force: true });
    expect(r.ok).toBe(true);
    expect(getRecapHold(db, eventId)).toEqual({ held: false });
    expect(await send("sweep")).toMatchObject({ outcome: "sent" });
  });

  it("releases when the hand-entered actuals are cleared", async () => {
    eventId = seed("EPS 1.20", "EPS 1.10", true);
    expect(clearManualActuals(db, { eventId }).ok).toBe(true);
    expect(getRecapHold(db, eventId)).toEqual({ held: false });
  });

  it("below threshold behaves exactly as today: the sweep sends", async () => {
    eventId = seed("EPS 1.00", "EPS 1.02", true);
    expect(getRecapHold(db, eventId)).toEqual({ held: false });
    expect(await send("sweep")).toMatchObject({ outcome: "sent" });
  });

  it("a vendor-only row (no accepted figure) is untouched", async () => {
    eventId = seed("EPS 1.20", null, false);
    expect(await send("sweep")).toMatchObject({ outcome: "sent" });
  });

  it("previews are never held", async () => {
    eventId = seed("EPS 1.20", "EPS 1.10", true);
    const res = await sendEarningsCandidate(
      db,
      { eventId, symbol: "XMPL", phase: "preview" },
      {
        mode: "sweep",
        recipient: RECIPIENT,
        seams: {
          compose: async () => composed,
          sendEmail: async (o: { messageId?: string }) => ({ messageId: o.messageId!, response: "250" }),
          markers: { setRunning: async () => {}, clearRunning: async () => {}, writeMacSent: async () => {} },
          checkCloudMarker: async () => null,
        },
      },
    );
    expect(res.outcome).toBe("sent");
  });
});

describe("fail-safe", () => {
  it("a check that throws is held-with-reason, not clear", () => {
    const broken = {
      prepare() {
        throw new Error("boom");
      },
    } as unknown as Database.Database;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hold = getRecapHold(broken, 1);
    warn.mockRestore();
    expect(hold).toEqual({ held: true, kind: "unchecked", reason: UNCHECKED_REASON });
  });
});

describe("recap state surface", () => {
  it("print outputs carry the hold with its reason, and the human button stays governed by its own gate", () => {
    eventId = seed("EPS 1.20", "EPS 1.10", true);
    const printId = upsertPrint(db, eventId, "XMPL", "2026-09-10", "16:05");
    const out = evaluatePrintOutputs(db, printId);
    expect(out.sendRecap.hold).toMatchObject({ kind: "conflict" });
    expect(out.sendRecap.hold?.reason).toMatch(/vendor/);
  });

  it("no hold is reported when figures agree, or once a recap exists", () => {
    eventId = seed("EPS 1.00", "EPS 1.01", true);
    const printId = upsertPrint(db, eventId, "XMPL", "2026-09-10", "16:05");
    expect(evaluatePrintOutputs(db, printId).sendRecap.hold).toBeNull();
    db.prepare(`UPDATE calendar_events SET vendor_actual_value = 'EPS 5.00' WHERE id = ?`).run(eventId);
    expect(evaluatePrintOutputs(db, printId).sendRecap.hold).not.toBeNull();
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'recap', 'me@example.com', datetime('now'), NULL)`,
    ).run(eventId);
    expect(evaluatePrintOutputs(db, printId).sendRecap.hold).toBeNull();
  });
});
