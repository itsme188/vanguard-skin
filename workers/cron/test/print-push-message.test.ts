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
    expect(out.message).toBe("EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M");
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
      "EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M · TER +4.12% vs SPY +0.41% (T+2h)",
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
});
