import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  cashEquivalentSecuritySql,
  cashEquivalentSecurityTypeSql,
  isCashEquivalentSecurity,
} from "@/lib/compute/cash-equivalents";

describe("cashEquivalentSecuritySql", () => {
  it("matches isCashEquivalentSecurity across the legacy money-market shapes", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE securities (id INTEGER PRIMARY KEY, security_type TEXT, fund_category TEXT)");
    const types = [null, "", "Stock", "ETF", "Mutual Fund", "money_market", "Money Market"];
    const categories = [null, "", "Short-Term Bond", "Cash Equivalent", "Money Market"];
    const paddings = ["", " ", "\t", "\n", "\r", "\u00A0", " \t\r\n\u00A0"];
    const pad = (value: string | null, padding: string) => (value == null ? null : `${padding}${value}${padding}`);
    const cases = types.flatMap((security_type) =>
      categories.flatMap((fund_category) =>
        paddings.map((padding) => ({
          security_type: pad(security_type, padding),
          fund_category: pad(fund_category, padding),
        })),
      ),
    );
    const insert = db.prepare("INSERT INTO securities (id, security_type, fund_category) VALUES (?, ?, ?)");
    cases.forEach((row, index) => insert.run(index + 1, row.security_type, row.fund_category));

    const rows = db
      .prepare(`SELECT id, CASE WHEN ${cashEquivalentSecuritySql("s")} THEN 1 ELSE 0 END AS is_cash FROM securities s ORDER BY id`)
      .all() as { id: number; is_cash: number }[];

    expect(rows.map((row) => Boolean(row.is_cash))).toEqual(cases.map(isCashEquivalentSecurity));
  });

  it("exposes a type-only SQL signal for live sync paths", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE securities (id INTEGER PRIMARY KEY, security_type TEXT, fund_category TEXT)");
    db.prepare("INSERT INTO securities (id, security_type, fund_category) VALUES (?, ?, ?)").run(
      1,
      "ETF",
      "Cash Equivalent",
    );
    db.prepare("INSERT INTO securities (id, security_type, fund_category) VALUES (?, ?, ?)").run(
      2,
      "\tMoney Market\u00A0",
      null,
    );

    const rows = db
      .prepare(`SELECT id, CASE WHEN ${cashEquivalentSecurityTypeSql("s")} THEN 1 ELSE 0 END AS is_cash FROM securities s ORDER BY id`)
      .all() as { id: number; is_cash: number }[];

    expect(rows).toEqual([
      { id: 1, is_cash: 0 },
      { id: 2, is_cash: 1 },
    ]);
  });
});
