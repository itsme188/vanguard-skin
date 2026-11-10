/**
 * GET + PATCH /api/settings/preferences (in-memory SQLite, mocked db singleton).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";
import {
  CAP_SCOPES,
  CONSTRUCTION_CAPS_KEY_PREFIX,
  COVERAGE_IGNORED_KEY,
  PDFTOTEXT_PATH_KEY,
  WORKSHEET_PRINTER_KEY,
  constructionCapsKey,
} from "@/lib/queries/app-preferences";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET, PATCH } from "@/app/api/settings/preferences/route";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function patch(body: unknown, raw = false): Promise<Response> {
  return PATCH(
    new NextRequest("http://localhost/api/settings/preferences", {
      method: "PATCH",
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}
const snapshot = () =>
  hoisted.db.prepare("SELECT key, value, updated_at FROM settings ORDER BY key").all();
const raw = (key: string) =>
  (hoisted.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;

const NEW_CAPS = { top1Max: 0.07, top3Max: 0.2, sectorMax: 0.3, betaMin: 0.6, betaMax: 1.3 };

/**
 * Mirrors getCaps in lib/compute/exposure-delta.ts (lines ~503-518; not
 * exported) and the top1_max read in lib/compute/cash-deploy.ts (~508-517).
 */
function mirrorGetCaps(db: Database.Database, scope: string) {
  const DEFAULT_CAPS = { top1_max: 0.1, top3_max: 0.25, sector_max: 0.35, beta_range: [0.7, 1.2] };
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`construction_caps_${scope}`) as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_CAPS;
  const p = JSON.parse(row.value) as Partial<typeof DEFAULT_CAPS>;
  return {
    top1_max: p.top1_max ?? DEFAULT_CAPS.top1_max,
    top3_max: p.top3_max ?? DEFAULT_CAPS.top3_max,
    sector_max: p.sector_max ?? DEFAULT_CAPS.sector_max,
    beta_range: p.beta_range ?? DEFAULT_CAPS.beta_range,
  };
}

describe("GET", () => {
  it("returns defaults and seeded per-scope caps", async () => {
    const body = await (await GET()).json();
    expect(body.success).toBe(true);
    expect(body.data.worksheetPrinterName).toBe("");
    expect(body.data.pdftotextPath).toBe("");
    expect(body.data.coverageGuardIgnoredSymbols).toEqual([]);
    expect(body.data.constructionCaps.ibkr).toEqual({ top1Max: 0.15, top3Max: 0.4, sectorMax: 0.45, betaMin: 0.5, betaMax: 1.5 });
    expect(body.data.constructionCaps.vanguard.top1Max).toBe(0.08);
  });

  it("writes nothing: every settings row (key, value, updated_at) is identical after a GET", async () => {
    hoisted.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, '2020-01-01 00:00:00')").run(COVERAGE_IGNORED_KEY, '["abc"]');
    const before = snapshot();
    expect(before.length).toBeGreaterThan(0);
    await GET();
    await GET();
    expect(snapshot()).toEqual(before);
  });
});

describe("PATCH happy paths", () => {
  it("stores trimmed printer + path and returns the new prefs", async () => {
    const res = await patch({ worksheetPrinterName: "  HP_Laser ", pdftotextPath: " /opt/homebrew/bin/pdftotext " });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.worksheetPrinterName).toBe("HP_Laser");
    expect(raw(WORKSHEET_PRINTER_KEY)).toBe("HP_Laser");
    expect(raw(PDFTOTEXT_PATH_KEY)).toBe("/opt/homebrew/bin/pdftotext");
  });

  it("upper-cases and dedupes ignored symbols, preserving order", async () => {
    await patch({ coverageGuardIgnoredSymbols: ["tsm", " Baba ", "TSM", "brk.b"] });
    expect(JSON.parse(raw(COVERAGE_IGNORED_KEY)!)).toEqual(["TSM", "BABA", "BRK.B"]);
  });

  it("an absent field is left untouched", async () => {
    await patch({ worksheetPrinterName: "P1" });
    await patch({ pdftotextPath: "/x" });
    expect(raw(WORKSHEET_PRINTER_KEY)).toBe("P1");
  });

  it("ignores unknown top-level keys", async () => {
    const res = await patch({ nonsense: 1, worksheetPrinterName: "P" });
    expect(res.status).toBe(200);
  });
});

