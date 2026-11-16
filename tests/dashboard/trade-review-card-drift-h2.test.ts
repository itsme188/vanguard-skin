/**
 * Trade Reviews card, unit H2 (Analysis tab fix wave 2026-11-15).
 *
 *  H2a  the client sends each answer with its question's trade key.
 *  H2d  the collapsed card warns when the period's realized P&L has moved
 *       materially or changed sign since the review was written, and shows
 *       the stale-pairings state; the saved figures and prose are kept.
 *  H2e  the card says how many of the month's closes the review leaves out.
 *
 * Source-scanned plus pure helpers: this repo has no DOM test harness.
 * All figures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildTradeReviewAnswers,
  reviewLeftOut,
  savedReviewPnlDrift,
} from "@/app/dashboard/components/TradeReviewView";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/TradeReviewView.tsx", "utf8");
const card = sliceBetween(src, "function ReviewCard({", "// ─── Review Detail");

describe("answers carry their trade key", () => {
  it("each non-blank answer is sent with its question's closing transaction id", () => {
    const questions = [
      { tradeNumber: 1, symbol: "ZZA", question: "q1", saleTransactionId: 11 },
      { tradeNumber: 2, symbol: "ZZB", question: "q2", saleTransactionId: 22 },
      { tradeNumber: 3, symbol: "ZZC", question: "q3" },
    ];
    expect(buildTradeReviewAnswers(questions, { 1: "  ", 2: " planned ", 3: "old" })).toEqual([
      { tradeNumber: 2, answer: "planned", saleTransactionId: 22 },
      { tradeNumber: 3, answer: "old" },
    ]);
  });

  it("the submit handler uses it, and sends an empty list rather than falling back to phase 1", () => {
    const handler = sliceBetween(src, "const handleSubmitAnswers", "const handleSkipQuestions");
    expect(handler).toContain("buildTradeReviewAnswers(questions, questionAnswers)");
    expect(handler).not.toContain("answers.length > 0 ? answers : undefined");
  });
});

describe("realized P&L drift on a saved review", () => {
  it("no current figure, or a move under the floor, is no drift", () => {
    expect(savedReviewPnlDrift(1000, undefined)).toBeNull();
    expect(savedReviewPnlDrift(1000, { totalRealizedPnl: 1005 })).toBeNull(); // 0.5% < 1%
    expect(savedReviewPnlDrift(50, { totalRealizedPnl: 50.4 })).toBeNull(); // under $1
  });

  it("a material move is drift, sign kept", () => {
    expect(savedReviewPnlDrift(1000, { totalRealizedPnl: 800 })).toEqual({ currentPnl: 800, signFlipped: false });
  });

  it("a change of sign is always reported as such", () => {
    expect(savedReviewPnlDrift(1000, { totalRealizedPnl: -200 })).toEqual({ currentPnl: -200, signFlipped: true });
    expect(savedReviewPnlDrift(-0.6, { totalRealizedPnl: 0.6 })).toEqual({ currentPnl: 0.6, signFlipped: true });
  });

  it("the card renders both figures through <Money> and keeps the saved one", () => {
    const warn = card.slice(anchorIndex(card, "{pnlDrift != null && ("));
    expect(warn).toContain("<Money value={review.total_realized_pnl} signed />");
    expect(warn).toContain("<Money value={pnlDrift.currentPnl} signed />");
    expect(warn).toMatch(/changed sign/);
    expect(card).toContain("savedReviewPnlDrift(review.total_realized_pnl, review.current)");
  });

  it("the collapsed card shows the stale-pairings state", () => {
    const stale = card.slice(anchorIndex(card, "{review.pairingsStale && ("));
    expect(stale.slice(0, 400)).toMatch(/outdated or unresolved/);
  });

  it("the count drift prefers today's count read with the review", () => {
    expect(src).toContain("savedReviewRoundTripDrift(review.total_trades, review.current)");
  });
});

describe("what a review leaves out", () => {
  it("nothing left out is no line", () => {
    expect(reviewLeftOut(undefined)).toBeNull();
    expect(
      reviewLeftOut({ reviewableCount: 3, userCloseCount: 3, lowCoverageCount: 0, syntheticCount: 0, totalRealizedPnl: 0 })
    ).toBeNull();
  });

  it("counts low-coverage and engine closes", () => {
    expect(
      reviewLeftOut({ reviewableCount: 3, userCloseCount: 5, lowCoverageCount: 2, syntheticCount: 1, totalRealizedPnl: 0 })
    ).toEqual({ lowCoverage: 2, synthetic: 1, userCloses: 5 });
  });

  it("the card renders the counts through <Count> and no dollar figure", () => {
    const line = sliceBetween(card, "{leftOut != null && (", "</button>");
    expect(line).toContain("<Count value={leftOut.lowCoverage} />");
    expect(line).toContain("<Count value={leftOut.userCloses} />");
    expect(line).toContain("<Count value={leftOut.synthetic} />");
    expect(line).not.toContain("<Money");
  });
});
