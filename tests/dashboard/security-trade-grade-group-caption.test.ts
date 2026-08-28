/**
 * Security Detail — AI Trade Grades group caption.
 *
 * QA finding security-detail-trade-grades--identical-assessment-across-trades:
 * one AI verdict is copied onto every roundtrip closing the same day, so
 * getTradeGradesBySecurity folds those legs into one card. The card must say
 * so — otherwise the grade still reads as a verdict on a single leg.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tradeGradeGroupCaption } from "@/app/dashboard/security/[id]/trade-grade-group";

describe("tradeGradeGroupCaption", () => {
  it("is silent for a card covering a single roundtrip", () => {
    expect(tradeGradeGroupCaption(1, "2026-05-31")).toBeNull();
    expect(tradeGradeGroupCaption(0, "2026-05-31")).toBeNull();
  });

  it("names the leg count and the shared exit date when grouped", () => {
    const caption = tradeGradeGroupCaption(3, "2026-05-31");
    expect(caption).toBe(
      "Covers 3 roundtrips closed 2026-05-31 — one assessment for the group"
    );
  });
});

describe("Security Detail renders the caption", () => {
  const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");

  it("imports the helper and gates the caption on the grouped card", () => {
    expect(src).toContain("tradeGradeGroupCaption");
    expect(src).toMatch(/tradeGradeGroupCaption\(\s*tg\.coversRoundtrips\s*,\s*tg\.exit_date\s*\)/);
  });

  it("still renders portfolio money and returns through the privacy components", () => {
    expect(src).toMatch(/<Money value=\{tg\.realized_pnl\} \/>/);
    expect(src).toMatch(/<Pct value=\{tg\.return_pct\}/);
  });
});
