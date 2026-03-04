import { describe, it, expect } from "vitest";
import { parseMonthlyValues } from "@/lib/import/parsers/monthly-values";
import fs from "node:fs";
import path from "node:path";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/monthly-values-sample.csv"),
  "utf-8"
);

describe("monthly values parser", () => {
  it("returns correct source type", () => {
    const result = parseMonthlyValues(fixture, "monthly_values.csv");
    expect(result.sourceType).toBe("monthly-values");
  });

  it("extracts snapshots for each month", () => {
    const result = parseMonthlyValues(fixture, "monthly_values.csv");
    expect(result.snapshots).toHaveLength(3);
  });

  it("parses snapshot fields correctly", () => {
    const result = parseMonthlyValues(fixture, "monthly_values.csv");
    const jan = result.snapshots.find((s) => s.monthEndDate === "2025-01-31");
    expect(jan).toBeTruthy();
    expect(jan!.totalValue).toBe(63000);
    expect(jan!.accountName).toBe("IBKR");
    expect(jan!.source).toBe("monthly-values");
  });

  it("has no errors", () => {
    const result = parseMonthlyValues(fixture, "monthly_values.csv");
    expect(result.errors).toHaveLength(0);
  });
});
