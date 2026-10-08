import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { checkRecipientAllowed } from "@/lib/email/recipient-guard";
import { sendRefusalCopy } from "@/app/dashboard/components/SendDigestPanel";
import { sliceBetween } from "../helpers/source-anchor";

const SRC = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/SendDigestPanel.tsx"),
  "utf8",
);

describe("send panel: the allowlist refusal is worded for a person", () => {
  let db: Database.Database;
  const savedEnv = process.env.BRIEFING_EMAIL_TO;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    process.env.BRIEFING_EMAIL_TO = "owner@example.com";
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BRIEFING_EMAIL_TO;
    else process.env.BRIEFING_EMAIL_TO = savedEnv;
    db.close();
  });

  // Fed with the guard's REAL output, so a reworded guard fails here instead
  // of quietly putting the developer sentence back on screen.
  it.each([
    ["digest", "Morning Digest"],
    ["briefing", "Sunday Briefing"],
  ] as const)("%s: drops the override instruction and points at Settings", (type, label) => {
    const refusal = checkRecipientAllowed(db, type, "stranger@example.com", false);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error).toMatch(/override/);

    const copy = sendRefusalCopy(refusal.error, type);
    expect(copy).not.toMatch(/override/i);
    expect(copy).toContain("stranger@example.com");
    expect(copy).not.toContain("owner@example.com");
    expect(copy).toContain(`Settings → Email Recipients → ${label}`);
  });

  it("leaves any other failure text alone", () => {
    const other = "Too many emails sent from this route recently. Try again in a few minutes.";
    expect(sendRefusalCopy(other, "digest")).toBe(other);
  });

  it("both send branches route the failure text through it", () => {
    expect(SRC).toContain('sendRefusalCopy(r.message, "digest")');
    expect(SRC).toContain('sendRefusalCopy(r.message, "briefing")');
    expect(SRC).not.toMatch(/: \$\{r\.message\}/);
  });
});

describe("send panel: a status line never outlives the configuration it described", () => {
  const controls = sliceBetween(SRC, "{/* Type toggle */}", "{/* Send button + status */}");

  it.each([
    'setEmailType("digest")',
    'setEmailType("briefing")',
    "setDigestMode(",
    "setSinceDate(",
    "setBriefingMode(",
    "setWeekOfDate(",
  ])("%s clears the status first", (setter) => {
    const calls = controls.split(setter).length - 1;
    expect(calls).toBe(1);
    expect(controls).toContain(`{ clearResult(); ${setter}`);
  });

  it("clearResult resets the result state", () => {
    expect(SRC).toContain("const clearResult = () => setResult(null);");
  });
});
