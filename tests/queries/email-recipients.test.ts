import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getRecipientsFor } from "@/lib/queries/email-recipients";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("getRecipientsFor", () => {
  it("returns parsed comma-separated list when set", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "briefing_email_recipients",
      "a@x.com, b@x.com"
    );
    expect(getRecipientsFor(db, "briefing")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns null when setting is absent", () => {
    expect(getRecipientsFor(db, "digest")).toBeNull();
  });

  it("trims whitespace and drops empty entries", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "evening_email_recipients",
      "  a@x.com ,, b@x.com  "
    );
    expect(getRecipientsFor(db, "evening")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns null when value is empty string", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "briefing_email_recipients",
      ""
    );
    expect(getRecipientsFor(db, "briefing")).toBeNull();
  });

  it("returns null when value is just whitespace", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "digest_email_recipients",
      "   "
    );
    expect(getRecipientsFor(db, "digest")).toBeNull();
  });

  it("handles a single address without trailing comma", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "evening_email_recipients",
      "solo@example.com"
    );
    expect(getRecipientsFor(db, "evening")).toEqual(["solo@example.com"]);
  });
});
