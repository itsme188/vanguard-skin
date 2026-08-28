/**
 * QA: import-pdf--wrong-format-500-truncated-midword-error.
 *
 * HTTP-boundary pin: when the Vanguard PDF parser throws its
 * "Failed to parse Claude response as JSON: <slice>" error (unchanged —
 * lib/import/parsers/vanguard-pdf.ts is under CLAUDE.md's "What NOT to
 * Change"), POST /api/import must classify it via
 * lib/import/error-classify.ts's classifyImportError: a wrong-document
 * explanation from Claude becomes a 400 with a domain-first message;
 * anything else stays a 500. Unit coverage of the classifier itself lives in
 * tests/import/error-classify.test.ts — this file only pins that the route
 * actually wires it in at the catch boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  throwMessage: "",
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/import/engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/import/engine")>();
  return {
    ...original,
    parseImport: vi.fn(async () => {
      throw new Error(hoisted.throwMessage);
    }),
  };
});

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

function importReq(
  mode: "preview" | "commit",
  files: { name: string; content: string }[],
): NextRequest {
  const fd = new FormData();
  for (const f of files) {
    fd.append("files", new File([f.content], f.name, { type: "application/pdf" }));
  }
  return new NextRequest(`http://test/api/import?mode=${mode}`, {
    method: "POST",
    body: fd,
  });
}

describe("POST /api/import — PDF parser JSON-parse-failure classification", () => {
  it("a not-a-Vanguard-statement explanation from Claude surfaces as HTTP 400 with a domain-first message", async () => {
    hoisted.throwMessage =
      "Failed to parse Claude response as JSON: This document is not a Vanguard brokerage statement — it appears to be an unrelated PDF with no account information.";

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("preview", [{ name: "not-a-statement.pdf", content: "%PDF-fake" }]),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(
      (body.error as string).startsWith(
        "This file doesn't look like a Vanguard brokerage statement.",
      ),
    ).toBe(true);
    expect(body.error).not.toContain("Failed to parse Claude response as JSON");
  });

  it("a genuinely malformed AI JSON response stays HTTP 500 with the parser's prefix intact", async () => {
    hoisted.throwMessage =
      'Failed to parse Claude response as JSON: {"account_type": "Individual", "holdings": [ truncated garbage with no closing brace and nothing resembling a wrong-document explanation at all, just cut off mid';

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("preview", [{ name: "weird-response.pdf", content: "%PDF-fake" }]),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(
      (body.error as string).startsWith("Failed to parse Claude response as JSON:"),
    ).toBe(true);
  });

  it("an unrelated thrown error (not the parser's shape) still surfaces as a passthrough HTTP 500", async () => {
    hoisted.throwMessage = "ECONNREFUSED: could not reach Claude API";

    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("preview", [{ name: "statement.pdf", content: "%PDF-fake" }]),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("ECONNREFUSED: could not reach Claude API");
  });
});
