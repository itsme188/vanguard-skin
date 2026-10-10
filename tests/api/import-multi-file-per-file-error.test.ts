/**
 * QA: import-multi-file-drop--one-unreadable-pdf-discards-all-other-previews.
 *
 * POST /api/import loops over every dropped file. A parser that THROWS for one
 * file (e.g. the Vanguard PDF parser's "Failed to parse Claude response as
 * JSON: This document is not a Vanguard brokerage statement ..." error) must
 * be recorded as a per-file failure, the same way a parser that RETURNS
 * sourceType "unknown" already is — the other files still preview (or
 * commit). When every file threw, the response is unchanged from the old
 * single-file contract pinned by tests/api/import-pdf-wrong-format-error.test.ts
 * (400 for a wrong-document explanation, 500 otherwise).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import type { ParsedImportResult } from "@/lib/import/types";

const WRONG_DOC =
  "Failed to parse Claude response as JSON: This document is not a Vanguard brokerage statement — it appears to be an unrelated PDF with no account information.";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  throwMessage: "",
  parsedNames: [] as string[],
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
    parseImport: vi.fn(async (_content: string | Buffer, filename: string) => {
      hoisted.parsedNames.push(filename);
      if (filename.startsWith("bad")) throw new Error(hoisted.throwMessage);
      if (filename.startsWith("unknown")) {
        const unknown: ParsedImportResult = {
          sourceType: "unknown",
          sourceName: filename,
          transactions: [],
          securities: [],
          holdings: [],
          prices: [],
          snapshots: [],
          corporateActions: [],
          errors: ["Unrecognized file format"],
          warnings: [],
        };
        return unknown;
      }
      const ok: ParsedImportResult = {
        sourceType: "canonical-csv",
        sourceName: filename,
        transactions: [],
        securities: [],
        holdings: [],
        prices: [],
        snapshots: [],
        corporateActions: [],
        errors: [],
        warnings: [],
      };
      return ok;
    }),
  };
});

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.parsedNames = [];
  hoisted.throwMessage = WRONG_DOC;
});

function importReq(mode: "preview" | "commit", names: string[]): NextRequest {
  const fd = new FormData();
  for (const name of names) {
    const type = name.endsWith(".pdf") ? "application/pdf" : "text/csv";
    fd.append("files", new File(["synthetic"], name, { type }));
  }
  return new NextRequest(`http://test/api/import?mode=${mode}`, {
    method: "POST",
    body: fd,
  });
}

interface FileResult {
  filename: string;
  success: boolean;
  error?: string;
}

describe("POST /api/import — one thrown file does not discard the others", () => {
  it("preview of [good, bad, good] answers 200 with three per-file results", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(
      importReq("preview", ["good.csv", "bad.pdf", "good2.csv"]),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const results = body.results as FileResult[];
    expect(results.map((r) => r.filename)).toEqual(["good.csv", "bad.pdf", "good2.csv"]);
    expect(results[0].success).toBe(true);
    expect(results[2].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(
      results[1].error!.startsWith(
        "This file doesn't look like a Vanguard brokerage statement.",
      ),
    ).toBe(true);
    expect(results[1].error).not.toContain("Failed to parse Claude response as JSON");
    // The file after the bad one was still parsed.
    expect(hoisted.parsedNames).toEqual(["good.csv", "bad.pdf", "good2.csv"]);
  });

  it("a thrown file beside an unknown-format file answers 200 with both failures listed", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", ["bad.pdf", "unknown.txt"]));

    expect(res.status).toBe(200);
    const body = await res.json();
    const results = body.results as FileResult[];
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success === false)).toBe(true);
    expect(results[1].error).toBe("Unrecognized file format");
  });

  it("preview of only [bad.pdf] still answers 400 with the domain-first message", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", ["bad.pdf"]));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(
      (body.error as string).startsWith(
        "This file doesn't look like a Vanguard brokerage statement.",
      ),
    ).toBe(true);
  });

  it("preview of only [bad.pdf] throwing an unrelated error still answers 500", async () => {
    hoisted.throwMessage = "ECONNREFUSED: could not reach Claude API";
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", ["bad.pdf"]));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("ECONNREFUSED: could not reach Claude API");
  });

  it("when every file throws, the first thrown error decides the response", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("preview", ["bad.pdf", "bad2.pdf"]));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(hoisted.parsedNames).toEqual(["bad.pdf", "bad2.pdf"]);
  });

  it("commit of [good, bad] keeps the good file's committed result", async () => {
    const mod = await import("@/app/api/import/route");
    const res = await mod.POST(importReq("commit", ["good.csv", "bad.pdf"]));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const results = body.results as FileResult[];
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(
      results[1].error!.startsWith(
        "This file doesn't look like a Vanguard brokerage statement.",
      ),
    ).toBe(true);
  });
});
