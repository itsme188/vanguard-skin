/**
 * QA finding cmdk--hover-steals-enter-target-expired-options-ranked-above-stock-regression-2
 * (fourth sighting): resting the mouse mid-viewport, pressing Cmd+K, typing
 * an exact ticker (MSFT), and pressing Enter landed on an unrelated expired
 * option contract instead of the typed stock — the parked pointer sat over
 * a results row that got a synthesized mouseenter/mouseover when new rows
 * rendered underneath it (browsers recompute hit-testing / :hover after a
 * layout change even with no real pointer motion), silently moving the
 * keyboard-active row away from the default (index 0, the exact match).
 *
 * QA finding cmdk--hover-steals-enter-target-expired-options-ranked-above-stock-regression-3
 * (third occurrence): the regression-2 fix (onMouseEnter -> onMouseMove)
 * stopped the PHANTOM case above but not GENUINE cursor drift. The pointer
 * routinely parks mid-viewport after almost any click, and mousemove fires
 * on real (non-phantom) motion too — so typing MSFT (stock at row 0, option
 * contracts after) while the cursor happened to sit or drift over row 4
 * still silently moved the keyboard-active row there, and Enter landed on
 * an unrelated expired option. Cmd+K -> type -> Enter is the default
 * gesture, so this misfired routinely. Fix: the pointer no longer writes
 * selectedIndex at all — ArrowUp/ArrowDown and the result-list reset are the
 * only writers. Rows keep a CSS-only :hover tint so hovering still looks
 * interactive, and a click on a row still navigates that row; only "which
 * row does Enter target" stops following the pointer.
 *
 * CommandPalette is "use client" with no jsdom/@testing-library/react
 * harness in this repo (see precedent note in
 * tests/dashboard/narrative-block-refresh.test.ts) — the hover fix is
 * pinned with a source scan, same pattern as
 * tests/dashboard/tax-report-card-scope.test.ts's "source pin" section.
 *
 * The second half of the finding ("exact ticker matches should rank above
 * option contracts") is pinned behaviorally against the real /api/search
 * route + an in-memory DB (same harness as tests/api/search.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";

describe("CommandPalette hover wiring (source pin)", () => {
  const src = readFileSync("app/dashboard/components/CommandPalette.tsx", "utf8");

  it("does not update the keyboard selection from onMouseEnter (fires on phantom hit-test recompute, not just real pointer motion)", () => {
    expect(src).not.toMatch(/onMouseEnter=\{\(\) => setSelectedIndex/);
  });

  it("regression-3: does not update the keyboard selection from ANY pointer event, including onMouseMove — genuine cursor drift (not just phantom hover) was still stealing the Enter target", () => {
    expect(src).not.toMatch(/on(Mouse|Pointer)\w*=\{[^}]*setSelectedIndex/);
  });

  it("keeps a CSS-only hover tint on result rows, distinct from the keyboard-selected row's solid background, so hovering still looks interactive without moving the keyboard selection", () => {
    expect(src).toMatch(/hover:bg-raised\/50/);
  });

  it("still navigates a row on click (unaffected by the pointer/selectedIndex fix)", () => {
    expect(src).toMatch(/onClick=\{\(\) => navigate\(result\.href\)\}/);
  });

  it("keeps the ↵ badge tied only to i === selectedIndex", () => {
    expect(src).toMatch(/\{i === selectedIndex && \(/);
  });

  it("keeps ArrowUp/ArrowDown and the result-list reset as the only writers of selectedIndex", () => {
    expect(src).toMatch(/setSelectedIndex\(\(i\) => Math\.min\(i \+ 1, results\.length - 1\)\)/);
    expect(src).toMatch(/setSelectedIndex\(\(i\) => Math\.max\(i - 1, 0\)\)/);
  });
});

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

function seedStock(symbol: string, name: string): number {
  const res = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name);
  return res.lastInsertRowid as number;
}

function seedOption(underlying: string, name: string, expiry: string): number {
  const symbol = buildOCCSymbol(underlying, expiry, "PUT", 400);
  const res = hoisted.db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, underlying_symbol, strike_price, expiration_date, option_type) VALUES (?, ?, 'option', 'option', 100, ?, 400, ?, 'PUT')"
    )
    .run(symbol, name, underlying, expiry);
  return res.lastInsertRowid as number;
}

async function callTickerSearch(q: string) {
  const mod = await import("@/app/api/search/route");
  const req = new NextRequest(
    `http://test/api/search?q=${encodeURIComponent(q)}&type=security`
  );
  const res = await mod.GET(req);
  return (await res.json()) as {
    results: Array<{ type: string; id: number; title: string; subtitle: string; href: string }>;
  };
}

describe("/api/search — exact ticker ranks above its own option contracts", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    vi.resetModules();
  });

  it("ranks the exact-match stock first, ahead of an expired option on the same underlying", async () => {
    // Seed the option FIRST so a naive insertion-order or id-order query
    // would put it ahead of the stock — the fix must rank on the query
    // match itself, not incidental row order.
    seedOption("MSFT", "Put Microsoft Corp $400 EXP 06/18/26", "2026-06-18");
    seedStock("MSFT", "Microsoft Corporation");

    const body = await callTickerSearch("MSFT");
    expect(body.results.length).toBeGreaterThan(1);
    expect(body.results[0].type).toBe("security");
    expect(body.results[0].title).toBe("MSFT");
    // The option (OCC symbol starts "MSFT  260618P...") must not lead.
    expect(body.results[0].title).not.toContain("2606");
  });

  it("also ranks the exact match first when multiple option contracts on the same underlying exist", async () => {
    seedOption("AAPL", "Put Apple $400 EXP 06/18/26", "2026-06-18");
    seedStock("AAPL", "Apple Inc.");
    const body = await callTickerSearch("AAPL");
    expect(body.results[0].title).toBe("AAPL");
  });
});
