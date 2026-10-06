/**
 * Privacy-safe quantity noun + Cmd+K note subtitle masking (source pins; no DOM
 * harness in this repo).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { quantityUnitLabel } from "@/lib/format/quantity-unit";

describe("quantityUnitLabel privacy argument", () => {
  it("keeps singular/plural when not private", () => {
    expect(quantityUnitLabel("Stock", 1)).toBe("share");
    expect(quantityUnitLabel("Option", -1)).toBe("contract");
  });
  it("returns the neutral plural when private", () => {
    expect(quantityUnitLabel("Stock", 1, true)).toBe("shares");
    expect(quantityUnitLabel("Option", 1, true)).toBe("contracts");
    expect(quantityUnitLabel("Bond", 1, true)).toBe("face value");
  });
});

describe("source pins", () => {
  it("QuantityUnit component reads the privacy context", () => {
    const src = readFileSync("lib/privacy/components.tsx", "utf8");
    expect(src).toMatch(/export function QuantityUnit/);
    expect(src).toMatch(/quantityUnitLabel\(securityType, quantity, isPrivate\)/);
  });
  it("security hub lot-coverage line uses QuantityUnit, not a hardcoded 'shares' noun", () => {
    const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
    expect(src).toMatch(/<QuantityUnit/);
    expect(src).not.toMatch(/\/> shares/);
    expect(src).not.toMatch(/\/> more shares/);
  });
  it("CommandPalette renders non-security subtitles through PrivateText", () => {
    const src = readFileSync("app/dashboard/components/CommandPalette.tsx", "utf8");
    expect(src).toMatch(/<PrivateText>\{result\.subtitle\}<\/PrivateText>/);
  });
});
