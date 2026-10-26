import { describe, it, expect } from "vitest";
import {
  reducePendingDisclosure,
  countPendingPositions,
  figureKindForSide,
  sideOf,
  PENDING_REASON_ORDER,
  type PendingDisclosureInput,
} from "@/lib/queries/pending-statement-types";

const mk = (o: Partial<PendingDisclosureInput> = {}): PendingDisclosureInput => ({
  account_id: 1, security_id: 10, is_short: 0, reason: "awaiting_statement", lotCount: 1, figure: 100, ...o,
});

describe("pending-statement-types", () => {
  it("sideOf reads 0/1, booleans and nullish", () => {
    expect(sideOf(1)).toBe("short");
    expect(sideOf(true)).toBe("short");
    expect(sideOf(0)).toBe("long");
    expect(sideOf(false)).toBe("long");
    expect(sideOf(null)).toBe("long");
    expect(sideOf(undefined)).toBe("long");
  });

  it("reducer: one row per (reason, side) present, none for an absent one", () => {
    const rows = reducePendingDisclosure([
      mk({ reason: "closing_entry_missing", is_short: 1, security_id: 11 }),
      mk(),
      mk({ reason: "resymbol_repair_pending", security_id: 12 }),
    ]);
    expect(rows.map((r) => `${r.reason}|${r.side}`)).toEqual([
      "awaiting_statement|long",
      "closing_entry_missing|short",
      "resymbol_repair_pending|long",
    ]);
    expect(rows.map((r) => r.reason)).toEqual(
      PENDING_REASON_ORDER.filter((r) => rows.some((x) => x.reason === r)),
    );
  });

  it("reducer: long sorts before short within a reason", () => {
    const rows = reducePendingDisclosure([mk({ is_short: 1, security_id: 2 }), mk()]);
    expect(rows.map((r) => r.side)).toEqual(["long", "short"]);
  });

  it("reducer: figure kind is fixed by side", () => {
    const rows = reducePendingDisclosure([mk({ is_short: 1, security_id: 2 }), mk()]);
    expect(rows[0].figureKind).toBe("cost_basis");
    expect(rows[1].figureKind).toBe("short_sale_proceeds");
    expect(figureKindForSide("long")).toBe("cost_basis");
    expect(figureKindForSide("short")).toBe("short_sale_proceeds");
  });

  it("reducer: sums conserve per (reason, side)", () => {
    const inputs = [
      mk({ lotCount: 2, figure: 150.5 }),
      mk({ security_id: 11, lotCount: 3, figure: 49.5 }),
      mk({ account_id: 2, lotCount: 1, figure: 10 }),
      mk({ is_short: 1, security_id: 12, lotCount: 4, figure: 40 }),
      mk({ reason: "closing_entry_missing", lotCount: 5, figure: 7 }),
    ];
    const rows = reducePendingDisclosure(inputs);
    for (const r of rows) {
      const sel = inputs.filter((i) => i.reason === r.reason && sideOf(i.is_short) === r.side);
      expect(r.figure).toBeCloseTo(sel.reduce((s, i) => s + i.figure, 0), 9);
      expect(r.lots).toBe(sel.reduce((s, i) => s + i.lotCount, 0));
      expect(r.positions).toBe(countPendingPositions(sel));
    }
    expect(rows.reduce((s, r) => s + r.lots, 0)).toBe(inputs.reduce((s, i) => s + i.lotCount, 0));
    const awaitingLong = rows.find((r) => r.reason === "awaiting_statement" && r.side === "long")!;
    expect(awaitingLong.positions).toBe(3);
  });

  it("reducer: no field equals a cross-side dollar sum", () => {
    const rows = reducePendingDisclosure([mk({ figure: 100 }), mk({ is_short: 1, security_id: 2, figure: 40 })]);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.figure === 140)).toBe(false);
    expect(rows.map((r) => r.figure).sort()).toEqual([40, 100]);
    expect("total" in rows[0]).toBe(false);
  });

  it("reducer: a group input and the same lots as single rows give the same list", () => {
    const grouped = reducePendingDisclosure([mk({ lotCount: 3, figure: 300 })]);
    const single = reducePendingDisclosure([mk({ figure: 100 }), mk({ figure: 100 }), mk({ figure: 100 })]);
    expect(single).toEqual(grouped);
  });

  it("countPendingPositions counts long and short of one symbol as two", () => {
    expect(countPendingPositions([mk(), mk({ is_short: 1 }), mk()])).toBe(2);
  });

  it("empty input gives []", () => {
    expect(reducePendingDisclosure([])).toEqual([]);
    expect(countPendingPositions([])).toBe(0);
  });
});
