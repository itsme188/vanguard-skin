import { describe, it, expect } from "vitest";
import { computeSnapshotAgeMeta } from "@/app/dashboard/components/SnapshotAge";

const now = new Date("2026-05-11T15:30:00");

describe("computeSnapshotAgeMeta", () => {
  it("returns 'today' label and ink-faint tone for a same-day snapshot", () => {
    const meta = computeSnapshotAgeMeta("2026-05-11", now);
    expect(meta.ageDays).toBe(0);
    expect(meta.ageLabel).toBe("today");
    expect(meta.tone).toBe("ink-faint");
    expect(meta.glyph).toBe("");
  });

  it("returns '1d ago' for a one-day-old snapshot", () => {
    expect(computeSnapshotAgeMeta("2026-05-10", now).ageLabel).toBe("1d ago");
  });

  it("stays ink-faint at the 7-day boundary (statement just landed, expected)", () => {
    const meta = computeSnapshotAgeMeta("2026-05-04", now);
    expect(meta.ageDays).toBe(7);
    expect(meta.tone).toBe("ink-faint");
  });

  it("escalates to ink-dim at 8d (mid-cycle, structurally normal)", () => {
    const meta = computeSnapshotAgeMeta("2026-05-03", now);
    expect(meta.ageDays).toBe(8);
    expect(meta.tone).toBe("ink-dim");
    expect(meta.glyph).toBe("");
  });

  it("stays ink-dim through the 21-day envelope (Vanguard's normal statement cadence)", () => {
    const meta = computeSnapshotAgeMeta("2026-04-20", now);
    expect(meta.ageDays).toBe(21);
    expect(meta.tone).toBe("ink-dim");
  });

  it("escalates to warn + glyph at 22d (full statement cycle missed)", () => {
    const meta = computeSnapshotAgeMeta("2026-04-19", now);
    expect(meta.ageDays).toBe(22);
    expect(meta.tone).toBe("warn");
    expect(meta.glyph).toBe("⚠ ");
  });

  it("treats future asOfDate as 0d (defensive — clock skew shouldn't render a negative age)", () => {
    const meta = computeSnapshotAgeMeta("2026-05-15", now);
    expect(meta.ageDays).toBe(0);
    expect(meta.ageLabel).toBe("today");
  });

  it("ignores the time component of asOfDate (date-only comparison)", () => {
    const meta = computeSnapshotAgeMeta("2026-05-04T23:59:59", now);
    expect(meta.ageDays).toBe(7);
  });
});