describe("THE CAPS TRAP: caps are stored in the shape the solver reads", () => {
  it("writes snake_case keys with a 2-element beta_range, and the readers return the written numbers, not defaults", async () => {
    const res = await patch({ constructionCaps: { vanguard: NEW_CAPS } });
    expect(res.status).toBe(200);

    const stored = JSON.parse(raw(constructionCapsKey("vanguard"))!);
    expect(Object.keys(stored).sort()).toEqual(["beta_range", "sector_max", "top1_max", "top3_max"]);
    expect(stored.top1_max).toBe(0.07);
    expect(stored.top3_max).toBe(0.2);
    expect(stored.sector_max).toBe(0.3);
    expect(stored.beta_range).toEqual([0.6, 1.3]);
    expect(stored).not.toHaveProperty("top1Max");
    expect(stored).not.toHaveProperty("betaMin");

    const caps = mirrorGetCaps(hoisted.db, "vanguard");
    expect(caps).toEqual({ top1_max: 0.07, top3_max: 0.2, sector_max: 0.3, beta_range: [0.6, 1.3] });
    expect(caps.top1_max).not.toBe(0.1); // DEFAULT_CAPS.top1_max
  });
});

describe("per-scope isolation", () => {
  it("PATCHing one scope leaves the other three stored rows byte-identical", async () => {
    const others = CAP_SCOPES.filter((s) => s !== "ibkr").map((s) => [s, raw(constructionCapsKey(s))] as const);
    await patch({ constructionCaps: { ibkr: NEW_CAPS } });
    for (const [s, v] of others) expect(raw(constructionCapsKey(s))).toBe(v);
    expect(raw(constructionCapsKey("ibkr"))).not.toBe(undefined);
    expect(JSON.parse(raw(constructionCapsKey("ibkr"))!).top1_max).toBe(0.07);
  });
});

describe("clears delete the row", () => {
  it("empty string / empty array DELETE rather than store empty values", async () => {
    await patch({ worksheetPrinterName: "P", pdftotextPath: "/x", coverageGuardIgnoredSymbols: ["A"] });
    expect(raw(WORKSHEET_PRINTER_KEY)).toBe("P");
    const res = await patch({ worksheetPrinterName: "   ", pdftotextPath: "", coverageGuardIgnoredSymbols: [] });
    expect(res.status).toBe(200);
    for (const k of [WORKSHEET_PRINTER_KEY, PDFTOTEXT_PATH_KEY, COVERAGE_IGNORED_KEY]) {
      expect(raw(k)).toBeUndefined();
    }
    const body = await (await GET()).json();
    expect(body.data.coverageGuardIgnoredSymbols).toEqual([]);
  });
});

describe("validation refusals return 400 and change nothing", () => {
  const bad: Array<[string, unknown]> = [
    ["ticker with a space", { coverageGuardIgnoredSymbols: ["AB CD"] }],
    ["ticker too long", { coverageGuardIgnoredSymbols: ["ABCDEFGHIJK"] }],
    ["non-string ticker", { coverageGuardIgnoredSymbols: [5] }],
    ["non-array symbols", { coverageGuardIgnoredSymbols: "AAPL" }],
    ["non-string printer", { worksheetPrinterName: 3 }],
    ["top1 zero", { constructionCaps: { all: { ...NEW_CAPS, top1Max: 0 } } }],
    ["top3 above 1", { constructionCaps: { all: { ...NEW_CAPS, top3Max: 1.5 } } }],
    ["sector NaN-ish string", { constructionCaps: { all: { ...NEW_CAPS, sectorMax: "0.3" } } }],
    ["top1 > top3", { constructionCaps: { all: { ...NEW_CAPS, top1Max: 0.3, top3Max: 0.2 } } }],
    ["betaMin >= betaMax", { constructionCaps: { all: { ...NEW_CAPS, betaMin: 1.3, betaMax: 1.3 } } }],
    ["betaMax > 5", { constructionCaps: { all: { ...NEW_CAPS, betaMax: 6 } } }],
    ["betaMin negative", { constructionCaps: { all: { ...NEW_CAPS, betaMin: -0.1 } } }],
    ["unknown scope", { constructionCaps: { crypto: NEW_CAPS } }],
    ["caps not an object", { constructionCaps: [] }],
  ];
  for (const [name, body] of bad) {
    it(name, async () => {
      // Valid sibling field in the same request must not be written either.
      const before = snapshot();
      const res = await patch({ worksheetPrinterName: "SHOULD_NOT_STICK", ...(body as object) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe("string");
      expect(snapshot()).toEqual(before);
    });
  }

  it("non-object body and unparseable JSON", async () => {
    const before = snapshot();
    expect((await patch([1])).status).toBe(400);
    expect((await patch("null", true)).status).toBe(400);
    expect((await patch("{nope", true)).status).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it("uses the key prefix constant consistently", () => {
    expect(constructionCapsKey("all")).toBe(`${CONSTRUCTION_CAPS_KEY_PREFIX}all`);
  });
});
