/**
 * The Mac scan hands the security's currency to the push composer, so a level
 * on a non-dollar security is labelled in its own currency (ruling 2026-10-07:
 * labelled, never converted). The real detectAndFireAlerts runs over an
 * in-memory database; only the network call is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel } from "@/lib/mutations/security-levels";
import { detectAndFireAlerts } from "@/lib/alerts/detect";

let db: Database.Database;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.stubEnv("PUSHOVER_APP_TOKEN", "tok");
  vi.stubEnv("PUSHOVER_USER_KEY", "usr");
  fetchSpy = vi.fn(async () => ({ status: 200, json: async () => ({ status: 1, request: "r" }) }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function seedCrossedLevel(symbol: string, currency: string | null, level: number, close: number) {
  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  if (currency) db.prepare("UPDATE securities SET currency = ? WHERE id = ?").run(currency, secId);
  upsertLevel(db, { security_id: secId, level_type: "resistance", price: level, price_source: "static" });
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2099-01-02', ?, 'manual')"
  ).run(secId, close);
}

async function pushMessages(): Promise<Record<string, string>> {
  await new Promise((r) => setTimeout(r, 0));
  const out: Record<string, string> = {};
  for (const call of fetchSpy.mock.calls) {
    const body = new URLSearchParams((call[1] as RequestInit).body as string);
    out[body.get("title")!.split(" ")[0]] = body.get("message")!;
  }
  return out;
}

describe("detectAndFireAlerts: the push carries the security's currency", () => {
  it("a yen security's push is labelled in yen; a dollar security's push is unchanged", async () => {
    seedCrossedLevel("ZZJ", "JPY", 900000, 976000);
    seedCrossedLevel("ZZA", null, 1000, 1291.3);

    const res = detectAndFireAlerts(db);
    expect(res.fired).toBe(2);

    const msgs = await pushMessages();
    expect(msgs.ZZJ).toBe("Triggered @ \u00a5976,000");
    expect(msgs.ZZA).toBe("Triggered @ $1,291.30");
  });
});
