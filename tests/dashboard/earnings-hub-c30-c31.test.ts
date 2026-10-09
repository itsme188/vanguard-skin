/**
 * Earnings Hub decisions (units C30, C31). No DOM harness: pure helpers are
 * tested directly, wiring is pinned against source with loud anchors.
 * Symbols, dates and times are synthetic.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// EarningsHub.tsx imports the db singleton; the helpers under test never touch it.
vi.mock("@/lib/db", () => ({ db: null }));

import {
  hubRowStatus,
  slotTimeContradiction,
  whenCell,
} from "@/app/dashboard/today/EarningsHub";
import {
  standingOverrideLine,
  symbolWideNote,
} from "@/app/dashboard/today/EarningsDateChip";
import { MAX_TICKER_LENGTH } from "@/lib/calendar/manual-event-input";
import { TICKER_INPUT_MAX_LENGTH } from "@/app/dashboard/today/EarningsHubAddForm";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { coveredForEvents, getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { addDays, todayET } from "@/lib/calendar/date-utils";

const read = (p: string) => readFileSync(p, "utf8");
const HUB = read("app/dashboard/today/EarningsHub.tsx");
const DATE_CHIP = read("app/dashboard/today/EarningsDateChip.tsx");
const ADD_FORM = read("app/dashboard/today/EarningsHubAddForm.tsx");

const STORED = { label: "4:05 PM", kind: "stored" as const };

// qa:dashboard-today-earningshub-pos-column-arm-control-arming-one-event-marks-every-other-hub-row-for-the-same-sym
describe("hubRowStatus — the POS chip names the row's own print", () => {
  it("a symbol armed on another date does not mark this row ARMED", () => {
    expect(hubRowStatus("armed", false)).toBe("neither");
  });

  it("the row whose own event is armed reads ARMED", () => {
    expect(hubRowStatus("armed", true)).toBe("armed");
    // Armed outside the symbol-level horizon still names its own print.
    expect(hubRowStatus("neither", true)).toBe("armed");
  });

  it("held and watchlist are symbol facts and win either way", () => {
    expect(hubRowStatus("held", false)).toBe("held");
    expect(hubRowStatus("held", true)).toBe("held");
    expect(hubRowStatus("watchlist", false)).toBe("watchlist");
    expect(hubRowStatus("watchlist", true)).toBe("watchlist");
    expect(hubRowStatus("neither", false)).toBe("neither");
  });

  it("two rows of one unheld symbol, one armed: only that row reads ARMED", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const seed = (date: string) =>
      Number(
        db
          .prepare(
            `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded)
             VALUES ('manual','earnings',?,?,?,?,0)`,
          )
          .run(date, "AAA earnings", `manual:AAA:${date}:earnings`, "AAA").lastInsertRowid,
      );
    const armedId = seed(addDays(todayET(), 1));
    const otherId = seed(addDays(todayET(), 2));
    armWorksheet(db, armedId);

    // The symbol-level status marks the whole symbol: the defect's source.
    const symbolStatus = getSymbolStatus(db, ["AAA"]).AAA;
    expect(symbolStatus).toBe("armed");
    const cluster = coveredForEvents(db, [
      { symbol: "AAA", eventId: armedId },
      { symbol: "AAA", eventId: otherId },
    ]);
    expect(hubRowStatus(symbolStatus, cluster.has(armedId))).toBe("armed");
    expect(hubRowStatus(symbolStatus, cluster.has(otherId))).toBe("neither");
    db.close();
  });

  it("the hub feeds it the event's armed cluster, not the symbol status alone", () => {
    const build = sliceBetween(HUB, "const enriched: EnrichedRow[] = events.map(", "// Group by event_date");
    expect(build).toContain("status: hubRowStatus(");
    expect(build).toContain("armedCluster.has(e.id)");
    anchorIndex(HUB, "const armedCluster = coveredForEvents(");
  });
});

// qa:today-earningshub-when--lac-bmo-slot-contradicts-verified-release-time-regression-1
describe("slotTimeContradiction — flag, never re-derive", () => {
  const row = (
    event_time: string | null,
    release_time: string | null,
    raw_json: string | null = null,
    display_time: { label: string | null; kind: "stored" | "usual" | "unknown" } = STORED,
  ) => ({ event_time, release_time, raw_json, display_time });

  it("a before-open slot with a time at or after the open is flagged", () => {
    expect(slotTimeContradiction(row("BMO", "10:55"))).toMatch(/after the open/);
    expect(slotTimeContradiction(row("bmo", "09:30"))).toMatch(/after the open/);
    expect(slotTimeContradiction(row("BMO", "09:29"))).toBeNull();
    expect(slotTimeContradiction(row("BMO", "07:00"))).toBeNull();
  });

  it("an after-close slot with a morning time is flagged", () => {
    expect(slotTimeContradiction(row("AMC", "07:30"))).toMatch(/before midday/);
    expect(slotTimeContradiction(row("AMC", "11:59"))).toMatch(/before midday/);
    expect(slotTimeContradiction(row("AMC", "12:00"))).toBeNull();
    expect(slotTimeContradiction(row("AMC", "16:05"))).toBeNull();
  });

  it("a vendor row is judged on the vendor slot the cell shows", () => {
    const bmo = JSON.stringify({ entry: { hour: "bmo" } });
    expect(slotTimeContradiction(row(null, "10:55", bmo))).toMatch(/after the open/);
    expect(slotTimeContradiction(row(null, "07:00", bmo))).toBeNull();
  });

  it("nothing to compare means no flag", () => {
    expect(slotTimeContradiction(row("BMO", null))).toBeNull();
    expect(slotTimeContradiction(row(null, "10:55", "{}"))).toBeNull();
    expect(slotTimeContradiction(row("TAS", "10:55"))).toBeNull();
    expect(slotTimeContradiction(row("BMO", "not a time"))).toBeNull();
  });

  it("a cell that shows an estimate or 'time unknown' prints no time, so no flag", () => {
    const unknown = { label: "time unknown", kind: "unknown" as const };
    expect(slotTimeContradiction(row("BMO", "16:15", null, unknown))).toBeNull();
  });

  it("the cell text itself is never rewritten", () => {
    expect(whenCell(row("BMO", "10:55"))).toBe("BMO · 10:55");
  });

  it("both layouts render the flag beside the cell", () => {
    const desktop = sliceBetween(HUB, "function DesktopRow(", "function NumCell(");
    const mobile = sliceBetween(HUB, "function MobileCard(", "<EmailFollowsEarlierNote\n        symbol={event.symbol}\n        emailFollowsDate={event.emailFollowsDate}\n        className");
    expect(desktop).toContain("<SlotTimeFlag event={event} />");
    expect(mobile).toContain("<SlotTimeFlag event={event} />");
  });
});

// qa:today-earningshub-header--all-sent-link-reads-as-status
describe("hub header archive link", () => {
  const header = sliceBetween(HUB, "{/* Section header", "<EarningsHubLive");

  it("is labelled as an archive, not a status", () => {
    expect(header).toContain("Email archive →");
    expect(header).not.toContain("All sent");
  });

  it("stands apart from the event count instead of continuing it", () => {
    const link = header.slice(anchorIndex(header, 'href="/dashboard/alerts?view=emails"'));
    expect(link).toContain("border-l border-edge");
    expect(link).not.toContain("· Email archive");
  });
});

// qa:today-earningshub-release-time--save-on-one-event-retimes-symbol-siblings-and-drops-note
describe("release-time editor — says what a Save touches", () => {
  it("names the symbol-wide scope", () => {
    expect(symbolWideNote("AAA")).toBe(
      "One standing time for every AAA print, not only this row.",
    );
    expect(symbolWideNote("")).toBe("One standing time for every print of this ticker, not only this row.");
  });

  it("shows the standing override with its source, note and verified date", () => {
    expect(
      standingOverrideLine({
        source: "web_verified",
        release_time: "16:10",
        note: "wire timestamp",
        verified_for_date: "2030-01-15",
      }),
    ).toBe("Standing: 16:10 · web-verified · verified for 2030-01-15 · “wire timestamp”. Save changes the time and keeps the note.");
    expect(standingOverrideLine({ source: "user", release_time: "07:30", note: "set in app" })).toBe(
      "Standing: 07:30 · set by you · “set in app”. Save changes the time and keeps the note.",
    );
    expect(standingOverrideLine({ source: "user", release_time: "07:30" })).toBe(
      "Standing: 07:30 · set by you. Save changes the time and keeps the note.",
    );
  });

  it("no standing override, no line", () => {
    expect(standingOverrideLine(null)).toBeNull();
    expect(standingOverrideLine(undefined)).toBeNull();
  });

  it("the editor renders both", () => {
    const editor = sliceBetween(DATE_CHIP, "function ReleaseTimeEditor(", "export function EarningsDateChip(");
    expect(editor).toContain("{symbolWideNote(symbol)}");
    expect(editor).toContain("standingOverrideLine(rt?.override)");
  });
});

// qa:mobile-earningshub-footer--add-ticker-refresh-upload-21px-no-touch-extension
describe("+ Add ticker form chrome", () => {
  const EXT =
    "relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2";

  it("the opener and Cancel carry the footer's touch extension", () => {
    const opener = ADD_FORM.slice(0, anchorIndex(ADD_FORM, "\n          + Add ticker\n"));
    expect(opener.slice(opener.lastIndexOf("<button"))).toContain(EXT);
    const cancel = ADD_FORM.slice(0, anchorIndex(ADD_FORM, "\n        Cancel\n"));
    expect(cancel.slice(cancel.lastIndexOf("<button"))).toContain(EXT);
  });

  it("the ticker input allows as many characters as the server does", () => {
    expect(TICKER_INPUT_MAX_LENGTH).toBe(MAX_TICKER_LENGTH);
    expect(ADD_FORM).toContain("maxLength={TICKER_INPUT_MAX_LENGTH}");
    expect(ADD_FORM).not.toContain("maxLength={10}");
  });
});
