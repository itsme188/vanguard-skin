import { describe, it, expect } from "vitest";
import { GATE_VERSION, gateFingerprint, contentVerdict, roadVerdict, validateDocForEvent } from "@/lib/print-watch/gate";
import { validateDocForEvent as reExported } from "@/lib/print-watch/watcher";

const CTX = { symbol: "ACME", issuerName: "Acme Corp", eventDate: "2026-08-26" };
// Last quarter's fiscal labels: passes the loose (fiscal-year) branch, fails the strict ir-page branch.
const LAST_QUARTER = "ACME reports first quarter fiscal 2027 results. Revenue was $1.0 billion.";
const THIS_QUARTER = "ACME reports Q2 2026 results. Revenue was $1.0 billion.";

describe("gate module", () => {
  it("re-exports validateDocForEvent from the watcher unchanged", () => {
    expect(reExported).toBe(validateDocForEvent);
  });

  it("fingerprint is stable for equal identity and changes with symbol, issuer, date, or version", () => {
    const a = gateFingerprint(CTX);
    expect(gateFingerprint({ ...CTX })).toBe(a);
    expect(gateFingerprint({ ...CTX, symbol: "acme" })).toBe(a); // case-insensitive symbol
    expect(gateFingerprint({ ...CTX, issuerName: null })).not.toBe(a);
    expect(gateFingerprint({ ...CTX, eventDate: "2026-11-18" })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(GATE_VERSION).toBe(2);
  });

  it("contentVerdict uses the loose branch regardless of the road", () => {
    expect(contentVerdict(LAST_QUARTER, { ...CTX, kind: "ir-page" }).ok).toBe(true);
    expect(contentVerdict("Some other company. Q2 2026.", CTX).ok).toBe(false);
  });

  it("roadVerdict is strict for ir-page and permissive for every other road", () => {
    expect(roadVerdict("ir-page", LAST_QUARTER, CTX).ok).toBe(false);
    expect(roadVerdict("ir-page", THIS_QUARTER, CTX).ok).toBe(true);
    for (const kind of ["dj-release", "edgar-ex99", "user-drop", "user-url"] as const) {
      expect(roadVerdict(kind, LAST_QUARTER, CTX)).toEqual({ ok: true });
    }
  });
});

describe("two-digit-year quarter tokens (Netflix style)", () => {
  const NFLX = { symbol: "NFLX", issuerName: "Netflix, Inc.", eventDate: "2026-10-20" };
  const header = "Q3'25 Q4'25 Q1'26 Q2'26 Q3'26 Q4'26 Forecast";
  const only25 = "Netflix reports results. Q3'25 revenue was $1.0 billion. fiscal quarter and fiscal year ending December 31, 2026.";

  it("accepts Q3'26 with an ASCII apostrophe", () => {
    const doc = `Netflix\n${header}\nQ3'26 operating income totaled $4.5B`;
    expect(validateDocForEvent(doc, NFLX).ok).toBe(true);
    expect(validateDocForEvent(doc, { ...NFLX, kind: "ir-page" }).ok).toBe(true);
  });

  it("accepts Q3\u201926 with a right single quote", () => {
    expect(validateDocForEvent("Netflix: Q3\u201926 operating income totaled $4.5B", NFLX).ok).toBe(true);
    expect(validateDocForEvent("Netflix: Q3 \u201826 results", NFLX).ok).toBe(true);
  });

  it("accepts 3Q26 and 3Q'26", () => {
    expect(validateDocForEvent("Netflix 3Q26 results", NFLX).ok).toBe(true);
    expect(validateDocForEvent("Netflix 3Q'26 results", NFLX).ok).toBe(true);
  });

  it("does not accept Q3'25 alone (prior-year comparative)", () => {
    expect(validateDocForEvent(only25, { ...NFLX, kind: "ir-page" })).toEqual({
      ok: false,
      reason: "IR page does not name this event's quarter (an older newsroom post?)",
    });
    expect(validateDocForEvent("Netflix Q3'25 3Q25 only", NFLX).ok).toBe(false);
  });

  it("does not match Q3'261 or 3Q261 (word boundary)", () => {
    expect(validateDocForEvent("Netflix Q3'261 results", NFLX).ok).toBe(false);
    expect(validateDocForEvent("Netflix 3Q261 results", NFLX).ok).toBe(false);
    expect(validateDocForEvent("Netflix XQ3'26 results", NFLX).ok).toBe(false);
  });
});
