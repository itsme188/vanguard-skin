/**
 * Unit 16 — Today and week view tidy.
 *
 *   - Browser-native confirm prompts on the week-ahead conflict buttons, the
 *     bogeys modal and the live print row are asked through the app's
 *     ConfirmDialog.
 *   - `slotAwareTitle` and the hand-entered label live in one plain lib module
 *     that both the client releases block and the server week view import.
 *   - The actuals sanity helpers live in lib/earnings/actuals-validation.ts.
 *   - With no trading-day pair, the IBKR line says the previous session's
 *     price is missing; it does not count every name as lacking a prior close.
 *
 * No DOM harness in this repo: pure helpers are run, wiring is pinned from
 * source. Invented tickers and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { HAND_ENTERED_LABEL, slotAwareTitle } from "@/lib/calendar/manual-row-display";
import { HAND_ENTERED_LABEL as CHIP_HAND_ENTERED_LABEL } from "@/app/dashboard/today/EarningsDateChip";
import {
  MANUAL_EPS_ABSOLUTE_CEILING,
  MANUAL_EPS_CONSENSUS_MULTIPLE,
  consensusForActualsCheck,
  manualActualsSanityWarnings,
  plausibleEarningsClientCopy,
} from "@/lib/earnings/actuals-validation";
import { splitPromptParagraphs } from "@/app/dashboard/components/confirm-prompt-text";
import { NO_PRIOR_SESSION_PRICE_NOTE, dayMoveGap } from "@/app/dashboard/today/day-move-gap";
import { resolveTradingDayPair } from "@/lib/digest/anomalies";
import { getIbkrTodayHoldings, summarizeIbkrDayMove } from "@/lib/queries/today-holdings";

const read = (p: string) => readFileSync(p, "utf8");

describe("native confirm prompts are gone from the three files", () => {
  const files = [
    "app/dashboard/components/calendar/EarningsConflictMarker.tsx",
    "app/dashboard/today/BogeysEditModal.tsx",
    "app/dashboard/today/LivePrintRow.tsx",
  ];
  for (const file of files) {
    it(`${file} asks through the app dialog`, () => {
      const src = read(file);
      expect(src).not.toMatch(/window\.confirm\(/);
      expect(src).not.toMatch(/(?<![\w.])confirm\(/);
      expect(src).not.toMatch(/window\.alert\(/);
      anchorIndex(src, "useConfirmPrompt()");
      // The hook hands back the dialog element; the file must render it.
      expect(src).toMatch(/\{\w+\.dialog\}/);
    });
  }

  it("the prompt hook renders the shared ConfirmDialog, outside any form or link", () => {
    const hook = read("app/dashboard/components/useConfirmPrompt.tsx");
    anchorIndex(hook, "<ConfirmDialog");
    anchorIndex(hook, "createPortal(");
    anchorIndex(hook, "document.body");
    // The dialog itself keeps its centering class.
    anchorIndex(read("app/dashboard/components/ConfirmDialog.tsx"), "m-auto");
  });

  it("splits a prompt into paragraphs on blank lines", () => {
    expect(splitPromptParagraphs("One.\n\nTwo.\n\nThree?")).toEqual(["One.", "Two.", "Three?"]);
    expect(splitPromptParagraphs("Only one.")).toEqual(["Only one."]);
    expect(splitPromptParagraphs("  \n\n ")).toEqual([""]);
  });
});

describe("EarningsConflictActions asks before it locks a date", () => {
  const src = read("app/dashboard/components/calendar/EarningsConflictMarker.tsx");
  const pick = sliceBetween(src, "async function pick(", "return (");

  it("a declined ask sends nothing", () => {
    const ask = anchorIndex(pick, "await prompt.ask(");
    const declined = anchorIndex(pick, "if (!ok) return;");
    const post = anchorIndex(pick, "confirmConflictDate(");
    expect(ask).toBeLessThan(declined);
    expect(declined).toBeLessThan(post);
  });

  it("still says the choice is locked against later syncs, and still passes wrap to the chip", () => {
    expect(pick).toContain("Calendar syncs will no longer change this date.");
    anchorIndex(src, "wrap={wrap}");
  });
});

describe("BogeysEditModal asks through the dialog", () => {
  const modal = read("app/dashboard/today/BogeysEditModal.tsx");

  it("a declined pre-print ask does not retry with force", () => {
    const fn = sliceBetween(modal, "async function submitActuals(", "async function saveActuals(");
    const ask = anchorIndex(fn, "await prompt.ask(");
    const retry = anchorIndex(fn, "await submitActuals(true)");
    const cancelled = anchorIndex(fn, "Save cancelled");
    expect(ask).toBeLessThan(retry);
    expect(retry).toBeLessThan(cancelled);
  });

  it("clear and delete return before the request when declined", () => {
    const clear = sliceBetween(modal, "async function clearActuals(", "async function remove(");
    expect(anchorIndex(clear, "await prompt.ask(")).toBeLessThan(anchorIndex(clear, "apiFetch("));
    expect(clear.slice(anchorIndex(clear, "await prompt.ask("), anchorIndex(clear, "apiFetch("))).toContain(
      "if (!confirmed) return;",
    );
    const remove = sliceBetween(modal, "async function remove(", "if (!open || typeof document");
    expect(anchorIndex(remove, "await prompt.ask(")).toBeLessThan(anchorIndex(remove, "apiFetch("));
    expect(remove.slice(anchorIndex(remove, "await prompt.ask("), anchorIndex(remove, "apiFetch("))).toContain(
      "return;",
    );
  });

  it("Escape answers the open question; it does not also close the modal", () => {
    const effect = modal.slice(anchorIndex(modal, 'e.key === "Escape"') - 200, anchorIndex(modal, 'e.key === "Escape"') + 200);
    expect(effect).toMatch(/e\.key === "Escape" && !promptOpen/);
    anchorIndex(modal, "const promptOpen = prompt.isOpen;");
  });
});

describe("LivePrintRow asks through the dialog", () => {
  const row = read("app/dashboard/today/LivePrintRow.tsx");

  it("a declined GAAP promote sends no request and shows the same cancelled line", () => {
    const body = sliceBetween(row, "async function promote()", "async function acceptLine");
    const warn = anchorIndex(body, "promoteBasisWarning(print.lines)");
    const ask = anchorIndex(body, "await prompt.ask(");
    const cancelled = anchorIndex(
      body,
      "Promote cancelled — accept the adjusted EPS line first, or promote again to use GAAP.",
    );
    const post = anchorIndex(body, "postAccept({ promoteHeadline: true })");
    expect(warn).toBeLessThan(ask);
    expect(ask).toBeLessThan(cancelled);
    expect(cancelled).toBeLessThan(post);
    expect(body.slice(cancelled, post)).toContain("return;");
  });

  it("the two 409 asks keep their own cancelled lines and their own override flags", () => {
    const fn = sliceBetween(row, "async function postAccept(", "async function acceptAllAgreed()");
    expect(fn.match(/await prompt\.ask\(/g)).toHaveLength(2);
    expect(fn).toContain("postAccept({ ...body, force: true })");
    expect(fn).toContain("postAccept({ ...body, forceSuperseded: true })");
    expect(fn).toContain("Promote cancelled — release time is still in the future.");
    for (const copy of ["SUPERSEDED_CONFIRM_COPY", "SUPERSEDED_CANDIDATE_CONFIRM_COPY", "SUPERSEDED_ACCEPT_CONFIRM_COPY"]) {
      expect(fn).toContain(copy);
    }
  });
});

describe("one module for the manual-row title and label", () => {
  const releases = read("app/dashboard/components/TodayReleases.tsx");
  const week = read("app/dashboard/today/WeekAheadView.tsx");
  const lib = read("lib/calendar/manual-row-display.ts");

  it("neither screen keeps its own copy of the rule", () => {
    for (const src of [releases, week]) {
      expect(src).not.toMatch(/\\\(Manual entry\\\)/);
      expect(src).toMatch(/import \{[^}]*slotAwareTitle[^}]*\} from "@\/lib\/calendar\/manual-row-display";/);
    }
    expect(releases).not.toContain("export function slotAwareTitle(");
    expect(week).not.toContain("export function weekAheadTitle(");
    anchorIndex(lib, "export function slotAwareTitle(");
  });

  it("the module is plain: no client directive, so a Server Component may call it", () => {
    expect(lib).not.toMatch(/^\s*["']use client["']/m);
    expect(lib).not.toMatch(/from "react"/);
  });

  it("the week view prints the shared hand-entered label, the same words as the Hub chip", () => {
    expect(HAND_ENTERED_LABEL).toBe("Entered by you");
    expect(HAND_ENTERED_LABEL).toBe(CHIP_HAND_ENTERED_LABEL);
    expect(week).toMatch(/import \{[^}]*HAND_ENTERED_LABEL[^}]*\} from "@\/lib\/calendar\/manual-row-display";/);
    expect(week).toContain("{HAND_ENTERED_LABEL}");
    expect(week).not.toContain("Entered by you");
  });

  it("the moved rule gives the answers it gave before", () => {
    const base = { event_type: "earnings" as const, raw_json: null };
    expect(slotAwareTitle({ ...base, title: "ZZA earnings (Manual entry)", event_time: "BMO" })).toBe(
      "ZZA earnings (Before Market Open)",
    );
    expect(slotAwareTitle({ ...base, title: "ZZA earnings (Manual entry)", event_time: "AMC" })).toBe(
      "ZZA earnings (After Market Close)",
    );
    expect(slotAwareTitle({ ...base, title: "ZZA earnings (Manual entry)", event_time: null })).toBe(
      "ZZA earnings (Manual entry)",
    );
  });
});

describe("the actuals sanity helpers live in lib", () => {
  const modal = read("app/dashboard/today/BogeysEditModal.tsx");
  const lib = read("lib/earnings/actuals-validation.ts");

  it("the modal imports them and defines none of them", () => {
    for (const name of [
      "manualActualsSanityWarnings",
      "consensusForActualsCheck",
      "plausibleEarningsClientCopy",
    ]) {
      expect(modal).not.toContain(`export function ${name}(`);
      anchorIndex(lib, `export function ${name}(`);
    }
    expect(modal).not.toContain("MANUAL_EPS_ABSOLUTE_CEILING =");
    expect(modal).toMatch(
      /import \{[^}]*consensusForActualsCheck[^}]*manualActualsSanityWarnings[^}]*\} from "@\/lib\/earnings\/actuals-validation";/,
    );
  });

  it("the moved helpers answer as before", () => {
    expect(MANUAL_EPS_ABSOLUTE_CEILING).toBe(1000);
    expect(MANUAL_EPS_CONSENSUS_MULTIPLE).toBe(100);
    const none = { epsActual: null, revenueActualUsd: null, epsConsensus: null, revenueConsensusUsd: null };
    expect(manualActualsSanityWarnings({ ...none, epsActual: 600_000_000, epsConsensus: 1.5 })).toEqual([
      "Actual EPS $600,000,000.00 is a long way from the EPS consensus on file ($1.50). Check it is not revenue typed into the EPS box.",
    ]);
    expect(manualActualsSanityWarnings({ ...none, epsActual: 5_000 })).toEqual([
      "Actual EPS $5,000.00 is above $1,000 a share and there is no consensus on file to compare it with. Check it is not revenue typed into the EPS box.",
    ]);
    expect(
      manualActualsSanityWarnings({ ...none, revenueActualUsd: 4_000_000_000, revenueConsensusUsd: 2_000_000_000 }),
    ).toEqual(["Actual revenue $4.00B is a long way from the revenue consensus on file ($2.00B)."]);
    expect(consensusForActualsCheck([{ eps_consensus_vendor: 1.4 }, { eps_consensus: 1.2, revenue_consensus_usd: 100 }])).toEqual({
      eps: 1.4,
      revenueUsd: 100,
    });
    expect(plausibleEarningsClientCopy(1, 2, null, null)).toBe(false);
    expect(plausibleEarningsClientCopy(1, 1.1, null, null)).toBe(true);
  });
});

describe("IBKR line with no trading-day pair", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("names the missing previous session; it does not blame every name", () => {
    const acct = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
    const seed = (symbol: string, type: string) =>
      db
        .prepare("INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, ?, 'equity')")
        .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
    const price = (sid: number, date: string, close: number) =>
      db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')").run(sid, date, close);
    const spy = seed("SPY", "ETF");
    const zza = seed("ZZA", "Stock");
    const zzb = seed("ZZB", "Stock");
    for (const sid of [zza, zzb]) {
      db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 10, '2026-07-29')").run(acct, sid);
      // Both names HAVE both closes. Thursday 07-30 and Friday 07-31.
      price(sid, "2026-07-30", 100);
      price(sid, "2026-07-31", 101);
    }
    // The benchmark missed the previous session: Wednesday and Friday only.
    price(spy, "2026-07-29", 600);
    price(spy, "2026-07-31", 606);

    const pair = resolveTradingDayPair(db);
    expect(pair).toBeNull();
    const summary = summarizeIbkrDayMove(getIbkrTodayHoldings(db, acct, pair));
    // The old line printed this count as "N without a prior close": every
    // name, though each one has its close on file.
    expect(summary.todayGain).toBeNull();
    expect(summary.unpricedCount).toBe(2);

    expect(dayMoveGap(pair !== null, summary.unpricedCount)).toBe("no_session_pair");
    expect(NO_PRIOR_SESSION_PRICE_NOTE).toMatch(/previous session's price is missing/i);
    expect(NO_PRIOR_SESSION_PRICE_NOTE).not.toMatch(/names?|every|all/i);
  });

  it("with a pair, a name without a close is still counted; with none missing, nothing is said", () => {
    expect(dayMoveGap(true, 3)).toBe("names_unpriced");
    expect(dayMoveGap(true, 0)).toBeNull();
    expect(dayMoveGap(false, 0)).toBe("no_session_pair");
  });

  it("the page shows the note in place of the per-name count", () => {
    const page = read("app/dashboard/today/page.tsx");
    const line = page.slice(
      anchorIndex(page, "IBKR today — one line"),
      anchorIndex(page, "</section>", anchorIndex(page, "IBKR today — one line")),
    );
    anchorIndex(page, "const moveGap = dayMoveGap(movePair !== null, dayMove.unpricedCount);");
    const note = anchorIndex(line, 'moveGap === "no_session_pair"');
    anchorIndex(line, "{NO_PRIOR_SESSION_PRICE_NOTE}", note);
    const count = anchorIndex(line, "<Count value={dayMove.unpricedCount} /> without a prior close");
    // The count renders only under its own branch.
    expect(line.slice(line.lastIndexOf("moveGap ===", count), count)).toContain('moveGap === "names_unpriced"');
  });
});
