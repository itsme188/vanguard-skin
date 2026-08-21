/**
 * HTTP-boundary tests for the print-watch v1 status/ensure/drop routes
 * (Task 10). Pattern per tests/api/notes-route.test.ts: vi.mock the db
 * singleton with an in-memory migrated getter, NextRequest, dynamic import.
 *
 * The watcher module (lib/print-watch/watcher.ts) is mocked PARTIALLY — only
 * `ensurePrintWatch` is wrapped with a spy. Everything else (`getWatchStatus`,
 * `getSheet` via store, `ingestDocument`, `_setTestSeams`) runs for real, so
 * these tests exercise the actual read/ingest pipeline (with the parse call
 * itself stubbed via `_setTestSeams`, never a real Claude API call).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, setPrintState, getPrintByEventId } from "@/lib/print-watch/store";
import type { PrintWatchLine, LineStateKind } from "@/lib/print-watch/types";
import { _setTestSeams } from "@/lib/print-watch/watcher";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  ensureSpy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/print-watch/watcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/print-watch/watcher")>();
  return {
    ...actual,
    ensurePrintWatch: (db: Database.Database) => {
      hoisted.ensureSpy(db);
    },
  };
});

let tmpRoot: string;

function testLine(metricId: string, state: LineStateKind = "pending"): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId,
      definition: "test metric",
      basis: "gaap",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    },
    expected: null,
    state,
    value: null,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
  };
}

/** Mirrors tests/api/no-state-changing-get.test.ts's own extractGetBody —
 *  the durable repo-wide scan reads GET bodies the same way; this test
 *  narrows that same technique to just this file, so a top-of-file doc
 *  comment mentioning "ensure*" (explaining why the split matters) can't
 *  make the check moot. */
function extractGetBody(source: string): string {
  const sigMatch = /export\s+(?:async\s+)?function\s+GET\s*\(/m.exec(source);
  if (!sigMatch) throw new Error("no GET export found in source");
  let i = sigMatch.index + sigMatch[0].length;
  let depthParen = 1;
  while (i < source.length && depthParen > 0) {
    const c = source[i];
    if (c === "(") depthParen++;
    else if (c === ")") depthParen--;
    i++;
  }
  const braceIdx = source.indexOf("{", i);
  if (braceIdx === -1) throw new Error("no opening brace found after GET(...)");
  let depth = 0;
  const start = braceIdx;
  for (let j = braceIdx; j < source.length; j++) {
    const c = source[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, j);
    }
  }
  throw new Error("unbalanced braces in GET body");
}

function dropReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/print-watch/drop", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.ensureSpy.mockClear();

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "print-watch-route-test-"));
  _setTestSeams({
    storageRoot: () => tmpRoot,
    extractCandidates: async () => [],
  });
});

