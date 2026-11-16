/**
 * Cash-Deploy card — owner rulings of 2026-11-15 (unit K1), source pins.
 *
 * K1a: the remainder the gaps cannot take is an explicit "Unallocated" line,
 * rendered through <Money>, with its one-sentence reason.
 * K1b: the gap table says its weights are net of short positions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";
import { NET_OF_SHORTS_CAPTION } from "@/lib/compute/cash-deploy";

const src = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");

describe("CashDeployCard unallocated line", () => {
  it("labels the remainder Unallocated and renders it through <Money>", () => {
    const block = src.slice(anchorIndex(src, "Unallocated:"), anchorIndex(src, "Unallocated:") + 400);
    expect(block).toContain("<Money value={result.cashRemaining} />");
    expect(src).not.toContain("Remaining:");
  });

  it("shows the reason sentence beside the amount", () => {
    const block = src.slice(anchorIndex(src, "Unallocated:"), anchorIndex(src, "Unallocated:") + 600);
    expect(block).toContain("result.unallocatedReason");
  });
});

describe("CashDeployCard net-of-shorts caption", () => {
  it("states that weights are net of short positions", () => {
    expect(NET_OF_SHORTS_CAPTION).toMatch(/net of short positions/i);
    expect(src).toContain("{NET_OF_SHORTS_CAPTION}");
    // Inside the gap-table block, before the table itself.
    expect(anchorIndex(src, "{NET_OF_SHORTS_CAPTION}")).toBeLessThan(anchorIndex(src, "<table"));
  });

  it("marks a net-short sector as such", () => {
    expect(src).toContain("g.currentWeight < 0 &&");
    expect(src).toContain("net short");
  });
});
