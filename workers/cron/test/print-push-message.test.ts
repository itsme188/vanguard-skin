/**
 * Parity tests for workers/cron/src/print-push-message.ts — a byte-for-byte
 * hand copy of lib/alerts/print-push-message.ts (the Worker can't cross the
 * Next.js path-alias boundary, same constraint as the issuerSiblings /
 * presence-position mirrors).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { composePrintPushMessage } from "../src/print-push-message";

describe("print-push-message parity (Worker mirror of lib/alerts/print-push-message.ts)", () => {
  it("is byte-identical to the Mac composer below the header", () => {
    const mac = readFileSync(
      new URL("../../../lib/alerts/print-push-message.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(new URL("../src/print-push-message.ts", import.meta.url), "utf8");
    const strip = (s: string) => s.slice(s.indexOf("interface ParsedFigure"));
    expect(strip(wkr)).toBe(strip(mac));
  });

  // Behavior cases mirrored from tests/alerts/print-push-message.test.ts —
  // proves the Worker copy behaves identically to the Mac original.
  it("renders EPS + Rev actual vs consensus with compact revenue", () => {
    const out = composePrintPushMessage({
      symbol: "TER",
      actualValue: "EPS 1.42 · Rev 775,200,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: null,
    });
    expect(out.title).toBe("TER reported");
    expect(out.message).toBe("EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M (+1.7%)");
  });

  it("appends the reaction when present", () => {
    const out = composePrintPushMessage({
      symbol: "TER",
      actualValue: "EPS 1.42 · Rev 775,200,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: JSON.stringify({
        source: "yahoo",
        window_min: 120,
        symbol: { symbol: "TER", delta_pct: 4.12 },
        spy: { delta_pct: 0.41 },
      }),
    });
    expect(out.message).toBe(
      "EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M (+1.7%) · TER +4.12% vs SPY +0.41% (T+2h)",
    );
  });

  it("preserves negative EPS signs (miss vs positive consensus)", () => {
    const out = composePrintPushMessage({
      symbol: "U",
      actualValue: "EPS -0.24",
      consensusValue: "EPS 0.10",
      reactionJson: null,
    });
    expect(out.message).toBe("EPS -0.24 vs 0.10 est");
  });

  // ── Revenue-pair precision fix (2026-08-28, CRWD 1dp-collapse bug) ───────

  it("CRWD regression: fixed 1dp collapse erased the beat — now distinguishes at 3dp with a surprise%", () => {
    const out = composePrintPushMessage({
      symbol: "CRWD",
      actualValue: "Rev 1,470,900,000",
      consensusValue: "Rev 1,468,800,000",
      reactionJson: null,
    });
    expect(out.message).toBe("Rev 1.471B vs 1.469B (+0.1%)");
  });

  it("1dp already distinguishes the pair → stays at 1dp", () => {
    const out = composePrintPushMessage({
      symbol: "MEGA",
      actualValue: "Rev 46,500,000,000",
      consensusValue: "Rev 46,000,000,000",
      reactionJson: null,
    });
    expect(out.message).toBe("Rev 46.5B vs 46.0B (+1.1%)");
  });

  it("cross-scale pair: larger value's magnitude sets the shared scale for both", () => {
    const out = composePrintPushMessage({
      symbol: "XYZ",
      actualValue: "Rev 1,020,000,000",
      consensusValue: "Rev 995,000,000",
      reactionJson: null,
    });
    expect(out.message).toBe("Rev 1.02B vs 0.99B (+2.5%)");
  });

  it("negative surprise (actual below consensus)", () => {
    const out = composePrintPushMessage({
      symbol: "MISS",
      actualValue: "Rev 90,000,000",
      consensusValue: "Rev 100,000,000",
      reactionJson: null,
    });
    expect(out.message).toBe("Rev 90.0M vs 100.0M (-10.0%)");
  });

  it("consensus of 0 → no surprise fragment, and never Infinity/NaN in the message", () => {
    const out = composePrintPushMessage({
      symbol: "ZERO",
      actualValue: "Rev 100,000",
      consensusValue: "Rev 0",
      reactionJson: null,
    });
    expect(out.message).toBe("Rev 100.0K vs 0.0K");
    expect(out.message).not.toContain("Infinity");
    expect(out.message).not.toContain("NaN");
  });

  it("genuinely equal values render equal strings with a +0.0% surprise", () => {
    const out = composePrintPushMessage({
      symbol: "FLAT",
      actualValue: "Rev 500,000,000",
      consensusValue: "Rev 500,000,000",
      reactionJson: null,
    });
    expect(out.message).toBe("Rev 500.000M vs 500.000M (+0.0%)");
  });
});
