import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, listDocuments, listDocumentRoads } from "@/lib/print-watch/store";
import { _setTestSeams } from "@/lib/print-watch/watcher";
import { deliverFromUrl } from "@/lib/print-watch/roads";
import { UrlFetchRefused } from "@/lib/print-watch/url-fetch";

let db: Database.Database;
let printId: number;
let tmpRoot: string;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const eventId = Number(
    db.prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings','2026-08-26','ACME','k','ACME')`).run().lastInsertRowid,
  );
  printId = upsertPrint(db, eventId, "ACME", "2026-08-26", "16:05");
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roads-"));
  _setTestSeams({ storageRoot: () => tmpRoot, extractCandidates: async () => [] });
});
afterEach(() => {
  _setTestSeams(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("deliverFromUrl", () => {
  it("refuses a non-public URL before fetching", async () => {
    const fetchBytes = vi.fn();
    const out = await deliverFromUrl(db, printId, "http://ir.example/x", { fetchBytes });
    expect(out).toMatchObject({ road: "user-url", outcome: "refused", docId: null });
    expect(out.detail).toMatch(/https/);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it("fetches, ingests as user-url with a redacted source/url, and reports the ingest outcome", async () => {
    const fetchBytes = vi.fn(async () => ({
      bytes: Buffer.from("ACME reports Q2 2026 results. Revenue $1.0 billion."), finalUrl: "https://ir.example/x?token=S&id=9", status: 200, contentType: "text/plain",
    }));
    const out = await deliverFromUrl(db, printId, "https://ir.example/x?token=S&id=9", { fetchBytes });
    expect(out).toMatchObject({ road: "user-url", outcome: "parsed", isNew: true });
    const [doc] = listDocuments(db, printId);
    expect(doc.kind).toBe("user-url");
    expect(doc.url).toBe("https://ir.example/x?id=9");
    expect(doc.source).toMatch(/^user-url:[0-9a-f]{16}$/); // M19: identity by hash of the full URL
    expect(listDocumentRoads(db, printId)[0].url).toBe("https://ir.example/x?id=9");
    expect(JSON.stringify(out)).not.toContain("token=S");
    expect(JSON.stringify(listDocumentRoads(db, printId))).not.toContain("token=S");
  });

  it("reports a fetch refusal (403 with the hint) as fetch_failed without a document", async () => {
    const fetchBytes = vi.fn(async () => { throw new UrlFetchRefused("t: HTTP 403 for https://wire.example/s — wire syndicators often block direct fetches — paste the company's IR-site link or the EDGAR exhibit instead", 403); });
    const out = await deliverFromUrl(db, printId, "https://wire.example/s", { fetchBytes });
    expect(out).toMatchObject({ road: "user-url", outcome: "fetch_failed", docId: null });
    expect(out.detail).toMatch(/IR-site link or the EDGAR exhibit/);
    expect(listDocuments(db, printId)).toEqual([]);
  });

  it("reports a binary body as refused", async () => {
    const fetchBytes = vi.fn(async () => ({ bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), finalUrl: "https://ir.example/z.zip", status: 200, contentType: "application/zip" }));
    const out = await deliverFromUrl(db, printId, "https://ir.example/z.zip", { fetchBytes });
    expect(out).toMatchObject({ outcome: "refused", docId: null });
    expect(out.detail).toMatch(/binary/);
  });
});
