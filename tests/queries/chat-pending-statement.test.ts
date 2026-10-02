/**
 * Chat surfaces vs the pending-statement read model (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2 "Chat"): pending lots are reported as pending — never as unrealized
 * holdings, harvesting candidates or lots approaching long-term — and
 * realized totals include only persisted closes. Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxLotsForChat } from "@/lib/queries/chat-tools";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { todayET } from "@/lib/calendar/date-utils";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedPx,
} from "../setup/pending-statement-fixtures";

let db: Database.Database;

/** A date N days before today, so the approaching-LT window is wall-clock safe. */
function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  db = createPendingTestDb();
  // Acquired ~11 months ago so both lots sit inside the 60-day
  // approaching-long-term window; both carry a large paper loss so both
  // would be harvest candidates if held.
  const acq = daysAgo(340);
  const held = seedSec(db, "HLDC");
  seedFill(db, 3, held, acq, "BUY", 10, 100);
  seedHold(db, 3, held, daysAgo(2), "stmt", 10);
  seedPx(db, held, daysAgo(2), 50);

  const pend = seedSec(db, "PNDC");
  seedFill(db, 3, pend, acq, "BUY", 10, 100);
  seedHold(db, 3, pend, daysAgo(2), "live-zero");
  seedPx(db, pend, daysAgo(2), 50);

  computeTaxLots(db);
});

describe("getTaxLotsForChat (open)", () => {
  it("marks pending lots as pending, with no unrealized gain or market value", () => {
    const rows = getTaxLotsForChat(db, { status: "open" });
    const pend = rows.find((r) => r.symbol === "PNDC")!;
    expect(pend.pending_statement).toBe(true);
    expect(pend.unrealized_gain).toBeNull();
    expect(pend.current_value).toBeNull();
    expect(pend.status_note).toMatch(/closed per live broker data/i);
    expect(pend.status_note).toMatch(/awaiting the broker statement/i);
    expect(pend.status_note).toMatch(/not an unrealized holding/i);

    const held = rows.find((r) => r.symbol === "HLDC")!;
    expect(held.pending_statement).toBe(false);
    expect(held.status_note).toBeUndefined();
    expect(held.unrealized_gain).toBeCloseTo(-500, 6);
  });

  it("does not leak internal join keys into the tool result", () => {
    const row = getTaxLotsForChat(db, { status: "open" })[0] as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty("account_id");
    expect(row).not.toHaveProperty("security_id");
    expect(row).not.toHaveProperty("is_short");
  });

  it("closed lots: no synthetic close was minted for the live-only flat", () => {
    const closed = getTaxLotsForChat(db, { status: "closed" });
    expect(closed).toEqual([]);
  });
});

describe("getPortfolioSummaryForChat", () => {
  it("counts only held lots as open and discloses the pending positions separately", () => {
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("- Open lots: 1 ");
    expect(summary).toMatch(
      /Positions closed per live data, awaiting broker statement: 1 \(1 lot, cost basis: [^)]*\) — not counted as open holdings or unrealized/
    );
  });

  it("never lists a pending lot as a harvesting candidate or as approaching long-term", () => {
    const summary = getPortfolioSummaryForChat(db);
    const harvest = summary.split("### Tax-Loss Harvesting Candidates")[1]?.split("\n###")[0] ?? "";
    expect(harvest).toContain("HLDC");
    expect(harvest).not.toContain("PNDC");
    const lt = summary.split("### Lots Approaching Long-Term Status")[1]?.split("\n###")[0] ?? "";
    expect(lt).toContain("HLDC");
    expect(lt).not.toContain("PNDC");
  });

  it("account scope: the pending line only counts the scoped account", () => {
    expect(getPortfolioSummaryForChat(db, "Vanguard Taxable")).not.toContain("awaiting broker statement");
    expect(getPortfolioSummaryForChat(db, "IBKR")).toContain("awaiting broker statement: 1");
  });
});

describe("query_tax_lots tool description (source pin)", () => {
  it("tells the model to describe pending_statement lots as pending, never as unrealized holdings", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/chat/tools.ts", "utf8");
    const desc = src.match(/name: "query_tax_lots",\s*description:\s*"([^"]+)"/)?.[1] ?? "";
    expect(desc).not.toBe("");
    expect(desc).toContain("pending_statement=true");
    expect(desc).toMatch(/describe it as pending/);
    expect(desc).toMatch(/never as an unrealized holding or a harvesting candidate/);
  });
});