afterEach(() => {
  _setTestSeams(null);
  hoisted.db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/print-watch/status
// ---------------------------------------------------------------------------

describe("GET /api/print-watch/status", () => {
  it("returns each active print's status merged with its sheet lines", async () => {
    const printId = upsertPrint(hoisted.db, 501, "ACME", "2026-08-26", "16:15");
    upsertLines(hoisted.db, printId, [testLine("eps_gaap_q"), testLine("eps_adj_q", "flash")]);

    const mod = await import("@/app/api/print-watch/status/route");
    const res = await mod.GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.prints).toHaveLength(1);

    const row = body.data.prints[0];
    expect(row.printId).toBe(printId);
    // POST /accept and POST /drop both key on eventId, not printId — the
    // panel's mutating controls are dead without this on every row.
    expect(row.eventId).toBe(501);
    expect(row.symbol).toBe("ACME");
    expect(row.state).toBe("scheduled");
    expect(row.sources).toEqual({});
    expect(row.coverage).toEqual([]);
    expect(row.lines).toHaveLength(2);

    // Flash lines carry source_doc_id: null — serialized as-is.
    const flashLine = row.lines.find((l: PrintWatchLine) => l.metric_id === "eps_adj_q");
    expect(flashLine.state).toBe("flash");
    expect(flashLine.source_doc_id).toBeNull();

    expect(hoisted.ensureSpy).not.toHaveBeenCalled();
  });

  it("omits prints that are no longer active (disarmed)", async () => {
    const printId = upsertPrint(hoisted.db, 502, "WXYZ", "2026-08-20", "08:00");
    setPrintState(hoisted.db, printId, "disarmed");

    const mod = await import("@/app/api/print-watch/status/route");
    const res = await mod.GET();
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.prints).toEqual([]);
    expect(hoisted.ensureSpy).not.toHaveBeenCalled();
  });

  it("returns an empty list, calling no watcher mutator, when nothing is armed", async () => {
    const mod = await import("@/app/api/print-watch/status/route");
    const res = await mod.GET();
    const body = await res.json();

    expect(body).toEqual({ success: true, data: { prints: [] } });
    expect(hoisted.ensureSpy).not.toHaveBeenCalled();
  });

  it("GET body contains no `ensure` token (mirror of the repo's static no-state-changing-GET scan)", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/print-watch/status/route.ts"),
      "utf8",
    );
    const getBody = extractGetBody(source);
    expect(/ensure/i.test(getBody)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/print-watch/ensure
// ---------------------------------------------------------------------------

describe("POST /api/print-watch/ensure", () => {
  it("invokes the watcher reconciler and returns the active-print count", async () => {
    upsertPrint(hoisted.db, 601, "NVDA", "2026-08-26", "16:15");
    upsertPrint(hoisted.db, 602, "CRWD", "2026-08-27", "16:15");

    const mod = await import("@/app/api/print-watch/ensure/route");
    const res = await mod.POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ prints: 2 });

    expect(hoisted.ensureSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureSpy).toHaveBeenCalledWith(hoisted.db);
  });

  it("returns a zero count when nothing is armed", async () => {
    const mod = await import("@/app/api/print-watch/ensure/route");
    const res = await mod.POST();
    const body = await res.json();

    expect(body).toEqual({ success: true, data: { prints: 0 } });
    expect(hoisted.ensureSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/print-watch/drop
// ---------------------------------------------------------------------------

describe("POST /api/print-watch/drop", () => {
  it("ingests a valid HTML drop through the real pipeline", async () => {
    upsertPrint(hoisted.db, 701, "ACME", "2026-08-26", "16:15");
    const html =
      "<html><body><h1>ACME Reports Second Quarter 2026 Results</h1></body></html>";

    const mod = await import("@/app/api/print-watch/drop/route");
    const res = await mod.POST(
      dropReq({
        eventId: 701,
        filename: "acme-q2-2026.html",
        contentBase64: Buffer.from(html, "utf8").toString("base64"),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.docId).toBe("number");
    expect(body.data.isNew).toBe(true);

    const printId = getPrintByEventId(hoisted.db, 701)!.id;
    const docs = hoisted.db
      .prepare(`SELECT kind, source FROM print_watch_documents WHERE print_id = ?`)
      .all(printId) as Array<{ kind: string; source: string }>;
    expect(docs).toHaveLength(1);
    expect(docs[0].kind).toBe("user-drop");
    expect(docs[0].source).toBe("user-drop:acme-q2-2026.html");

    // The doc passed the gate and ran through the (stubbed) parse — the
    // print advances past "scheduled".
    expect(getPrintByEventId(hoisted.db, 701)!.state).toBe("parsed");
  });

  it("ingests a valid plain-text drop (not HTML, not PDF) through the same pipeline", async () => {
    upsertPrint(hoisted.db, 704, "ACME", "2026-08-26", "16:15");
    const text = "ACME Reports Second Quarter 2026 Results\nRevenue grew year over year.";

    const mod = await import("@/app/api/print-watch/drop/route");
    const res = await mod.POST(
      dropReq({
        eventId: 704,
        filename: "release.txt",
        contentBase64: Buffer.from(text, "utf8").toString("base64"),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("400s an oversized base64 payload BEFORE any decode is attempted", async () => {
    upsertPrint(hoisted.db, 702, "ACME", "2026-08-26", "16:15");
    const oversized = "A".repeat(14 * 1024 * 1024 + 1);

    const fromSpy = vi.spyOn(Buffer, "from");
    try {
      const mod = await import("@/app/api/print-watch/drop/route");
      const res = await mod.POST(
        dropReq({ eventId: 702, filename: "huge.html", contentBase64: oversized }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/too large/i);

      // The route's own decode call — Buffer.from(contentBase64, "base64")
      // — must never run: filtering to calls whose first arg is literally
      // the oversized string rules out unrelated Buffer.from noise from
      // other machinery in the request path.
      const decodeCalls = fromSpy.mock.calls.filter((call) => call[0] === oversized);
      expect(decodeCalls).toHaveLength(0);

      // Nothing was stored — the request was refused before touching ingest.
      const printId = getPrintByEventId(hoisted.db, 702)!.id;
      const docCount = (
        hoisted.db
          .prepare(`SELECT COUNT(*) AS n FROM print_watch_documents WHERE print_id = ?`)
          .get(printId) as { n: number }
      ).n;
      expect(docCount).toBe(0);
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("rejects a PDF drop with the domain-language save-as-HTML message", async () => {
    upsertPrint(hoisted.db, 703, "ACME", "2026-08-26", "16:15");
    const pdfBuf = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n", "latin1");

    const mod = await import("@/app/api/print-watch/drop/route");
    const res = await mod.POST(
      dropReq({
        eventId: 703,
        filename: "release.pdf",
        contentBase64: pdfBuf.toString("base64"),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("⌘S");
    expect(body.error.toLowerCase()).toContain("pdf");

    const printId = getPrintByEventId(hoisted.db, 703)!.id;
    const docCount = (
      hoisted.db
        .prepare(`SELECT COUNT(*) AS n FROM print_watch_documents WHERE print_id = ?`)
        .get(printId) as { n: number }
    ).n;
    expect(docCount).toBe(0);
  });

  it("400s when a required field is missing", async () => {
    const mod = await import("@/app/api/print-watch/drop/route");
    const res = await mod.POST(dropReq({ filename: "x.html", contentBase64: "aGVsbG8=" }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeTruthy();
  });

  it("404s when no print-watch entry exists for the given eventId", async () => {
    const mod = await import("@/app/api/print-watch/drop/route");
    const res = await mod.POST(
      dropReq({
        eventId: 9999,
        filename: "x.html",
        contentBase64: Buffer.from("<p>hi</p>", "utf8").toString("base64"),
      }),
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/9999/);
  });
});
