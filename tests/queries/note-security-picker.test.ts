import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getNotePickerSecurities } from "@/lib/queries/note-security-picker";
import {
  defaultPickerSecurities,
  searchPickerSecurities,
  type TieredPickerSecurity,
} from "@/lib/notes/security-picker";

let db: Database.Database;
let accountId: number;

function sec(symbol: string, type = "Stock", name: string | null = `${symbol} Corp`, underlying: string | null = null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, underlying_symbol) VALUES (?, ?, ?, ?)")
    .run(symbol, name, type, underlying).lastInsertRowid as number;
}
function hold(securityId: number, quantity: number, asOf: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(accountId, securityId, quantity, asOf, `zz:${securityId}:${asOf}`);
}
function watch(securityId: number, active = 1): void {
  db.prepare("INSERT INTO watchlist (security_id, is_active) VALUES (?, ?)").run(securityId, active);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Broker')").run().lastInsertRowid as number;
});

describe("getNotePickerSecurities", () => {
  it("tiers held, watchlist and everything else", () => {
    hold(sec("ZZA"), 10, "2026-09-30");
    watch(sec("ZZB"));
    sec("ZZC");
    const rows = getNotePickerSecurities(db);
    const tier = Object.fromEntries(rows.map((r) => [r.symbol, r.tier]));
    expect(tier).toEqual({ ZZA: "held", ZZB: "watch", ZZC: "other" });
  });

  it("a closed position (latest row quantity 0) and an inactive watch are not default", () => {
    const a = sec("ZZA");
    hold(a, 10, "2026-08-31");
    hold(a, 0, "2026-09-30");
    watch(sec("ZZB"), 0);
    const tier = Object.fromEntries(getNotePickerSecurities(db).map((r) => [r.symbol, r.tier]));
    expect(tier).toEqual({ ZZA: "other", ZZB: "other" });
  });

  it("a held and watched name appears once, as held", () => {
    const a = sec("ZZA");
    hold(a, 5, "2026-09-30");
    watch(a);
    const rows = getNotePickerSecurities(db).filter((r) => r.symbol === "ZZA");
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe("held");
  });

  it("promotes a held option's underlying once, and never lists the option", () => {
    const u = sec("ZZA");
    const o1 = sec("ZZA 261218C00100000", "Option", null, "ZZA");
    const o2 = sec("ZZA 261218P00090000", "Option", null, "ZZA");
    hold(o1, 1, "2026-09-30");
    hold(o2, -1, "2026-09-30");
    const rows = getNotePickerSecurities(db);
    expect(rows.filter((r) => r.symbol === "ZZA")).toHaveLength(1);
    expect(rows.find((r) => r.id === u)?.tier).toBe("held");
    expect(rows.some((r) => r.symbol.includes("261218"))).toBe(false);
  });
});

describe("picker tiers", () => {
  const all: TieredPickerSecurity[] = [
    { id: 1, symbol: "ZZA", name: "ZZA Corp", tier: "held" },
    { id: 2, symbol: "ZZB", name: "ZZB Corp", tier: "watch" },
    { id: 3, symbol: "ZZC", name: "Gamma Holdings", tier: "other" },
    { id: 4, symbol: "-", name: null, tier: "other" },
    { id: 5, symbol: "912797AB1", name: null, tier: "held" },
    { id: 6, symbol: "ZZD 261218C00100000", name: null, tier: "other" },
    { id: 7, symbol: "ZZN", name: null, tier: "other" },
  ];

  it("the default list is held + watch only, garbage dropped", () => {
    expect(defaultPickerSecurities(all).map((s) => s.symbol)).toEqual(["ZZA", "ZZB"]);
  });

  it("the default list keeps a note's current security", () => {
    const out = defaultPickerSecurities(all, { id: 3, symbol: "ZZC" });
    expect(out.map((s) => s.symbol)).toContain("ZZC");
  });

  it("share classes sit next to each other", () => {
    const rows: TieredPickerSecurity[] = [
      { id: 1, symbol: "GOOGL", name: "A", tier: "held" },
      { id: 2, symbol: "ZZA", name: "A", tier: "held" },
      { id: 3, symbol: "GOOG", name: "B", tier: "held" },
    ];
    expect(defaultPickerSecurities(rows).map((s) => s.symbol)).toEqual(["GOOG", "GOOGL", "ZZA"]);
  });

  it("search finds a non-held security by symbol or by name", () => {
    expect(searchPickerSecurities(all, "zzc").map((s) => s.symbol)).toEqual(["ZZC"]);
    expect(searchPickerSecurities(all, "gamma").map((s) => s.symbol)).toEqual(["ZZC"]);
  });

  it("search hides garbage and null-name rows unless the query is that exact symbol", () => {
    expect(searchPickerSecurities(all, "9127").map((s) => s.symbol)).toEqual([]);
    expect(searchPickerSecurities(all, "912797AB1").map((s) => s.symbol)).toEqual(["912797AB1"]);
    expect(searchPickerSecurities(all, "zz").map((s) => s.symbol)).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(searchPickerSecurities(all, "ZZN").map((s) => s.symbol)).toEqual(["ZZN"]);
    expect(searchPickerSecurities(all, "zzd")).toEqual([]);
  });

  it("an empty query returns nothing", () => {
    expect(searchPickerSecurities(all, "  ")).toEqual([]);
  });
});
