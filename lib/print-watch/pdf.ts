/**
 * The PDF road's first reading (spec §4.2 "PDF").
 *
 * Reading ONE is poppler's `pdftotext -layout`, driven through a DI spawn
 * seam — the same function-boundary seam convention the rest of this
 * subsystem uses (`lib/print-watch/watcher.ts`'s `WatcherSeams`,
 * `lib/earnings/worksheet.ts`'s `seams.printPdf`), so every timeout, cap and
 * failure classification below is exercised by unit tests without a real
 * child process ever being spawned. Reading TWO lives in `extract.ts`
 * (`extractCandidatesFromPdf` — the bytes themselves as a Claude `document`
 * block).
 *
 * BOTH readings are WEAK until the holdout pre-registered in
 * `docs/DECISIONS.md` (2026-09-02) passes, so a PDF on its own can never
 * green a line. Nothing in this file depends on that; it is recorded here
 * because it is the reason the road exists in this shape.
 *
 * WHAT IS REFUSED, AND WHY EACH HAS ITS OWN MESSAGE (plan M14). A refusal is
 * the desk's only signal about a file it just dropped, so "we can't read
 * this" is never good enough: an encrypted PDF needs a password removed, an
 * image-only scan needs a different file entirely, a 300-page 10-K is the
 * wrong document, and a missing poppler is a machine problem the user can
 * fix in one `brew install`. Page count and encryption both come from
 * pdftotext ITSELF rather than a hand-rolled PDF parser — see
 * `checkPdfBytes` for why the tempting `/Encrypt` byte scan is not a
 * refusal.
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
// Deliberately NOT NodeJS.ProcessEnv — Next augments that type with a REQUIRED
// NODE_ENV, so a test could not pass a small literal env object (the same
// reason lib/db/db-path.ts declares this shape).
import type { EnvLike } from "@/lib/db/db-path";
import { MAX_RESPONSE_BYTES } from "./hardened-fetch";

export const PDF_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_PAGES = 60;
export const PDF_MIN_TEXT_CHARS = 500;
export const PDFTOTEXT_TIMEOUT_MS = 30_000;
/** Both child streams are bounded (M14): stdout at the 2MB document cap, stderr here. */
export const PDFTOTEXT_STDERR_CAP = 64 * 1024;
export const PDFTOTEXT_SETTING_KEY = "pdftotext_path";
export const PDFTOTEXT_CANDIDATES = ["/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"];

export type PdfCheck = { ok: true } | { ok: false; reason: string };

/** Poppler is not installed (or the configured path is gone) — a machine
 *  problem, told apart from a bad file so the copy can name the fix. */
export class PdfToolMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfToolMissingError";
  }
}

/** The PDF is password-protected. Its own class because the remedy (remove
 *  the password) is nothing like "drop a different file". */
export class PdfEncryptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfEncryptedError";
  }
}

export function isPdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * The one check that costs nothing and runs BEFORE the bytes are written or
 * poppler is spawned: size.
 *
 * ENCRYPTION IS DELIBERATELY NOT CHECKED HERE (R-B15). An `/Encrypt` entry in
 * the trailer is NOT the same thing as "you need a password to read this":
 * the common case in the wild is an OWNER-password-only PDF — permission
 * flags saying "no printing, no copying" with an EMPTY user password — which
 * `pdftotext` opens and extracts without complaint. IR departments publish
 * releases with exactly those restrictions. Refusing on the byte pattern
 * would turn one of those into "remove the password and drop it again" in the
 * middle of a print, advice the desk cannot act on because there is no
 * password to remove.
 *
 * So poppler is the authority, as plan M14 says it is: a PDF that genuinely
 * needs a user password makes `pdftotext` exit non-zero with a password
 * error, and `runPdftotext` classifies that into `PdfEncryptedError` with the
 * message this function used to guess at. The byte scan would also have been
 * incomplete in the other direction — an encryption dictionary hidden in an
 * object stream never matches it.
 */
