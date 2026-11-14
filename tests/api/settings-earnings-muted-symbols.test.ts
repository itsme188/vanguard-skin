/**
 * PATCH /api/settings/earnings: the mute list applies the coverage list's
 * ticker rule, and a refusal changes nothing (not `enabled` either).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEarningsSettings, setEarningsEmailsEnabled, setMutedEarningsSymbols } from "@/lib/queries/earnings-settings";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { PATCH } from "@/app/api/settings/earnings/route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/settings/earnings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  setMutedEarningsSymbols(hoisted.db, ["AAA"]);
  setEarningsEmailsEnabled(hoisted.db, true);
});

describe("PATCH /api/settings/earnings mutedSymbols", () => {
  it("refuses a non-ticker with the coverage list's sentence and keeps the list", async () => {
    const res = await patch({ mutedSymbols: ["AAA", "$$ 12!"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      '"$$ 12!" is not a valid ticker (letters, digits, dot or dash, up to 10 characters).',
    );
    expect(getEarningsSettings(hoisted.db).mutedSymbols).toEqual(["AAA"]);
  });

  it("stores a valid lower-case symbol upper-cased", async () => {
    const res = await patch({ mutedSymbols: ["AAA", " brk.b "] });
    expect(res.status).toBe(200);
    expect(getEarningsSettings(hoisted.db).mutedSymbols).toEqual(["AAA", "BRK.B"]);
  });

  it("stores neither symbol when one is good and one is bad", async () => {
    const res = await patch({ mutedSymbols: ["GOOD", "bad symbol"] });
    expect(res.status).toBe(400);
    expect(getEarningsSettings(hoisted.db).mutedSymbols).toEqual(["AAA"]);
  });

  it("does not change enabled when the same request has a bad symbol", async () => {
    const res = await patch({ enabled: false, mutedSymbols: ["WAYTOOLONGSYMBOL"] });
    expect(res.status).toBe(400);
    expect(getEarningsSettings(hoisted.db).enabled).toBe(true);
  });
});
