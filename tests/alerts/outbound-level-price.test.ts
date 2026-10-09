/**
 * Outbound level-price label (emails and pushes).
 *
 * A level price is native currency: labelled, never converted (ruling
 * 2026-10-07). The app labels with formatLevelPrice, which uses the runtime's
 * DEFAULT locale; outbound text is composed by two runtimes (the Mac's Node
 * and the Cloudflare Worker), so the outbound formatter pins "en-US" and the
 * Worker carries a hand mirror. This file feeds one fixture set through both
 * and expects the same strings.
 */
import { describe, it, expect } from "vitest";
import { formatOutboundLevelPrice } from "@/lib/alerts/outbound-level-price";
import { formatOutboundLevelPrice as workerFormat } from "../../workers/cron/src/level-price";
import fixture from "../fixtures/level-price-parity.json";

describe("formatOutboundLevelPrice", () => {
  for (const c of fixture.cases) {
    const label = `${JSON.stringify(c.currency)} ${c.value}`;
    it(`${label}: Mac output matches the fixture`, () => {
      expect(formatOutboundLevelPrice(c.currency, c.value)).toBe(c.plain);
      expect(formatOutboundLevelPrice(c.currency, c.value, "plain")).toBe(c.plain);
      expect(formatOutboundLevelPrice(c.currency, c.value, "grouped")).toBe(c.grouped);
    });
    it(`${label}: the Worker mirror returns the identical string`, () => {
      expect(workerFormat(c.currency, c.value, "plain")).toBe(
        formatOutboundLevelPrice(c.currency, c.value, "plain"),
      );
      expect(workerFormat(c.currency, c.value, "grouped")).toBe(
        formatOutboundLevelPrice(c.currency, c.value, "grouped"),
      );
    });
  }

  for (const c of fixture.nonFinite) {
    const value = Number(c.value);
    it(`${JSON.stringify(c.currency)} ${c.value}: a non-finite price prints "n/a", never a currency sign`, () => {
      expect(Number.isFinite(value)).toBe(false);
      expect(formatOutboundLevelPrice(c.currency, value)).toBe(c.expected);
      expect(formatOutboundLevelPrice(c.currency, value, "grouped")).toBe(c.expected);
      expect(workerFormat(c.currency, value, "plain")).toBe(c.expected);
      expect(workerFormat(c.currency, value, "grouped")).toBe(c.expected);
    });
  }

  it("negatives, sub-cent values and the pence code are left exactly as they were", () => {
    expect(formatOutboundLevelPrice("USD", -5)).toBe("$-5.00");
    expect(formatOutboundLevelPrice("USD", -1234.5, "grouped")).toBe("$-1,234.50");
    expect(formatOutboundLevelPrice("USD", 0.004)).toBe("$0.00");
    expect(formatOutboundLevelPrice("GBp", 1250)).toBe("£1,250.00");
    for (const args of [["USD", -5], ["USD", 0.004], ["GBp", 1250], ["GBP", -12.5]] as const) {
      expect(workerFormat(args[0], args[1])).toBe(formatOutboundLevelPrice(args[0], args[1]));
    }
  });

  it("the two mirrors' formatter bodies are byte-identical", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const body = (path: string) => {
      const text = readFileSync(resolve(__dirname, path), "utf8");
      const start = text.indexOf("export type OutboundUsdStyle");
      expect(start).toBeGreaterThan(-1);
      return text.slice(start);
    };
    expect(body("../../workers/cron/src/level-price.ts")).toBe(body("../../lib/alerts/outbound-level-price.ts"));
  });

  it("undefined currency reads as USD", () => {
    expect(formatOutboundLevelPrice(undefined, 91.32, "grouped")).toBe("$91.32");
  });

  it("never converts: the digits of a yen level are the level's own digits", () => {
    expect(formatOutboundLevelPrice("JPY", 976000).replace(/[^0-9]/g, "")).toBe("976000");
  });

  it("carries no non-breaking space (one runtime may emit it, another not)", () => {
    for (const c of fixture.cases) {
      const out = formatOutboundLevelPrice(c.currency, c.value);
      expect(out.includes(String.fromCharCode(0xa0))).toBe(false);
      expect(out.includes(String.fromCharCode(0x202f))).toBe(false);
    }
  });
});
