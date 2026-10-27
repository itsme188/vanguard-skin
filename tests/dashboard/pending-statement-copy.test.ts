import { describe, it, expect } from "vitest";
import * as copy from "@/app/dashboard/components/pending-statement-copy";
import { PENDING_REASON_ORDER, type PendingReason } from "@/lib/queries/pending-statement-types";

describe("pending statement copy", () => {
  it("every reason has a chip label, a title and a line", () => {
    for (const r of PENDING_REASON_ORDER) {
      expect(copy.pendingChipLabel(r).length).toBeGreaterThan(0);
      expect(copy.pendingChipTitle(r).length).toBeGreaterThan(0);
      expect(copy.pendingLineLead(r).length).toBeGreaterThan(0);
      expect(copy.pendingLineAction(r).length).toBeGreaterThan(0);
      expect(copy.lotsWithoutPositionNote(r).length).toBeGreaterThan(0);
    }
    expect(copy.lotsWithoutPositionNote("mixed").length).toBeGreaterThan(0);
    const labels = PENDING_REASON_ORDER.map((r) => copy.pendingChipLabel(r));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("every integrity kind has a chip label and a suffix", () => {
    for (const k of Object.keys(copy.PENDING_INTEGRITY_CHIP_LABEL) as copy.PendingIntegrityKind[]) {
      expect(copy.PENDING_INTEGRITY_CHIP_LABEL[k]).toBeTruthy();
      expect(copy.PENDING_INTEGRITY_SUFFIX[k]).toBeTruthy();
    }
    expect(copy.PENDING_INTEGRITY_SUFFIX["exercise-leg-missing"]).toContain(
      "import the stock trade from the exercise or assignment, or record the option's underlying and call/put",
    );
  });

  it("long-stock strings unchanged", () => {
    expect(copy.PENDING_STATEMENT_CHIP_LABEL).toBe("pending statement");
    expect(copy.STATEMENT_LAG_LABEL).toBe("awaiting statement");
    expect(copy.pendingChipLabel("awaiting_statement")).toBe("pending statement");
    expect(copy.pendingChipTitle("awaiting_statement")).toBe(copy.PENDING_STATEMENT_TITLE);
    expect(copy.pendingLineAction("awaiting_statement")).toBe(copy.PENDING_STATEMENT_EXPLANATION);
    expect(copy.PENDING_STATEMENT_TITLE).toMatch(/^Closed per live broker data/);
    expect(copy.PENDING_STATEMENT_FILTER_ON_LABEL).toBe("Show pending only");
    expect(copy.PENDING_STATEMENT_FILTER_OFF_LABEL).toBe("Show all open lots");
    expect(copy.pendingFigureWords("cost_basis")).toBe("cost basis on long lots");
  });

  it("figure words never say cost basis for a short side", () => {
    expect(copy.pendingFigureWords("short_sale_proceeds")).not.toMatch(/cost basis/i);
    expect(copy.pendingFigureWords("short_sale_proceeds")).toMatch(/proceeds/);
  });

  it("no re-symbol sentence names a script", () => {
    const reason: PendingReason = "resymbol_repair_pending";
    const texts = [
      copy.RESYMBOL_REPAIR_PENDING_CHIP_LABEL,
      copy.RESYMBOL_REPAIR_PENDING_TITLE,
      copy.pendingChipLabel(reason),
      copy.pendingChipTitle(reason),
      copy.pendingLineLead(reason),
      copy.pendingLineAction(reason),
      copy.lotsWithoutPositionNote(reason),
      copy.PENDING_INTEGRITY_CHIP_LABEL["resymbol-repair-pending"],
      copy.PENDING_INTEGRITY_SUFFIX["resymbol-repair-pending"],
    ];
    for (const t of texts) expect(t).not.toMatch(/script|\.ts\b|npm|tsx|repair-/i);
  });

  it("uses literal em dashes, not escapes", () => {
    expect(copy.RESYMBOL_REPAIR_PENDING_CHIP_LABEL).toBe("re-symbolled — repair pending");
  });
});
