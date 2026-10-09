import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadVanguardAccountMap,
  resolveVanguardAccountName,
  unmappedAccountWarning,
} from "@/lib/import/vanguard-account-names";
import { parseVanguardExport } from "@/lib/import/parsers/vanguard-export";
import { parseVanguardCostBasis } from "@/lib/import/parsers/vanguard-cost-basis";

const MAP = { "00000001": "Vanguard Taxable", "00000002": "Vanguard Roth IRA" };
const dirs: string[] = [];
function tmpFile(content?: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vg-acct-"));
  dirs.push(d);
  const f = path.join(d, "vanguard-accounts.json");
  if (content !== undefined) fs.writeFileSync(f, content);
  return f;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveVanguardAccountName", () => {
  it("maps a known account", () => {
    expect(resolveVanguardAccountName("00000001", MAP)).toEqual({ accountName: "Vanguard Taxable", mapped: true });
  });
  it("falls back for an unknown account", () => {
    expect(resolveVanguardAccountName("00000009", MAP)).toEqual({ accountName: "Vanguard 00000009", mapped: false });
  });
  it("trims keys and ignores empty values", () => {
    const m = { " 00000001 ": "Vanguard Taxable", "00000002": "  " };
    expect(resolveVanguardAccountName("00000001", m).mapped).toBe(true);
    expect(resolveVanguardAccountName("00000002", m).mapped).toBe(false);
  });
  it("ignores non-string values", () => {
    const m = { "00000001": 5 } as unknown as Record<string, string>;
    expect(resolveVanguardAccountName("00000001", m).mapped).toBe(false);
  });
  it("does not treat prototype names as accounts", () => {
    expect(resolveVanguardAccountName("constructor", MAP).mapped).toBe(false);
  });
});

describe("loadVanguardAccountMap", () => {
  it("reads a valid file", () => {
    expect(loadVanguardAccountMap(tmpFile(JSON.stringify(MAP)))).toEqual(MAP);
  });
  it("returns empty for a missing file", () => {
    expect(loadVanguardAccountMap(tmpFile())).toEqual({});
  });
  it("returns empty for malformed JSON, arrays and scalars", () => {
    expect(loadVanguardAccountMap(tmpFile("{nope"))).toEqual({});
    expect(loadVanguardAccountMap(tmpFile("[1,2]"))).toEqual({});
    expect(loadVanguardAccountMap(tmpFile("7"))).toEqual({});
  });
  it("drops non-string values and trims keys", () => {
    const f = tmpFile(JSON.stringify({ " 00000001 ": "Vanguard Taxable", "00000002": 3, "00000003": "" }));
    expect(loadVanguardAccountMap(f)).toEqual({ "00000001": "Vanguard Taxable" });
  });
  it("picks up an edit to the file", () => {
    const f = tmpFile(JSON.stringify({ "00000001": "A" }));
    expect(loadVanguardAccountMap(f)).toEqual({ "00000001": "A" });
    fs.writeFileSync(f, JSON.stringify({ "00000001": "B" }));
    fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(loadVanguardAccountMap(f)).toEqual({ "00000001": "B" });
  });
});

describe("unmappedAccountWarning", () => {
  it("shows only the last four digits", () => {
    const w = unmappedAccountWarning("00001234");
    expect(w).toContain("1234");
    expect(w).not.toContain("00001234");
    expect(w).toContain("vanguard-accounts.json");
  });
});

const EXPORT_CSV = [
  "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value",
  "00000001,ACME CORP,ACME,10,100.00,1000.00",
  "00000002,ACME CORP,ACME,5,100.00,500.00",
  "00000009,ACME CORP,ACME,2,100.00,200.00",
  "00000009,ACME CORP,ACME,3,100.00,300.00",
  "",
  "Account Number,Trade Date,Settlement Date,Transaction Type,Transaction Description,Investment Name,Symbol,Shares,Share Price,Principal Amount,Commissions and Fees,Net Amount,Accrued Interest,Account Type",
  "00000001,2026-01-05,2026-01-07,Buy,Buy,ACME CORP,ACME,1,100.00,-100.00,0,-100.00,0,CASH",
  "00000009,2026-01-06,2026-01-08,Buy,Buy,ACME CORP,ACME,1,100.00,-100.00,0,-100.00,0,CASH",
].join("\n");

describe("parseVanguardExport with an injected map", () => {
  const r = parseVanguardExport(EXPORT_CSV, "x.csv", MAP);
  it("names mapped and unmapped accounts", () => {
    const names = new Set(r.holdings.map((h) => h.accountName));
    expect(names).toEqual(new Set(["Vanguard Taxable", "Vanguard Roth IRA", "Vanguard 00000009"]));
  });
  it("keeps the mapped name in every sourceKey", () => {
    const h = r.holdings.find((x) => x.accountName === "Vanguard Taxable")!;
    expect(h.sourceKey).toContain(":Vanguard Taxable:ACME:");
    expect(r.transactions[0].accountName).toBe("Vanguard Taxable");
    expect(r.transactions[0].sourceKey).toContain(":Vanguard Taxable:");
  });
  it("warns once per unmapped account, last four digits only", () => {
    const ws = r.warnings.filter((w) => w.includes("vanguard-accounts.json"));
    expect(ws).toHaveLength(1);
    expect(ws[0]).toContain("0009");
    expect(ws[0]).not.toContain("00000009");
  });
  it("does not warn when everything is mapped", () => {
    const ok = parseVanguardExport(EXPORT_CSV, "x.csv", { ...MAP, "00000009": "Vanguard Other" });
    expect(ok.warnings).toEqual([]);
  });
});

const COST_CSV = [
  "Account,Symbol/CUSIP,Description,Position type,Quantity,Total cost,Market value",
  "00000001,ACME,ACME CORP,Long,10,900.00,1000.00",
  "00000009,ACME,ACME CORP,Long,5,450.00,500.00",
  "00000009,ACME,ACME CORP,Long,5,450.00,500.00",
].join("\n");

describe("parseVanguardCostBasis direct export with an injected map", () => {
  it("warns once for the unmapped account and not for the mapped one", () => {
    const r = parseVanguardCostBasis(COST_CSV, "c.csv", MAP);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("0009");
    expect(r.warnings[0]).not.toContain("00000009");
  });
  it("is silent when all accounts are mapped", () => {
    expect(parseVanguardCostBasis(COST_CSV, "c.csv", { ...MAP, "00000009": "Vanguard Other" }).warnings).toEqual([]);
  });
});
