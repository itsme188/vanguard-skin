import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { ingestForwardedDocuments, type IngestDeps } from "@/lib/research-inbox/ingest";
import { recordInboxMessage } from "@/lib/mutations/research-inbox";
import type { ParsedForwardedEmail } from "@/lib/research-inbox/classify";
import type { ExtractedResearchDocument } from "@/lib/research-documents/extract";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function doc(title: string): ExtractedResearchDocument {
  return {
    title,
    author: null,
    source: "Stratechery",
    document_type: "article",
    publication_date: null,
    summary: "s",
    key_points: ["k1"],
    mentioned_symbols: ["NVDA"],
    tags: ["ai"],
    sentiment: "bullish",
    target_prices: [],
    ai_model: "claude-test",
    raw_text: "the body text",
  };
}

function email(p: Partial<ParsedForwardedEmail>): ParsedForwardedEmail {
  return { subject: "fwd", from: "me@x.com", bodyText: "", attachments: [], ...p };
}

function baseDeps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    listMessageIds: async () => [],
    getEmail: async () => email({ bodyText: "x" }),
    extractPdf: async () => doc("pdf"),
    extractImage: async () => doc("image"),
    extractUrl: async () => doc("url"),
    extractText: async () => doc("body"),
    ...overrides,
  };
}

function docCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM research_documents").get() as { c: number }).c;
}

describe("ingestForwardedDocuments", () => {
  it("creates a document for a forwarded long-read body and records the message done", async () => {
    const long = "Lorem ipsum ".repeat(40);
    const deps = baseDeps({
      listMessageIds: async () => ["m1"],
      getEmail: async () => email({ bodyText: long }),
    });
    const res = await ingestForwardedDocuments(db, deps);

    expect(res.ingested).toBe(1);
    expect(docCount()).toBe(1);
    const row = db.prepare("SELECT * FROM research_inbox_messages WHERE gmail_message_id='m1'").get() as Record<string, unknown>;
    expect(row.status).toBe("done");
    expect(row.document_count).toBe(1);
    // forwarded tag applied
    const tags = db.prepare("SELECT tags FROM research_documents LIMIT 1").get() as { tags: string };
    expect(JSON.parse(tags.tags)).toContain("forwarded");
  });

  it("skips a message already in research_inbox_messages (dedup)", async () => {
    recordInboxMessage(db, { gmail_message_id: "m1", status: "done", document_count: 1 });
    const deps = baseDeps({ listMessageIds: async () => ["m1"] });
    const res = await ingestForwardedDocuments(db, deps);
    expect(res.skipped).toBe(1);
    expect(res.ingested).toBe(0);
    expect(docCount()).toBe(0);
  });

  it("records a failed message without throwing and continues to the next", async () => {
    const deps = baseDeps({
      listMessageIds: async () => ["bad", "good"],
      getEmail: async (id) => email({ bodyText: id === "bad" ? "x".repeat(300) : "y".repeat(300) }),
      extractText: async (text) => {
        if (text.startsWith("x")) throw new Error("extractor boom");
        return doc("good");
      },
    });
    const res = await ingestForwardedDocuments(db, deps);
    expect(res.failed).toBe(1);
    expect(res.ingested).toBe(1);
    const bad = db.prepare("SELECT status, error FROM research_inbox_messages WHERE gmail_message_id='bad'").get() as { status: string; error: string };
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("boom");
  });

  it("routes an image attachment to extractImage with the right media type", async () => {
    let seenMedia = "";
    const deps = baseDeps({
      listMessageIds: async () => ["m1"],
      getEmail: async () =>
        email({ attachments: [{ filename: "shot.jpg", mimeType: "image/jpeg", bytes: new Uint8Array([1]) }] }),
      extractImage: async (_b, media) => {
        seenMedia = media;
        return doc("img");
      },
    });
    await ingestForwardedDocuments(db, deps);
    expect(seenMedia).toBe("image/jpeg");
    expect(docCount()).toBe(1);
  });

  it("creates one document per attachment (two PDFs → two docs)", async () => {
    const deps = baseDeps({
      listMessageIds: async () => ["m1"],
      getEmail: async () =>
        email({
          attachments: [
            { filename: "a.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) },
            { filename: "b.pdf", mimeType: "application/pdf", bytes: new Uint8Array([2]) },
          ],
        }),
    });
    const res = await ingestForwardedDocuments(db, deps);
    expect(res.ingested).toBe(2);
    expect(docCount()).toBe(2);
  });
});
