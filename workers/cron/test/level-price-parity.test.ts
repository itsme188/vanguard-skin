/**
 * Parity pin: the Worker's hand mirror of the outbound level-price label
 * (src/level-price.ts) against the Mac's lib/alerts/outbound-level-price.ts,
 * over the shared fixture set. Change both files together.
 */
import { describe, it, expect } from "vitest";
import { formatOutboundLevelPrice as workerFormat } from "../src/level-price";
import { formatOutboundLevelPrice as macFormat } from "@/lib/alerts/outbound-level-price";
import fixture from "@/tests/fixtures/level-price-parity.json";

describe("outbound level price: Worker mirror == Mac == fixture", () => {
  for (const c of fixture.cases) {
    it(`${JSON.stringify(c.currency)} ${c.value}`, () => {
      expect(workerFormat(c.currency, c.value, "plain")).toBe(c.plain);
      expect(workerFormat(c.currency, c.value, "grouped")).toBe(c.grouped);
      expect(workerFormat(c.currency, c.value)).toBe(macFormat(c.currency, c.value));
      expect(workerFormat(c.currency, c.value, "grouped")).toBe(
        macFormat(c.currency, c.value, "grouped"),
      );
    });
  }
});
