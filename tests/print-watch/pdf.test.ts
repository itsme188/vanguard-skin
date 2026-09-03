/**
 * The PDF road's pure pieces (Task 10): the byte/text refusal checks, poppler
 * resolution, and the `pdftotext` child-process wrapper.
 *
 * NOTHING here spawns a real poppler. `runPdftotext` takes a DI spawn seam
 * (same function-boundary convention as the watcher's own seams), so the
 * timeout, the output cap and the encrypted-PDF classification are all
 * exercised against a fake child that emits exactly what the test scripts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runMigrations } from "@/lib/db/migrate";
import {
  isPdf,
  checkPdfBytes,
  checkPdfText,
  resolvePdftotextPath,
  runPdftotext,
  textPathFor,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  PDF_MIN_TEXT_CHARS,
  PDFTOTEXT_SETTING_KEY,
  PDFTOTEXT_STDERR_CAP,
  PdfEncryptedError,
} from "@/lib/print-watch/pdf";

/**
 * A scripted stand-in for `child_process.spawn`.
 *
 * `close` is emitted one turn AFTER the streams are written and ended, which
 * is what a real child does (node emits 'close' once the process has exited
 * AND its stdio streams have closed). Emitting it in the same turn as the
 * writes would race the streams' own 'data' delivery and let a cap breach go
 * unnoticed.
 */
function fakeSpawn(script: { stdout?: string; stderr?: string; code?: number; hang?: boolean }) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const killed: number[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed.push(1);
      setImmediate(() => child.emit("close", null));
    };
    if (!script.hang) {
      setImmediate(() => {
        if (script.stdout) child.stdout.write(script.stdout);
        if (script.stderr) child.stderr.write(script.stderr);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", script.code ?? 0));
      });
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls, killed };
}

describe("pdf.ts — byte and text checks", () => {
  it("isPdf sniffs the %PDF- signature", () => {
    expect(isPdf(Buffer.from("%PDF-1.7\n"))).toBe(true);
    expect(isPdf(Buffer.from("<html>"))).toBe(false);
  });

  it("refuses an oversize PDF with its own message", () => {
    expect(checkPdfBytes(Buffer.alloc(PDF_MAX_BYTES + 1, 0x20))).toEqual({
      ok: false,
      reason: expect.stringMatching(/10MB/),
    });
    expect(checkPdfBytes(Buffer.from("%PDF-1.7 hello"))).toEqual({ ok: true });
  });

  // R-B15: an /Encrypt entry is NOT "needs a password". The common case is an
  // owner-password-only PDF — permission flags, EMPTY user password — which
  // pdftotext reads happily, and IR departments publish releases like that.
  // Refusing on the byte pattern would tell the desk to "remove the password"
  // from a file that has none.
  it("does NOT refuse a permissions-only PDF on its /Encrypt bytes — poppler decides", async () => {
    const permissionsOnly = Buffer.from(
      "%PDF-1.7\ntrailer << /Encrypt 5 0 R /Root 1 0 R >>\n%%EOF\n",
    );
    expect(checkPdfBytes(permissionsOnly)).toEqual({ ok: true });

    // …and the whole chain proceeds: poppler extracts a real text layer from
    // it, which clears the image-only floor.
    const body = `ACME reports Q2 2026 results. ${"Segment detail line. ".repeat(40)}\f`;
    const { spawn } = fakeSpawn({ stdout: body });
    const text = await runPdftotext("/p", "/x/permissions-only.pdf", { spawn });
    expect(text).toBe(body);
    expect(text.replace(/\s+/g, "").length).toBeGreaterThanOrEqual(PDF_MIN_TEXT_CHARS);
    expect(checkPdfText(text)).toEqual({ ok: true });
  });

  it("a PDF that genuinely needs a password is refused by poppler, with the encryption message", async () => {
    // Each call consumes one scripted child, so this needs two.
    const locked = () => fakeSpawn({ stderr: "Command Line Error: Incorrect password", code: 1 }).spawn;
    await expect(
      runPdftotext("/p", "/x/locked.pdf", { spawn: locked() }),
    ).rejects.toBeInstanceOf(PdfEncryptedError);
    await expect(
      runPdftotext("/p", "/x/locked.pdf", { spawn: locked() }),
    ).rejects.toThrow(/encrypted/i);
  });

  it("refuses an image-only text layer and more than 60 pages", () => {
    expect(checkPdfText("a".repeat(PDF_MIN_TEXT_CHARS - 1))).toEqual({
      ok: false,
      reason: expect.stringMatching(/image-only|text layer/i),
    });
    expect(
      checkPdfText("a".repeat(PDF_MIN_TEXT_CHARS) + "\f".repeat(PDF_MAX_PAGES + 1)),
    ).toEqual({ ok: false, reason: expect.stringMatching(/60 pages/) });
    expect(checkPdfText("a".repeat(PDF_MIN_TEXT_CHARS) + "\f".repeat(3))).toEqual({ ok: true });
  });

  it("textPathFor places the text beside the bytes", () => {
    expect(textPathFor("/data/print-watch/7/abc.pdf")).toBe("/data/print-watch/7/abc.pdftext.txt");
  });
});

