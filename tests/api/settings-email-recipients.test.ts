/**
 * Tests for GET + PATCH /api/settings/email-recipients
 *
 * Uses an in-memory SQLite database to avoid touching the real data/vanguard.db.
 * The route module uses `import { db } from "@/lib/db"` — we mock that module
 * before importing the route handlers.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

// ── Shared mock — replace the `db` singleton with an in-memory DB ──────────

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Import AFTER mocks are registered so the route binds to the mock db
import { GET, PATCH } from "@/app/api/settings/email-recipients/route";

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

// ── GET ────────────────────────────────────────────────────────────────────

describe("GET /api/settings/email-recipients", () => {
  it("returns an empty object when no keys are set", async () => {
    const res = await GET();
    const body = (await res.json()) as Record<string, string>;
    expect(body).toEqual({});
  });

  it("returns only the keys that have been set", async () => {
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("briefing_email_recipients", "alice@example.com");

    const res = await GET();
    const body = (await res.json()) as Record<string, string>;
    expect(body).toEqual({ briefing_email_recipients: "alice@example.com" });
    expect(body).not.toHaveProperty("digest_email_recipients");
    expect(body).not.toHaveProperty("evening_email_recipients");
  });

  it("returns all three keys when all are set", async () => {
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("briefing_email_recipients", "a@x.com");
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("digest_email_recipients", "b@x.com, c@x.com");
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("evening_email_recipients", "d@x.com");

    const res = await GET();
    const body = (await res.json()) as Record<string, string>;
    expect(body.briefing_email_recipients).toBe("a@x.com");
    expect(body.digest_email_recipients).toBe("b@x.com, c@x.com");
    expect(body.evening_email_recipients).toBe("d@x.com");
  });

  it("does not return unrelated settings keys", async () => {
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("some_other_key", "irrelevant");

    const res = await GET();
    const body = (await res.json()) as Record<string, string>;
    expect(Object.keys(body)).toHaveLength(0);
  });
});

// ── PATCH ──────────────────────────────────────────────────────────────────

describe("PATCH /api/settings/email-recipients", () => {
  function makeRequest(body: Record<string, unknown>) {
    return new NextRequest("http://localhost/api/settings/email-recipients", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("inserts a new key when it did not exist before", async () => {
    const req = makeRequest({ briefing_email_recipients: "alice@example.com" });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const row = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("briefing_email_recipients") as { value: string } | undefined;
    expect(row?.value).toBe("alice@example.com");
  });

  it("upserts (overwrites) an existing key", async () => {
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("digest_email_recipients", "old@example.com");

    const req = makeRequest({ digest_email_recipients: "new@example.com" });
    await PATCH(req);

    const row = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("digest_email_recipients") as { value: string } | undefined;
    expect(row?.value).toBe("new@example.com");
  });

  it("only writes keys present in the body (partial update)", async () => {
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("briefing_email_recipients", "keep@example.com");

    const req = makeRequest({ evening_email_recipients: "eve@example.com" });
    await PATCH(req);

    // briefing key should be untouched
    const briefingRow = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("briefing_email_recipients") as { value: string } | undefined;
    expect(briefingRow?.value).toBe("keep@example.com");

    // evening key should be set
    const eveningRow = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("evening_email_recipients") as { value: string } | undefined;
    expect(eveningRow?.value).toBe("eve@example.com");
  });

  it("allows clearing a key by writing an empty string", async () => {
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("briefing_email_recipients", "alice@example.com");

    const req = makeRequest({ briefing_email_recipients: "" });
    await PATCH(req);

    const row = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("briefing_email_recipients") as { value: string } | undefined;
    expect(row?.value).toBe("");
  });

  it("ignores unknown keys that are not in the allowlist", async () => {
    const req = makeRequest({
      briefing_email_recipients: "valid@example.com",
      unknown_key: "should_be_ignored",
    });
    await PATCH(req);

    const unknown = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("unknown_key");
    expect(unknown).toBeUndefined();

    const valid = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("briefing_email_recipients") as { value: string } | undefined;
    expect(valid?.value).toBe("valid@example.com");
  });

  it("stores comma-separated multi-address values verbatim", async () => {
    const value = "alice@x.com, bob@x.com, carol@x.com";
    const req = makeRequest({ evening_email_recipients: value });
    await PATCH(req);

    const row = hoisted.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("evening_email_recipients") as { value: string } | undefined;
    expect(row?.value).toBe(value);
  });

  it("returns 400 for malformed JSON body", async () => {
    const req = new NextRequest(
      "http://localhost/api/settings/email-recipients",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not-valid-json",
      },
    );
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid json/i);
  });
});
