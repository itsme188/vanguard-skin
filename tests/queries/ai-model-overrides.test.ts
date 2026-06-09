import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  getFeatureModelOverrides,
  FEATURE_MODEL_OVERRIDES_KEY,
} from "@/lib/queries/ai-model-overrides";
import { setFeatureModelOverride } from "@/lib/mutations/ai-model-overrides";

function makeDb(withSettingsTable = true): Database.Database {
  const db = new Database(":memory:");
  if (withSettingsTable) {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }
  return db;
}

describe("getFeatureModelOverrides", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns {} when no overrides row exists", () => {
    expect(getFeatureModelOverrides(db)).toEqual({});
  });

  it("returns {} when the settings table is missing (in-memory test DBs)", () => {
    const bare = makeDb(false);
    expect(getFeatureModelOverrides(bare)).toEqual({});
  });

  it("returns {} when the stored JSON is malformed", () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
    ).run(FEATURE_MODEL_OVERRIDES_KEY, "not json {{");
    expect(getFeatureModelOverrides(db)).toEqual({});
  });

  it("returns stored overrides", () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
    ).run(
      FEATURE_MODEL_OVERRIDES_KEY,
      JSON.stringify({ chat: "anthropic/claude-test-1" }),
    );
    expect(getFeatureModelOverrides(db)).toEqual({
      chat: "anthropic/claude-test-1",
    });
  });

  it("drops entries that do not match the model-spec format", () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
    ).run(
      FEATURE_MODEL_OVERRIDES_KEY,
      JSON.stringify({
        chat: "anthropic/claude-test-1",
        briefing: "no-slash-here",
        tradeReviewQA: 42,
      }),
    );
    expect(getFeatureModelOverrides(db)).toEqual({
      chat: "anthropic/claude-test-1",
    });
  });
});

describe("setFeatureModelOverride", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("sets an override and round-trips through the query", () => {
    setFeatureModelOverride(db, "chat", "anthropic/claude-test-1");
    expect(getFeatureModelOverrides(db)).toEqual({
      chat: "anthropic/claude-test-1",
    });
  });

  it("updates an existing override in place", () => {
    setFeatureModelOverride(db, "chat", "anthropic/claude-test-1");
    setFeatureModelOverride(db, "chat", "anthropic/claude-test-2");
    expect(getFeatureModelOverrides(db)).toEqual({
      chat: "anthropic/claude-test-2",
    });
  });

  it("preserves sibling overrides when setting another key", () => {
    setFeatureModelOverride(db, "chat", "anthropic/claude-test-1");
    setFeatureModelOverride(db, "briefing", "openai/gpt-5");
    expect(getFeatureModelOverrides(db)).toEqual({
      chat: "anthropic/claude-test-1",
      briefing: "openai/gpt-5",
    });
  });

  it("clears an override with null", () => {
    setFeatureModelOverride(db, "chat", "anthropic/claude-test-1");
    setFeatureModelOverride(db, "briefing", "openai/gpt-5");
    setFeatureModelOverride(db, "chat", null);
    expect(getFeatureModelOverrides(db)).toEqual({
      briefing: "openai/gpt-5",
    });
  });

  it("clearing a never-set override is a no-op (does not throw)", () => {
    expect(() => setFeatureModelOverride(db, "chat", null)).not.toThrow();
    expect(getFeatureModelOverrides(db)).toEqual({});
  });

  it("accepts workers-ai specs whose model id contains slashes and @", () => {
    setFeatureModelOverride(
      db,
      "alertSuggestion",
      "workers-ai/@cf/meta/llama-3.3-70b-instruct",
    );
    expect(getFeatureModelOverrides(db)).toEqual({
      alertSuggestion: "workers-ai/@cf/meta/llama-3.3-70b-instruct",
    });
  });

  it("rejects a spec without a provider/model separator", () => {
    expect(() => setFeatureModelOverride(db, "chat", "claude-test-1")).toThrow(
      /format/i,
    );
    expect(getFeatureModelOverrides(db)).toEqual({});
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      setFeatureModelOverride(db, "chat", "gemini/gemini-pro"),
    ).toThrow(/provider/i);
  });

  it("rejects a spec with whitespace", () => {
    expect(() =>
      setFeatureModelOverride(db, "chat", "anthropic/claude test"),
    ).toThrow(/format/i);
  });

  it("rejects an unknown feature key", () => {
    expect(() =>
      // @ts-expect-error — intentionally invalid key
      setFeatureModelOverride(db, "notAFeature", "anthropic/claude-test-1"),
    ).toThrow(/feature/i);
  });
});
