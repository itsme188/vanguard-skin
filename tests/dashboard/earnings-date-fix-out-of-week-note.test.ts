import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// No DOM harness: source-scan pins. A Fix date into another week makes the
// row vanish after router.refresh(); the chip unmounts with it, so the notice
// must live in a surviving client component fed by a window event (the hub is
// a server component and cannot hand the chip a callback).
const read = (f: string) => readFileSync(`app/dashboard/today/${f}`, "utf8");

describe("Fix date out-of-week notice", () => {
  it("chip dispatches the corrected-date event on the submitCorrection success path", () => {
    const src = read("EarningsDateChip.tsx");
    const fn = src.slice(src.indexOf("async function submitCorrection"));
    const body = fn.slice(0, fn.indexOf("if (!dateStatus) return null"));
    const failIdx = body.indexOf("setConfirmError(body?.error");
    const dispatchIdx = body.indexOf("EARNINGS_DATE_CORRECTED_EVENT");
    expect(dispatchIdx).toBeGreaterThan(failIdx); // after the early failure return
    expect(body).toContain("detail: { date: fixDate }");
    expect(dispatchIdx).toBeLessThan(body.indexOf("router.refresh()"));
  });

  it("note component reuses outOfWeekSaveNote and renders a role=status line", () => {
    const src = read("EarningsHubDateCorrectionNote.tsx");
    expect(src).toContain("outOfWeekSaveNote(date, weekOf)");
    expect(src).toContain('role="status"');
    expect(src).toContain("text-ink-faint italic");
    expect(src).not.toContain("not the week shown here"); // no second copy of the wording
  });

  it("hub mounts the note with weekOf", () => {
    expect(read("EarningsHub.tsx")).toContain("<EarningsHubDateCorrectionNote weekOf={weekOf} />");
  });

  it("lock-chip corrected-date input carries the same min/max bounds as the conflict custom-date input", () => {
    const src = read("EarningsDateChip.tsx");
    const at = src.indexOf('aria-label="Corrected earnings date"');
    const tag = src.slice(src.lastIndexOf("<input", at), at);
    expect(tag).toContain("min={todayIso}");
    expect(tag).toContain("max={addDays(todayIso, MAX_EARNINGS_DAYS_AHEAD)}");
  });
});
