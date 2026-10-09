import { describe, it, expect } from "vitest";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { transactionDisplayType, transactionDirectionLabel } from "@/lib/transactions/direction-label";

const note = (code: string) => ibkrTradeDirectionNote(code, "2026-01-02, 10:00:00");

describe("transactionDisplayType", () => {
  it("reads an opening sale stored as SELL_TO_CLOSE as SELL_TO_OPEN", () => {
    expect(transactionDisplayType("SELL_TO_CLOSE", note("O"))).toBe("SELL_TO_OPEN");
    expect(transactionDisplayType("SELL", note("O"))).toBe("SELL_TO_OPEN");
  });
  it("reads a closing buy as BUY_TO_CLOSE", () => {
    expect(transactionDisplayType("BUY", note("C"))).toBe("BUY_TO_CLOSE");
    expect(transactionDisplayType("BUY_TO_OPEN", note("C"))).toBe("BUY_TO_CLOSE");
  });
  it("is case-insensitive on the stored type", () => {
    expect(transactionDisplayType("sell_to_close", note("O"))).toBe("SELL_TO_OPEN");
  });
  it("keeps the stored type with no evidence", () => {
    expect(transactionDisplayType("SELL_TO_CLOSE", null)).toBe("SELL_TO_CLOSE");
    expect(transactionDisplayType("SELL_TO_CLOSE", "plain note")).toBe("SELL_TO_CLOSE");
    expect(transactionDisplayType("SELL", undefined)).toBe("SELL");
  });
  it("keeps the stored type when the evidence agrees or is mixed", () => {
    expect(transactionDisplayType("SELL_TO_CLOSE", note("C"))).toBe("SELL_TO_CLOSE");
    expect(transactionDisplayType("BUY", note("O"))).toBe("BUY");
    expect(transactionDisplayType("SELL", note("O;C"))).toBe("SELL");
  });
  it("never touches non-trade types", () => {
    expect(transactionDisplayType("DIVIDEND", note("O"))).toBe("DIVIDEND");
    expect(transactionDisplayType("EXPIRED", note("C"))).toBe("EXPIRED");
  });
  it("label is sentence-cased", () => {
    expect(transactionDirectionLabel("SELL_TO_CLOSE", note("O"))).toBe("Sell to open");
  });
});
