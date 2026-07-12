/**
 * GET /api/transcripts — read-boundary entity decoding.
 *
 * Regression pin for the deep-QA finding
 * research-notes-transcript-modal--earnings-transcript-renders-raw-html-entities:
 * earnings_transcripts rows cached BEFORE the fetch-time decoder existed
 * (decodeFilingEntities in lib/apis/edgar.ts) still carry raw numeric
 * references (&#160; / &#744;) in their stored transcript text. The route
 * must decode at read time so legacy rows self-heal without a migration —
 * both the Security Detail transcript viewer and the Research → Notes
 * "View Full Transcript" modal render this payload verbatim.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET } from "@/app/api/transcripts/route";

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3099${url}`);
}

describe("GET /api/transcripts (cached transcript entity decoding)", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    runMigrations(hoisted.db);

    hoisted.db
      .prepare(
        `INSERT INTO earnings_transcripts
           (ticker, year, quarter, source, transcript, summary, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "RBRK",
        2026,
        1,
        "edgar_8k",
        // Legacy row: stored pre-decoder, raw numeric entities intact
        "Date of Report (date of earliest event reported): March&#160;12, 2026\n" +
          "&#9744; Written communications pursuant to Rule 425 &amp; more",
        "Q1 summary",
        "edgar:RBRK:2026:1"
      );
  });

  it("decodes legacy raw HTML entities in the stored transcript at read time", async () => {
    const res = await GET(
      makeRequest("/api/transcripts?ticker=RBRK&year=2026&quarter=1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.transcript).toContain("March 12, 2026");
    expect(body.data.transcript).toContain("☐ Written communications");
    expect(body.data.transcript).toContain("Rule 425 & more");
    expect(body.data.transcript).not.toMatch(/&#\d+;/);
  });

  it("passes through already-clean transcripts unchanged (decoder is a no-op)", async () => {
    hoisted.db
      .prepare(
        `INSERT INTO earnings_transcripts
           (ticker, year, quarter, source, transcript, source_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "AAPL",
        2026,
        2,
        "api_ninjas",
        "Operator: Good afternoon. Tim Cook: Thanks, everyone.",
        "ninjas:AAPL:2026:2"
      );

    const res = await GET(
      makeRequest("/api/transcripts?ticker=AAPL&year=2026&quarter=2")
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.transcript).toBe(
      "Operator: Good afternoon. Tim Cook: Thanks, everyone."
    );
  });

  it("returns 404 for an uncached quarter", async () => {
    const res = await GET(
      makeRequest("/api/transcripts?ticker=RBRK&year=2020&quarter=1")
    );
    expect(res.status).toBe(404);
  });
});
