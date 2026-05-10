import { describe, it, expect } from "vitest";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

describe("latestHoldingsPredicate", () => {
  it("default options produce per-(account, security) key with quantity != 0 and no cutoff", () => {
    const sql = latestHoldingsPredicate();
    expect(sql).toContain("h2.account_id = h.account_id");
    expect(sql).toContain("h2.security_id = h.security_id");
    expect(sql).toContain("h.quantity != 0");
    expect(sql).not.toContain("h2.as_of_date <=");
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

  it("cutoff=true adds the inner AND h2.as_of_date <= ? clause", () => {
    const sql = latestHoldingsPredicate({ cutoff: true });
    expect(sql).toContain("AND h2.as_of_date <= ?");
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
      cutoff: true,
      accountFilter: "AND h.account_id IN (?)",
    });
    expect(sql).toContain("h2.account_id = h.account_id AND h2.security_id = h.security_id");
    expect(sql).toContain("AND h2.as_of_date <= ?");
    expect(sql).toContain("h.quantity > 0");
    expect(sql).toContain("AND h.account_id IN (?)");
  });
});