export function checkPdfBytes(buf: Buffer): PdfCheck {
  if (buf.length > PDF_MAX_BYTES) {
    return { ok: false, reason: "PDF is larger than 10MB — print-watch accepts releases up to 10MB" };
  }
  return { ok: true };
}

/**
 * Checks on poppler's OUTPUT. Pages are counted by form feeds, which is what
 * `pdftotext` emits between pages. The character floor is measured on
 * non-whitespace, so a scanned release whose "text layer" is nothing but
 * page breaks and stray marks is refused rather than parsed into nothing —
 * print-watch does not OCR.
 */
export function checkPdfText(text: string): PdfCheck {
  const pages = (text.match(/\f/g) ?? []).length;
  if (pages > PDF_MAX_PAGES) {
    return {
      ok: false,
      reason: `PDF has ${pages} pages — print-watch reads releases up to ${PDF_MAX_PAGES} pages`,
    };
  }
  if (text.replace(/\s+/g, "").length < PDF_MIN_TEXT_CHARS) {
    return {
      ok: false,
      reason:
        "image-only PDF (no usable text layer) — print-watch does not OCR; drop the HTML release or paste its link",
    };
  }
  return { ok: true };
}

/** `<dir>/<sha>.pdftext.txt`, beside `<dir>/<sha>.pdf`. Content-addressed
 *  like the bytes, so the same PDF delivered twice reuses one text file. */
export function textPathFor(bytesPath: string): string {
  return bytesPath.replace(/\.pdf$/, ".pdftext.txt");
}

/**
 * Where poppler lives on THIS machine: an explicit `settings.pdftotext_path`
 * first (the escape hatch for a MacPorts/nix install), then the two Homebrew
 * prefixes, then PATH. Null means "not installed" — the caller turns that
 * into a refusal that names both the tool and the setting.
 *
 * `exists` is injected so the resolution ORDER is testable without planting
 * binaries on the test machine.
 */
export function resolvePdftotextPath(
  db: Database.Database,
  env: EnvLike = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(PDFTOTEXT_SETTING_KEY) as
    | { value: string }
    | undefined;
  if (row?.value && exists(row.value)) return row.value;
  for (const candidate of PDFTOTEXT_CANDIDATES) if (exists(candidate)) return candidate;
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, "pdftotext");
    if (exists(p)) return p;
  }
  return null;
}

export interface PdftotextSeams {
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * `pdftotext -layout -enc UTF-8 <file> -` — layout-preserving text on stdout.
 *
 * Every way this can go wrong is bounded: a hung child is killed at
 * `timeoutMs`, stdout is capped at the same 2MB ceiling every other acquired
 * document obeys, and stderr is capped too (a poppler build that warns once
 * per malformed object can emit megabytes of it). A password error becomes
 * `PdfEncryptedError`; any other non-zero exit is a plain error carrying the
 * first 200 characters of stderr.
 */
export function runPdftotext(
  binary: string,
  pdfPath: string,
  seams: PdftotextSeams = {},
): Promise<string> {
  const spawn = seams.spawn ?? nodeSpawn;
  const timeoutMs = seams.timeoutMs ?? PDFTOTEXT_TIMEOUT_MS;
  const maxBytes = seams.maxBytes ?? MAX_RESPONSE_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const timer: NodeJS.Timeout = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(`pdftotext timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        child.kill();
        settle(() => reject(new Error(`pdftotext output exceeded the ${maxBytes}-byte cap`)));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (d: Buffer | string) => {
      stderr += String(d);
      if (stderr.length > PDFTOTEXT_STDERR_CAP) {
        child.kill();
        settle(() =>
          reject(new Error(`pdftotext stderr exceeded the ${PDFTOTEXT_STDERR_CAP}-byte cap`)),
        );
      }
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(out).toString("utf8"));
        } else if (/password/i.test(stderr)) {
          reject(new PdfEncryptedError("encrypted PDF — remove the password and drop it again"));
        } else {
          reject(new Error(`pdftotext exited ${code}: ${stderr.trim().slice(0, 200)}`));
        }
      });
    });
  });
}
