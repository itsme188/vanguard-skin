/**
 * POST /api/compute/classify reports counts the button can act on (review
 * round 3, Analysis tab fix wave 2026-11-15, Z6).
 *
 * The AI fallback asks only about securities held now (or the underlying of a
 * held, live option). The route used to subtract the AI's count from EVERY
 * unresolved security, so names not held showed up as "couldn't be
 * auto-classified" on every click. It now returns two counts: held names
 * still unclassified after the AI step, and names not held that were not sent
 * to the AI. Its held split must agree with the one the AI step uses. The
 * AI error lines reaching the user carry no batch numbering.
 *
 * `classifySecurities` is stubbed to a fixed unresolved list; the AI fallback
 * itself is the real one, with `generateTextForFeature` mocked. All tickers
 * are synthetic (ZZ*) and every quantity is invented.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

const h = vi.hoisted(() => ({
  db: null as unknown,
  unresolved: [] as Array<{ id: number; symbol: string; security_type: string | null; name?: string | null }>,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
}));
vi.mock("@/lib/compute/classify-securities", async (orig) => ({
  ...(await orig<typeof import("@/lib/compute/classify-securities")>()),
  classifySecurities: vi.fn(() => ({ total: h.unresolved.length, classified: 0, skipped: 7, unresolved: h.unresolved })),
}));
const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "test-model" })),
}));

import { runMigrations } from "@/lib/db/migrate";
import { POST } from "@/app/api/compute/classify/route";

let db: Database.Database;
let acct: number;

function security(symbol: string, type = "Stock", extra: Record<string, unknown> = {}) {
  const cols = ["symbol", "name", "security_type", "multiplier", ...Object.keys(extra)];
  const vals = [symbol, `${symbol} Synthetic Co`, type, 1, ...Object.values(extra)];
  return db
    .prepare(`INSERT INTO securities (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...vals).lastInsertRowid as number;
}
function hold(securityId: number, quantity: number, asOf: string) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(acct, securityId, quantity, asOf, `test:${securityId}:${asOf}`);
}
function unresolvedRow(id: number) {
  const r = db.prepare("SELECT id, symbol, security_type, name FROM securities WHERE id = ?").get(id) as {
    id: number; symbol: string; security_type: string | null; name: string | null;
  };
  return r;
}

let ids: Record<string, number>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  h.db = db;
  acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
  generateTextMock.mockReset();

  ids = {
    heldPlaced: security("ZZHA"),
    heldNotPlaced: security("ZZHB"),
    underlying: security("ZZHU"),
    neverHeld: security("ZZNA"),
    soldOut: security("ZZNB"),
  };
  hold(ids.heldPlaced, 10, "2026-06-01");
  hold(ids.heldNotPlaced, 10, "2026-06-01");
  hold(ids.soldOut, 10, "2026-05-01");
  hold(ids.soldOut, 0, "2026-06-01"); // a quantity-0 tombstone: not held now
  const opt = security("ZZHU 990115C00090000", "Option", {
    underlying_symbol: "ZZHU", option_type: "CALL", strike_price: 90, expiration_date: "2099-01-15", sector: "Energy",
  });
  db.prepare("UPDATE securities SET multiplier = 100, fund_category = 'Options', classification_source = 'test' WHERE id = ?").run(opt);
  db.prepare("UPDATE securities SET sector = 'Energy' WHERE id = ?").run(ids.underlying);
  hold(opt, 1, "2026-06-01");

  h.unresolved = Object.values(ids).map(unresolvedRow);
});

function classifiedReply(symbols: string[]) {
  return JSON.stringify(symbols.map((symbol) => ({
    symbol, fund_category: "US Equity", geography: "US", market_cap_category: "Large", style: "Blend",
  })));
}

describe("POST /api/compute/classify: held and not-held counts", () => {
  it("returns held names still unclassified and not-held names skipped, never one blended count", async () => {
    generateTextMock.mockResolvedValue({ text: classifiedReply(["ZZHA", "ZZHU"]), finishReason: "stop" });
    const body = await (await POST()).json();
    expect(body.success).toBe(true);
    expect(body.classified).toBe(2);
    expect(body.heldUnresolvedCount).toBe(1); // ZZHB: held, the AI gave no answer for it
    expect(body.notHeldSkippedCount).toBe(2); // ZZNA never held, ZZNB sold out
    expect(body).not.toHaveProperty("unresolvedCount");
  });

  it("its held split agrees with the names the AI step was asked about", async () => {
    generateTextMock.mockResolvedValue({ text: classifiedReply([]), finishReason: "stop" });
    const body = await (await POST()).json();
    const prompts = generateTextMock.mock.calls
      .map((c) => (c[1] as { prompt: string }).prompt)
      .filter((p) => p.startsWith("Classify:"));
    const asked = prompts.join("\n");
    for (const s of ["ZZHA", "ZZHB", "ZZHU"]) expect(asked).toContain(`- ${s}:`);
    for (const s of ["ZZNA", "ZZNB"]) expect(asked).not.toContain(`- ${s}:`);
    expect(body.heldUnresolvedCount).toBe(3);
    expect(body.notHeldSkippedCount).toBe(2);
  });

  it("a held name the AI placed is not counted, even when the reply lists it twice", async () => {
    generateTextMock.mockResolvedValue({ text: classifiedReply(["ZZHA", "ZZHA", "ZZHB", "ZZHU"]), finishReason: "stop" });
    const body = await (await POST()).json();
    expect(body.heldUnresolvedCount).toBe(0);
  });

  it("nothing held unresolved: the AI is not asked and only the skipped count remains", async () => {
    h.unresolved = [ids.neverHeld, ids.soldOut].map(unresolvedRow);
    const body = await (await POST()).json();
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(body).toMatchObject({ classified: 0, heldUnresolvedCount: 0, notHeldSkippedCount: 2, aiErrors: [] });
  });
});

describe("POST /api/compute/classify: AI errors in plain words", () => {
  it("a cut-off reply reaches the user without batch numbering", async () => {
    h.unresolved = [ids.heldPlaced].map(unresolvedRow);
    generateTextMock.mockResolvedValue({ text: "[", finishReason: "length" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await (await POST()).json();
    expect(body.aiErrors).toHaveLength(1);
    expect(body.aiErrors[0]).not.toMatch(/Batch \d/);
    expect(body.aiErrors[0]).not.toMatch(/output cap/);
    expect(body.aiErrors[0]).toMatch(/cut off/);
    // The batch number stays in the server log.
    expect(warn.mock.calls.flat().map(String).join("\n")).toMatch(/Batch 1/);
    warn.mockRestore();
  });

  it("another error keeps its text, without the batch prefix", async () => {
    h.unresolved = [ids.heldPlaced].map(unresolvedRow);
    generateTextMock.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await (await POST()).json();
    expect(body.aiErrors).toEqual(["network down"]);
  });
});
