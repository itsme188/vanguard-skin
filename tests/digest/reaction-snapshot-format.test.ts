import { describe, it, expect } from "vitest";
import { formatReactionSnapshot } from "../../lib/digest/send-earnings-email";

describe("formatReactionSnapshot", () => {
  it("renders delta_pct as-is (values are already percent), never ×100", () => {
    const json = JSON.stringify({
      t0_utc: "2026-07-22T20:15:00Z",
      window_min: 120,
      source: "yahoo",
      symbol: { symbol: "TER", delta_pct: 4.12 },
      spy: { delta_pct: 0.41 },
      qqq: { delta_pct: -0.28 },
    });
    const out = formatReactionSnapshot(json);
    expect(out).not.toBeNull();
    expect(out).toContain("TER: +4.12%");
    expect(out).toContain("SPY: +0.41%");
    expect(out).toContain("QQQ: -0.28%");
    expect(out).not.toContain("41.00%");
  });

  it("returns null for malformed json", () => {
    expect(formatReactionSnapshot("not json")).toBeNull();
    expect(formatReactionSnapshot(null)).toBeNull();
  });
});
