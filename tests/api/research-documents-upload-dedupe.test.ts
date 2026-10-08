/**
 * A20 + B33 at the route: POST /api/research/documents
 *   - refuses an exact re-upload BEFORE either AI call (owner ruling
 *     2026-08-31), naming the existing document;
 *   - never sends a raw provider error body, a request id or an internal
 *     diagnostic to the client.
 * GET returns the symbol -> security id map the cards link through.
 * Synthetic file names, bytes and symbols only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  metadata: vi.fn(),
  rawText: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));
vi.mock("@/lib/research-documents/extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research-documents/extract")>();
  return {
    ...actual,
    extractResearchMetadata: hoisted.metadata,
    extractResearchRawText: hoisted.rawText,
  };
});

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/research/documents/route";
import {
  ResearchPdfExtractionError,
  RESEARCH_PDF_NO_READABLE_OUTPUT_MESSAGE,
} from "@/lib/research-documents/extract";

let db: Database.Database;

function upload(name: string, content: string): NextRequest {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "application/pdf" }));
  return new NextRequest("http://localhost/api/research/documents", { method: "POST", body: form });
}

function metadataFor(title: string) {
  return {
    title,
    author: null,
    source: null,
    document_type: "other",
    publication_date: null,
    summary: null,
    key_points: [],
    mentioned_symbols: ["AAA", "ZZZ"],
    tags: [],
    sentiment: null,
    target_prices: [],
    ai_model: "test-model",
  };
}

const docCount = () =>
  (db.prepare(`SELECT COUNT(*) c FROM research_documents`).get() as { c: number }).c;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  hoisted.db = db;
  hoisted.metadata.mockReset();
  hoisted.rawText.mockReset();
  hoisted.metadata.mockResolvedValue(metadataFor("Synthetic Outlook"));
  hoisted.rawText.mockResolvedValue("full body text");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST: exact re-upload", () => {
  it("stores the first upload, refuses the second with 409 naming the first, and spends no second AI call", async () => {
    const first = await POST(upload("outlook.pdf", "same bytes"));
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await POST(upload("outlook.pdf", "same bytes"));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("duplicate_document");
    expect(body.existing_id).toBe(firstBody.id);
    expect(body.error).toContain('"Synthetic Outlook"');
    expect(body.error).toMatch(/uploaded \d{4}-\d{2}-\d{2}/);
    expect(body.error).toMatch(/nothing was uploaded/i);

    expect(docCount()).toBe(1);
    expect(hoisted.metadata).toHaveBeenCalledTimes(1);
    expect(hoisted.rawText).toHaveBeenCalledTimes(1);
  });

  it("refuses the same bytes under a different filename", async () => {
    await POST(upload("outlook.pdf", "same bytes"));
    const res = await POST(upload("outlook (1).pdf", "same bytes"));
    expect(res.status).toBe(409);
    expect(docCount()).toBe(1);
    expect(hoisted.metadata).toHaveBeenCalledTimes(1);
  });

  it("accepts a different file", async () => {
    await POST(upload("outlook.pdf", "same bytes"));
    hoisted.metadata.mockResolvedValue(metadataFor("Second Synthetic Note"));
    const res = await POST(upload("outlook.pdf", "other bytes"));
    expect(res.status).toBe(200);
    expect(docCount()).toBe(2);
  });

  it("refuses a second drop of the same file while the first is still being read", async () => {
    let finish: (v: unknown) => void = () => {};
    hoisted.metadata.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const firstPending = POST(upload("outlook.pdf", "same bytes"));
    // Let the first request reach its AI call.
    await vi.waitFor(() => expect(hoisted.metadata).toHaveBeenCalledTimes(1));

    const second = await POST(upload("outlook.pdf", "same bytes"));
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.code).toBe("upload_in_progress");
    expect(body.error).toMatch(/already being processed/i);
    expect(hoisted.metadata).toHaveBeenCalledTimes(1);

    finish(metadataFor("Synthetic Outlook"));
    expect((await firstPending).status).toBe(200);
    expect(docCount()).toBe(1);
  });

  it("falls back to filename + size for a document stored before hashing", async () => {
    db.prepare(
      `INSERT INTO research_documents (title, filename, file_size_bytes, raw_text)
       VALUES ('Legacy Synthetic Note', 'legacy.pdf', ?, 'body')`,
    ).run("same bytes".length);
    const res = await POST(upload("legacy.pdf", "same bytes"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('"Legacy Synthetic Note"');
    expect(body.error).toMatch(/name and size/i);
    expect(body.error).toMatch(/rename/i);
    expect(hoisted.metadata).not.toHaveBeenCalled();
  });

  it("tells the user to delete a document whose extraction failed before retrying", async () => {
    hoisted.rawText.mockRejectedValue(new Error("body extraction died"));
    const first = await POST(upload("outlook.pdf", "same bytes"));
    const { id } = await first.json();
    await vi.waitFor(() =>
      expect(
        db.prepare(`SELECT processing_state s FROM research_documents WHERE id = ?`).get(id),
      ).toEqual({ s: "failed" }),
    );
    const res = await POST(upload("outlook.pdf", "same bytes"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/extraction failed\. Delete that document/i);
  });

  it("a failed first attempt does not block trying the same file again", async () => {
    hoisted.metadata.mockRejectedValueOnce(
      new ResearchPdfExtractionError("The AI service is temporarily overloaded. Try again in a minute.", ""),
    );
    const failed = await POST(upload("outlook.pdf", "same bytes"));
    expect(failed.status).toBe(502);
    expect(docCount()).toBe(0);

    const retry = await POST(upload("outlook.pdf", "same bytes"));
    expect(retry.status).toBe(200);
    expect(docCount()).toBe(1);
  });
});

describe("POST: a failed AI call surfaces a plain sentence", () => {
  it("a model answer with no text is 422, the plain copy, and no snippet key", async () => {
    hoisted.metadata.mockRejectedValue(
      new ResearchPdfExtractionError(RESEARCH_PDF_NO_READABLE_OUTPUT_MESSAGE, "", "unusable_output"),
    );
    const res = await POST(upload("scan.pdf", "image only"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe(RESEARCH_PDF_NO_READABLE_OUTPUT_MESSAGE);
    expect("snippet" in body).toBe(false);
  });

  it("an upstream failure stays 502 and sends no empty snippet", async () => {
    hoisted.metadata.mockRejectedValue(
      new ResearchPdfExtractionError("The AI service is temporarily overloaded. Try again in a minute.", ""),
    );
    const res = await POST(upload("a.pdf", "bytes"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect("snippet" in body).toBe(false);
  });

  it("keeps a real model-output snippet", async () => {
    hoisted.metadata.mockRejectedValue(
      new ResearchPdfExtractionError("Metadata response was not valid JSON.", "Here is a summary", "unusable_output"),
    );
    const res = await POST(upload("a.pdf", "bytes"));
    expect(res.status).toBe(422);
    expect((await res.json()).snippet).toBe("Here is a summary");
  });

  it("never forwards an unclassified error's message (raw provider body, request id, key)", async () => {
    const raw =
      '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CdSYNTHETIC"} x-api-key: sk-ant-synthetic';
    hoisted.metadata.mockRejectedValue(new Error(raw));
    const res = await POST(upload("a.pdf", "bytes"));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("req_011CdSYNTHETIC");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain('\\"type\\"');
    expect(text).toMatch(/could not be processed/i);
    expect(text).toMatch(/nothing was saved/i);
  });
});

describe("GET: symbol map", () => {
  it("maps mentioned symbols that are known securities, case-insensitively, and omits the rest", async () => {
    const aaa = Number(
      db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'Alpha Co', 'Stock')`).run()
        .lastInsertRowid,
    );
    await POST(upload("outlook.pdf", "same bytes")); // mentions AAA and ZZZ
    const res = await GET(new NextRequest("http://localhost/api/research/documents"));
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.symbolMap).toEqual({ AAA: aaa });
  });

  it("returns an empty map when no document mentions a symbol", async () => {
    const res = await GET(new NextRequest("http://localhost/api/research/documents"));
    expect((await res.json()).symbolMap).toEqual({});
  });
});
