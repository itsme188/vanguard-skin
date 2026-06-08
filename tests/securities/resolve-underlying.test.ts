import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { resolveHeldUnderlying } from "@/lib/securities/resolve-underlying";

function makeDb(symbols: string[]) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT, security_type TEXT);`);
  const ins = db.prepare("INSERT INTO securities (symbol, security_type) VALUES (?, 'Stock')");
  for (const s of symbols) ins.run(s);
  return db;
}

describe("resolveHeldUnderlying", () => {
  it("extracts the OCC underlying", () => {
    expect(resolveHeldUnderlying(makeDb(["AMZN"]), "AMZN  270617C00260000")).toBe("AMZN");
  });
  it("prefers the held issuer sibling (GOOGL option -> held GOOG)", () => {
    expect(resolveHeldUnderlying(makeDb(["GOOG"]), "GOOGL 260320C00200000")).toBe("GOOG");
  });
  it("keeps the exact ticker when that exact one is held", () => {
    expect(resolveHeldUnderlying(makeDb(["GOOGL", "GOOG"]), "GOOGL 260320C00200000")).toBe("GOOGL");
  });
  it("returns the raw OCC underlying when no sibling is in the book", () => {
    expect(resolveHeldUnderlying(makeDb([]), "ALGM  260320C00045000")).toBe("ALGM");
  });
  it("returns null for a non-OCC symbol", () => {
    expect(resolveHeldUnderlying(makeDb([]), "AAPL")).toBeNull();
  });
});
