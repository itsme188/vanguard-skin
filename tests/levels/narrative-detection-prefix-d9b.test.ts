import { describe, it, expect } from "vitest";
import { detectionPrefix } from "@/lib/levels/narrative-detection-prefix";

describe("detectionPrefix (D9b)", () => {
  it("dates the narrative with the detection-time price", () => {
    expect(detectionPrefix({ day: "2026-03-02", price: 100 }, "USD")).toBe(
      "Detected 2026-03-02 at $100.00:",
    );
  });
  it("labels a non-USD price in its own currency", () => {
    const p = detectionPrefix({ day: "2026-03-02", price: 976000 }, "KRW");
    expect(p).toContain("Detected 2026-03-02 at ");
    expect(p).toContain("976,000");
    expect(p).not.toContain("$");
  });
  it("returns an empty string when the detection facts are not known", () => {
    expect(detectionPrefix({ day: null, price: 100 }, "USD")).toBe("");
    expect(detectionPrefix({ day: "2026-03-02", price: null }, "USD")).toBe("");
    expect(detectionPrefix({}, "USD")).toBe("");
  });
  it("rejects a malformed day or non-finite price", () => {
    expect(detectionPrefix({ day: "03/02/2026", price: 100 }, "USD")).toBe("");
    expect(detectionPrefix({ day: "2026-03-02", price: NaN }, "USD")).toBe("");
  });
});
