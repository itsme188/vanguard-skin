import { describe, it, expect } from "vitest";
import { planVerification, formatPlan, MAPPING } from "../../scripts/lib/verify-mapping";

describe("planVerification", () => {
  it("maps compute changes to tests/compute/", () => {
    const plan = planVerification(["lib/compute/risk.ts"]);
    expect(plan.selectedTests).toContain("tests/compute/");
    expect(plan.unmatched).toEqual([]);
  });

  it("maps queries and mutations changes to their test dirs", () => {
    const plan = planVerification(["lib/queries/holdings.ts", "lib/mutations/calendar.ts"]);
    expect(plan.selectedTests).toContain("tests/queries/");
    expect(plan.selectedTests).toContain("tests/mutations/");
  });

  it("maps lib/format.ts to the format test file", () => {
    const plan = planVerification(["lib/format.ts"]);
    expect(plan.selectedTests).toContain("tests/lib/format.test.ts");
  });

  it("maps import and import-API changes to tests/import/", () => {
    const plan = planVerification(["lib/import/parsers/vanguard-holdings.ts", "app/api/import/route.ts"]);
    expect(plan.selectedTests).toContain("tests/import/");
  });

  it("maps generic API changes to api/auth test dirs with a route-policy reminder", () => {
    const plan = planVerification(["app/api/levels/route.ts"]);
    expect(plan.selectedTests).toEqual(
      expect.arrayContaining(["tests/api/", "tests/apis/", "tests/http/", "tests/auth/"])
    );
    expect(plan.reminders.join(" ")).toContain("proxy.ts route policy");
  });

  it("flags browser verification for dashboard UI changes", () => {
    const plan = planVerification(["app/dashboard/components/LevelsPanel.tsx"]);
    expect(plan.selectedTests).toContain("tests/dashboard/");
    expect(plan.reminders.join(" ")).toContain("Browser verification required");
  });

  it("maps worker changes to BOTH tests/cron/ and tests/workers/ with the parity reminder", () => {
    const plan = planVerification(["workers/cron/src/html.ts"]);
    expect(plan.selectedTests).toContain("tests/cron/");
    expect(plan.selectedTests).toContain("tests/workers/");
    expect(plan.reminders.join(" ")).toContain("lib/calendar/briefing-html.ts");
  });

  it("gives the paired parity reminder from the Mac side too", () => {
    const plan = planVerification(["lib/gmail/theme-sanitize.ts"]);
    expect(plan.reminders.join(" ")).toContain("workers/cron/src/fallback-digest.ts");
  });

  it("migrations get a manual reminder and NO auto test targets", () => {
    const plan = planVerification(["lib/db/migrations/071-new-table.sql"]);
    expect(plan.selectedTests).toEqual([]);
    expect(plan.reminders.join(" ")).toContain("never applies migrations");
    // migrations must NOT also match the lib/db/ entry
    expect(plan.selectedTests).not.toContain("tests/db/");
  });

  it("selects a changed test file directly (untracked new test included)", () => {
    const plan = planVerification(["tests/auth/login-page.test.ts"]);
    expect(plan.directTests).toEqual(["tests/auth/login-page.test.ts"]);
    expect(plan.selectedTests).toContain("tests/auth/login-page.test.ts");
    expect(plan.unmatched).toEqual([]);
  });

  it("unknown paths land in unmatched, never in selectedTests", () => {
    const plan = planVerification(["some/new/area/thing.ts"]);
    expect(plan.unmatched).toEqual(["some/new/area/thing.ts"]);
    expect(plan.selectedTests).toEqual([]);
  });

  it("tooling/docs paths produce the no-focused-test message, not unmatched", () => {
    const plan = planVerification(["scripts/verify-changed.ts", "docs/plans/TODO.md", "qa/run-qa.sh"]);
    expect(plan.selectedTests).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.categories).toContain("tooling");
  });

  it("empty input yields an empty plan", () => {
    const plan = planVerification([]);
    expect(plan.selectedTests).toEqual([]);
    expect(plan.reminders).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it("every mapped test target exists on disk", async () => {
    const { existsSync } = await import("node:fs");
    for (const entry of MAPPING) {
      for (const target of entry.testTargets) {
        expect(existsSync(target), `${entry.category}: ${target} missing`).toBe(true);
      }
    }
  });

  it("formatPlan output is deterministic and sorted", () => {
    const a = formatPlan(planVerification(["lib/mutations/x.ts", "lib/queries/y.ts"]));
    const b = formatPlan(planVerification(["lib/queries/y.ts", "lib/mutations/x.ts"]));
    expect(a).toBe(b);
  });
});