describe("resolvePdftotextPath", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("prefers settings.pdftotext_path, then the Homebrew and /usr/local paths, then PATH, else null", () => {
    const exists = (p: string) =>
      p === "/opt/homebrew/bin/pdftotext" || p === "/custom/pdftotext" || p === "/pathdir/pdftotext";
    expect(resolvePdftotextPath(db, { PATH: "/pathdir" }, exists)).toBe("/opt/homebrew/bin/pdftotext");
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      PDFTOTEXT_SETTING_KEY,
      "/custom/pdftotext",
    );
    expect(resolvePdftotextPath(db, { PATH: "/pathdir" }, exists)).toBe("/custom/pdftotext");
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(PDFTOTEXT_SETTING_KEY);
    expect(resolvePdftotextPath(db, { PATH: "/pathdir" }, (p) => p === "/pathdir/pdftotext")).toBe(
      "/pathdir/pdftotext",
    );
    expect(resolvePdftotextPath(db, { PATH: "/nowhere" }, () => false)).toBeNull();
  });
});

describe("runPdftotext", () => {
  it("invokes `pdftotext -layout -enc UTF-8 <file> -` and returns stdout", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "ACME Q2 2026\f" });
    await expect(runPdftotext("/opt/homebrew/bin/pdftotext", "/x/a.pdf", { spawn })).resolves.toBe(
      "ACME Q2 2026\f",
    );
    expect(calls[0]).toEqual({
      cmd: "/opt/homebrew/bin/pdftotext",
      args: ["-layout", "-enc", "UTF-8", "/x/a.pdf", "-"],
    });
  });

  it("classifies a password error as PdfEncryptedError and any other non-zero exit as a plain error", async () => {
    const enc = fakeSpawn({ stderr: "Command Line Error: Incorrect password", code: 1 });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: enc.spawn })).rejects.toBeInstanceOf(
      PdfEncryptedError,
    );
    const other = fakeSpawn({ stderr: "Syntax Error: Couldn't find trailer dictionary", code: 1 });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: other.spawn })).rejects.toThrow(/exited 1/);
  });

  it("kills the child on timeout and caps BOTH streams (stdout at maxBytes, stderr at 64KB)", async () => {
    const hung = fakeSpawn({ hang: true });
    await expect(
      runPdftotext("/p", "/x/a.pdf", { spawn: hung.spawn, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
    expect(hung.killed).toHaveLength(1);

    const big = fakeSpawn({ stdout: "x".repeat(2000) });
    await expect(
      runPdftotext("/p", "/x/a.pdf", { spawn: big.spawn, maxBytes: 1000 }),
    ).rejects.toThrow(/cap/);
    expect(big.killed).toHaveLength(1);

    const noisy = fakeSpawn({ stderr: "e".repeat(PDFTOTEXT_STDERR_CAP + 1), code: 0 });
    await expect(runPdftotext("/p", "/x/a.pdf", { spawn: noisy.spawn })).rejects.toThrow(
      /stderr exceeded/,
    );
    expect(noisy.killed).toHaveLength(1);
  });
});
