import { describe, it, expect } from "vitest";
import {
  STATEMENT_HOLDING_SOURCE_PREFIXES,
  classifyHoldingSourceKey,
} from "@/lib/db/holding-sources";

/**
 * classifyHoldingSourceKey is the shared classifier data-confidence.ts's
 * holdings-recency dimension uses to report an account's source as
 * "statement" vs "live" from its worst (oldest) holding's source_key,
 * replacing the old account-name heuristic (`name.includes("ibkr")`).
 */
describe("classifyHoldingSourceKey", () => {
  it("classifies every statement-authority prefix as statement", () => {
    for (const prefix of STATEMENT_HOLDING_SOURCE_PREFIXES) {
      expect(classifyHoldingSourceKey(`${prefix}TAX:AAPL:2026-07-31`)).toBe("statement");
    }
  });

  it("classifies live broker syncs as live", () => {
    expect(classifyHoldingSourceKey("tws-1-2-2026-08-03")).toBe("live");
    expect(classifyHoldingSourceKey("plaid:1:2:2026-08-03")).toBe("live");
  });

  it("defaults null and unrecognized prefixes to live (defensive — never silently read as statement authority)", () => {
    expect(classifyHoldingSourceKey(null)).toBe("live");
    expect(classifyHoldingSourceKey("recon:closed-equity:1:2")).toBe("live");
    expect(classifyHoldingSourceKey("demo-hold-1")).toBe("live");
    expect(classifyHoldingSourceKey("totally-unknown:whatever")).toBe("live");
  });
});
