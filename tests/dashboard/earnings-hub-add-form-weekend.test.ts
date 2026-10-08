/**
 * "+ Add ticker" asks before saving a Saturday or Sunday date
 * (qa:today-earningshub-add-ticker--weekend-date-accepted-hub-week-ahead-disagree-regression-1,
 * owner ruling 2026-08-18: warn, never block).
 *
 * No DOM harness in this repo: the question is a pure helper, and the wiring
 * is pinned against the component source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { weekendSaveWarning } from "@/app/dashboard/today/EarningsHubAddForm";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const SRC = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");

describe("weekendSaveWarning", () => {
  it("asks on a Saturday and on a Sunday, naming the day", () => {
    expect(weekendSaveWarning("2026-09-12")).toMatch(/^2026-09-12 is a Saturday\..*Save anyway\?$/);
    expect(weekendSaveWarning("2026-09-13")).toMatch(/^2026-09-13 is a Sunday\..*Save anyway\?$/);
  });

  it("is silent Monday through Friday", () => {
    for (const d of ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]) {
      expect(weekendSaveWarning(d)).toBeNull();
    }
  });

  it("is silent for a date the input has not finished forming", () => {
    expect(weekendSaveWarning("")).toBeNull();
    expect(weekendSaveWarning("2026-09")).toBeNull();
  });
});

describe("EarningsHubAddForm wiring", () => {
  it("submit asks the weekend question before any request, and returns without saving", () => {
    const submit = sliceBetween(SRC, "async function submit(", "if (!open)");
    const ask = anchorIndex(submit, "setWeekendAsk(weekend);");
    const ret = anchorIndex(submit, "return;", ask);
    const save = anchorIndex(submit, "await save(NO_ACKS);");
    expect(ret).toBeLessThan(save);
  });

  it("the confirm sends the plain add: the weekend answer is neither server acknowledgement", () => {
    const panel = sliceBetween(SRC, "{weekendAsk && (", "{slotRefusal && (");
    expect(panel).toContain("onClick={() => save(NO_ACKS)}");
    expect(panel).toContain("Save anyway");
    expect(panel).toContain("Change the date");
    expect(panel).not.toContain("force");
  });

  it("changing the ticker, date or slot withdraws the question", () => {
    const reset = sliceBetween(SRC, "function resetGuards()", "async function save(");
    expect(reset).toContain("setWeekendAsk(null);");
  });
});
