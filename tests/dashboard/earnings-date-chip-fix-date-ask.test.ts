/**
 * The date chip's Fix date asks before leaving a second print beside a
 * confirmed vendor date (owner ruling 2026-10-20). No DOM harness: the pure
 * reply reader is tested directly and the wiring against source.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sliceBetween } from "../helpers/source-anchor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { fixDateAskFirst } from "@/app/dashboard/today/EarningsDateChip";

const CHIP = readFileSync("app/dashboard/today/EarningsDateChip.tsx", "utf8");

describe("fixDateAskFirst", () => {
  it("asks on the confirmed-date 409 with the server's sentence", () => {
    expect(
      fixDateAskFirst(409, { code: "would_contradict_confirmed_date", error: " Nothing was changed. " }),
    ).toEqual({ message: "Nothing was changed." });
  });

  it("does not ask on any other reply", () => {
    expect(fixDateAskFirst(409, { error: "Refusing: row has captured actuals" })).toBeNull();
    expect(fixDateAskFirst(409, { code: "would_supersede_vendor", error: "x" })).toBeNull();
    expect(fixDateAskFirst(200, { code: "would_contradict_confirmed_date", error: "x" })).toBeNull();
    expect(fixDateAskFirst(409, { code: "would_contradict_confirmed_date", error: "" })).toBeNull();
    expect(fixDateAskFirst(409, null)).toBeNull();
  });
});

describe("chip wiring", () => {
  const submit = sliceBetween(CHIP, "async function submitCorrection(", "if (!res.ok || !body?.success)");

  it("sends the acknowledgement only on the resend, and asks before any other handling", () => {
    expect(submit).toMatch(/\.\.\.\(forceContradictConfirmed \? \{ forceContradictConfirmed: true \} : \{\}\)/);
    expect(submit).toMatch(/if \(!forceContradictConfirmed\) \{\s*const ask = fixDateAskFirst\(res\.status, body\);/);
    // The chip never sends another route's flag to this route.
    expect(submit).not.toMatch(/\bforce: true|forceSlot/);
  });

  it("resends the date and slot that were asked about, with the flag", () => {
    expect(CHIP).toMatch(/void submitCorrection\(asked\.date, asked\.slot, true\)/);
  });

  it("asks through the app dialog, and a cancel says nothing changed", () => {
    expect(CHIP).toMatch(/open=\{fixAsk !== null\}/);
    expect(CHIP).toMatch(/onCancel=\{cancelContradictConfirmed\}/);
    expect(CHIP).toMatch(/Nothing was changed\. The confirmed vendor date stands\./);
  });

  it("Escape answers the question, not the popover underneath", () => {
    expect(CHIP).toMatch(/if \(rtAsk \|\| fixAsk\) return;/);
  });
});
