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
