/**
 * QA finding dashboard-today-chat-rail-all-accounts-portfolio-context-chat-
 * tells-the-user-the-held-smh-and-qqq-shorts-may-n (2026-10-13): the chat
 * system context listed only long positions under a heading that called them
 * the "verified positions", so the model, seeing shorts in the market snapshot,
 * told the owner two synced short positions might not be in the book.
 *
 * The context now lists short positions in their own section and the long
 * heading says it is longs only. Synthetic tickers and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002

let db: Database.Database;

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- "));
}

beforeEach(() => {
  db = createPendingTestDb();
  const today = todayET();
  const zza = seedSec(db, "ZZA");
  const zzb = seedSec(db, "ZZB", "ETF");
  seedHold(db, IBKR, zza, today, "tws", 10);
  seedHold(db, IBKR, zzb, today, "tws", -5);
  seedPx(db, zza, today, 100);
  seedPx(db, zzb, today, 50);
});

describe("chat portfolio context lists short positions", () => {
  it("puts shorts in their own section and keeps them out of the long list", () => {
    const summary = getPortfolioSummaryForChat(db);

    const longHeading = summary.split("\n").find((l) => l.startsWith("### Current Holdings"));
    expect(longHeading).toMatch(/long positions/);
    expect(longHeading).toBeDefined();
    const longs = section(summary, longHeading!);
    expect(longs.some((l) => l.startsWith("- ZZA (IBKR)"))).toBe(true);
    expect(longs.some((l) => l.startsWith("- ZZB"))).toBe(false);

    const shorts = section(summary, "### Current Short Positions");
    expect(shorts).toHaveLength(1);
    expect(shorts[0]).toMatch(/^- ZZB \(IBKR\): short 5 shares/);
    expect(shorts[0]).toMatch(/MV:-\$250/);
  });

  it("prints no short section when nothing is held short", () => {
    db.prepare("DELETE FROM holdings WHERE quantity < 0").run();
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).not.toContain("### Current Short Positions");
    expect(summary).toContain("### Current Holdings");
  });
});
