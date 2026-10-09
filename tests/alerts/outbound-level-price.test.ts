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
