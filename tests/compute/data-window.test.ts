import { describe, it, expect } from "vitest";
import { dataWindowNotice } from "@/lib/compute/data-window";

describe("dataWindowNotice", () => {
  it("returns a notice naming the actual window when the series starts materially after the requested start", () => {
    const s = dataWindowNotice("2023-07-31", "2026-04-06", "2026-07-21");
    expect(s).not.toBeNull();
    expect(s).toContain("Apr 6, 2026");
    expect(s).toContain("Jul 21, 2026");
  });

  it("returns a notice for the All period (no requested start) when a series exists", () => {
    const s = dataWindowNotice(undefined, "2026-04-06", "2026-07-21");
    expect(s).not.toBeNull();
    expect(s).toContain("Apr 6, 2026");
  });

  it("returns null when the series covers the requested start (within the 7-day grace)", () => {
    // Jan 1 is a holiday — a series starting Jan 2-3 still honestly covers YTD.
    expect(dataWindowNotice("2026-01-01", "2026-01-03", "2026-07-21")).toBeNull();
  });

  it("returns a notice when the series starts more than 7 days after the requested start", () => {
    expect(dataWindowNotice("2026-01-01", "2026-01-09", "2026-07-21")).not.toBeNull();
  });

  it("returns null when there is no series at all", () => {
    expect(dataWindowNotice("2026-01-01", null, null)).toBeNull();
  });
});
