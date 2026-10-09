// POST /api/compute/classify records when option sectors were last checked,
// on both branches: the run itself stamps when there was work, and the route
// asks the lib function to stamp when its pre-check found nothing to do.
// The route holds no SQL of its own for this.
//
// All tickers are synthetic (ZZ*). All quantities are invented.
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
}));
vi.mock("@/lib/compute/classify-securities", () => ({
  classifySecurities: vi.fn(() => ({ total: 0, classified: 0, skipped: 0, unresolved: [] })),
  classifyUnresolvedWithClaude: vi.fn(async () => ({ classified: 0, errors: [] })),
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
import { getLastSectorClassifyRun, SECTOR_CLASSIFY_LAST_RUN_KEY } from "@/lib/securities/classify-option-sectors";

let db: Database.Database;
let acct: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  h.db = db;
  acct = db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run().lastInsertRowid as number;
  generateTextMock.mockReset();
});

function seedHeldOption(symbol: string, underlying: string) {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'Options', ?, 'CALL', 90, '2099-01-15', 100)`,
    )
    .run(symbol, symbol, underlying).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 1, '2026-06-01', 'test:' || ?)",
  ).run(acct, id, id);
  return id;
}

describe("POST /api/compute/classify: the sector check time", () => {
  it("is recorded when the pre-check finds nothing to do", async () => {
    expect(getLastSectorClassifyRun(db)).toBeNull();
    const res = await POST();
    const body = await res.json();
    expect(body).toMatchObject({ success: true, optionSectorsClassified: 0, aiErrors: [] });
    expect(getLastSectorClassifyRun(db)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("is recorded when the run had work and finished cleanly", async () => {
    db.prepare("INSERT INTO securities (symbol, name, security_type, sector, multiplier) VALUES ('ZZA', 'ZZA', 'Stock', 'Energy', 1)").run();
    const opt = seedHeldOption("ZZA 990115C00090000", "ZZA");
    const body = await (await POST()).json();
    expect(body).toMatchObject({ success: true, optionSectorsClassified: 1 });
    expect(db.prepare("SELECT sector FROM securities WHERE id = ?").get(opt)).toEqual({ sector: "Energy" });
    expect(getLastSectorClassifyRun(db)).not.toBeNull();
  });

  it("is left where it was when the run hits an AI error", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, '2026-01-05 10:00:00')").run(SECTOR_CLASSIFY_LAST_RUN_KEY);
    seedHeldOption("ZZB 990115C00090000", "ZZB"); // unknown underlying: the AI is asked
    generateTextMock.mockRejectedValue(new Error("network down"));
    const body = await (await POST()).json();
    expect(body.aiErrors).toHaveLength(1);
    expect(getLastSectorClassifyRun(db)).toBe("2026-01-05 10:00:00");
  });

  it("neither caller writes the setting itself: both go through the lib function", () => {
    for (const path of ["app/api/compute/classify/route.ts", "lib/tws/auto-refresh.ts", "app/api/import/route.ts"]) {
      const src = readFileSync(path, "utf8");
      expect(src, path).not.toContain("sector_classify_last_run_at");
      expect(src, path).not.toContain("SECTOR_CLASSIFY_LAST_RUN_KEY");
    }
    expect(readFileSync("app/api/compute/classify/route.ts", "utf8")).toContain("markOptionSectorsChecked(db)");
    expect(readFileSync("lib/tws/auto-refresh.ts", "utf8")).toContain("markOptionSectorsChecked(db)");
    // The import route does not record a sector check at all.
    expect(readFileSync("app/api/import/route.ts", "utf8")).not.toContain("markOptionSectorsChecked");
  });
});
