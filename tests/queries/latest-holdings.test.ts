import { describe, it, expect } from "vitest";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

describe("latestHoldingsPredicate", () => {
  it("default options produce per-(account, security) key with quantity != 0 and no asOfDate", () => {
    const sql = latestHoldingsPredicate();
    expect(sql).toContain("h2.account_id = h.account_id");
    expect(sql).toContain("h2.security_id = h.security_id");
    expect(sql).toContain("h.quantity != 0");
    expect(sql).not.toContain("h2.as_of_date <=");
    expect(sql).not.toContain("h.as_of_date <=");
  });

  it("keyBy=account produces per-account key (no security_id join)", () => {
    const sql = latestHoldingsPredicate({ keyBy: "account" });
    expect(sql).toContain("h2.account_id = h.account_id");
    expect(sql).not.toContain("h2.security_id = h.security_id");
  });

  it("includeShorts=false produces quantity > 0", () => {
    const sql = latestHoldingsPredicate({ includeShorts: false });
    expect(sql).toContain("h.quantity > 0");
    expect(sql).not.toContain("h.quantity != 0");
  });

  it("asOfDate set adds both inner subquery AND outer predicate constraints (literal-substituted)", () => {
    const sql = latestHoldingsPredicate({ asOfDate: "2026-05-10" });
    expect(sql).toContain("AND h2.as_of_date <= '2026-05-10'");
    expect(sql).toContain("AND h.as_of_date <= '2026-05-10'");
    // Make sure we did NOT leave a positional ? behind
    expect(sql).not.toContain("h2.as_of_date <= ?");
    expect(sql).not.toContain("h.as_of_date <= ?");
  });

  it("asOfDate omitted produces no asOfDate clauses anywhere in the predicate", () => {
    const sql = latestHoldingsPredicate({});
    expect(sql).not.toContain("h2.as_of_date <=");
    expect(sql).not.toContain("h.as_of_date <=");
  });

  it.each([
    ["abc"],
    ["2026/05/10"],
    [""],
    ["2026-5-10"],
    ["2026-05-10T00:00:00"],
    ["2026-05-10'; DROP TABLE holdings--"],
  ])("malformed asOfDate %j throws", (badDate) => {
    expect(() => latestHoldingsPredicate({ asOfDate: badDate })).toThrow(/YYYY-MM-DD/);
  });

  it("accountFilter is appended verbatim after the qty clause", () => {
    const sql = latestHoldingsPredicate({ accountFilter: "AND h.account_id IN (?,?,?)" });
    // The qty clause is followed by the accountFilter on the same logical line
    expect(sql).toMatch(/h\.quantity != 0\s+AND h\.account_id IN \(\?,\?,\?\)/);
  });

  it("empty accountFilter yields no trailing AND", () => {
    const sql = latestHoldingsPredicate({});
    expect(sql).not.toMatch(/AND\s*$/);
  });

  it("composes all options together", () => {
    const sql = latestHoldingsPredicate({
      keyBy: "account_security",
      includeShorts: false,
      asOfDate: "2026-05-10",
      accountFilter: "AND h.account_id IN (?)",
    });
    expect(sql).toContain("h2.account_id = h.account_id AND h2.security_id = h.security_id");
    expect(sql).toContain("AND h2.as_of_date <= '2026-05-10'");
    expect(sql).toContain("AND h.as_of_date <= '2026-05-10'");
    expect(sql).toContain("h.quantity > 0");
    expect(sql).toContain("AND h.account_id IN (?)");
  });
});
