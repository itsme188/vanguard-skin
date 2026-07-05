import { describe, it, expect } from "vitest";
import { composePrintPushMessage } from "../../lib/alerts/print-push-message";

describe("composePrintPushMessage", () => {
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

  it("omits missing halves (EPS-only actual, no consensus)", () => {
    const out = composePrintPushMessage({
      symbol: "U", actualValue: "EPS 0.23", consensusValue: null, reactionJson: null,
    });
    expect(out.message).toBe("EPS 0.23");
  });

  it("appends the reaction when present", () => {
    const out = composePrintPushMessage({
      symbol: "TER",
      actualValue: "EPS 1.42 · Rev 775,200,000",
      consensusValue: "EPS 1.35 · Rev 762,000,000",
      reactionJson: JSON.stringify({
        source: "yahoo", window_min: 120,
        symbol: { symbol: "TER", delta_pct: 4.12 },
        spy: { delta_pct: 0.41 },
      }),
    });
    expect(out.message).toBe(
      "EPS 1.42 vs 1.35 est · Rev 775.2M vs 762.0M · TER +4.12% vs SPY +0.41% (T+2h)",
    );
  });

  it("billion-scale revenue renders as B", () => {
    const out = composePrintPushMessage({
      symbol: "AAPL", actualValue: "Rev 94,300,000,000", consensusValue: "Rev 93,100,000,000", reactionJson: null,
    });
    expect(out.message).toBe("Rev 94.3B vs 93.1B");
  });

  it("malformed reaction json is ignored gracefully", () => {
    const out = composePrintPushMessage({
      symbol: "TER",
      actualValue: "EPS 1.42",
      consensusValue: null,
      reactionJson: "{not valid json",
    });
    expect(out.message).toBe("EPS 1.42");
  });
});
