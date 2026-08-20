/**
 * Headless-Chrome HTML→PDF renderer + a duplex `lp` print road for the
 * printed earnings sheet (2026-08-06 print/prose round).
 *
 * No npm dependency — Chrome's own `--headless --print-to-pdf` flag does the
 * rendering; the system app is runtime-detected via `existsSync`, never
 * assumed installed. `countPdfPages` is a byte-level PDF page counter (no
 * PDF library) so the sheet-length gate (Task 7) can decide print behavior
 * without shipping a parser dependency.
 *
 * The spawn/settle/kill-timer shape mirrors `printViaLp` at
 * lib/earnings/worksheet.ts:315-354 — read that first if touching this file.
 *
 * Spec: docs/superpowers/specs/2026-08-06-earnings-print-prose-round-design.md
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const LP_TIMEOUT_MS = 20_000;
const OUTPUT_POLL_INTERVAL_MS = 150;
// A stable-but-truncated size can hold for a poll or two on a large,
// slow-disk render — require 3 consecutive identical, non-zero size
// readings (2 full poll gaps of quiescence) before even considering the
// file "done", and even then only after `hasPdfEofMarker` confirms it.
const REQUIRED_STABLE_SAMPLES = 3;
// Cleanup of a Chrome profile dir WE killed mid-shutdown needs seconds, not
// milliseconds (live-measured — see the `cleanupTempDir` comment). Delays
// are spaced coarsely; total worst-case budget is their sum, ~5.25s.
const CLEANUP_RETRY_DELAYS_MS = [250, 500, 1000, 1500, 2000];

/**
 * Minimal structural shape of what this module actually consumes off a
 * spawned child process. The real `node:child_process` `spawn()` return
 * value satisfies this. Kept narrow (rather than importing `ChildProcess`)
 * so a test-only stub doesn't need to implement the entire real interface —
 * see the `spawnFn` option below.
 */
interface SpawnedProcess {
  kill(): void;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

type SpawnFn = (command: string, args: string[]) => SpawnedProcess;

/** Existence-checked default Chrome path — path or null, never throws. */
export function chromeBinaryPath(): string | null {
  try {
    return existsSync(DEFAULT_CHROME_PATH) ? DEFAULT_CHROME_PATH : null;
  } catch {
    return null;
  }
}

// Below this size, a 0-count result is unremarkable — garbage bytes, an
// empty/truncated file, whatever; the poll loop and readCompletedPdf already
// handle those cases before a caller ever gets this far. Above it, the
// buffer looks like Chrome genuinely rendered something, so an
// implausibly-low count is worth a breadcrumb instead of a silent downgrade.
const NON_TRIVIAL_PDF_BYTES = 20_000;
// These are plain markdown/monospace earnings sheets (no heavy embedded
// media) — real Chrome output here runs well under this many bytes per
// counted page. A ratio above it on a non-trivial buffer means the regex is
// almost certainly undercounting, not that the document has that few pages.
const SUSPICIOUS_BYTES_PER_PAGE = 200_000;

/**
 * Counts `/Type /Page` objects (individual pages), deliberately excluding
 * `/Type /Pages` (the page-tree root, which the negative lookahead
 * `(?![s])` rules out from matching the same regex). Byte-level regex over
 * the PDF's latin1 bytes — good enough for Chrome's own `--print-to-pdf`
 * output, not a general PDF parser. Returns 0 for anything that doesn't
 * look like a PDF.
 *
 * Diagnostic breadcrumb (deferred minor, 2026-08-07): this regex can only
 * see pages spelled out as literal `/Type /Page` tokens — it has no idea
 * what a PDF cross-reference stream or a compressed object stream (ObjStm)
 * is. If a future Chrome build starts emitting pages inside one, this would
 * silently undercount and `printWorksheetNow` would quietly downgrade every
 * render to the monospace fallback with no alarm. `console.warn`s (grep for
 * "countPdfPages") when a non-trivial buffer comes back with 0 pages or an
 * implausibly low count for its size — never changes the returned count or
 * the caller's fallback behavior, just makes a silent quality regression
 * loud.
 */
export function countPdfPages(pdf: Buffer): number {
  const count = pdf.toString("latin1").match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0;
  if (
    pdf.length >= NON_TRIVIAL_PDF_BYTES &&
    (count === 0 || pdf.length / count > SUSPICIOUS_BYTES_PER_PAGE)
  ) {
    console.warn(
      `[countPdfPages] suspiciously low page count (${count}) for a ${pdf.length}-byte PDF — ` +
        "this is a byte-level regex scan for literal \"/Type /Page\" tokens, not a real PDF " +
        "parser, so it cannot see pages described via a compressed object stream (ObjStm). If a " +
        "newer Chrome build has switched to those, this will keep returning a falsely-low count " +
        "and every render will silently downgrade to the monospace fallback. Investigate the PDF " +
        "itself before assuming the render failed.",
    );
  }
  return count;
}

/**
 * True when the buffer's tail is the canonical PDF end-of-file marker
 * (`%%EOF`, optionally followed by trailing whitespace). Checked against
 * only the last 64 bytes and via `endsWith` (not a loose `includes`) so an
 * incidental "%%EOF"-shaped substring earlier in the content stream (e.g.
 * echoed from the source HTML's own text) can't produce a false positive.
 * A stable-but-mid-write file (caught between an fsync and the trailer
 * append) has a settled size but no EOF marker yet — this is the
 * well-formedness gate `renderHtmlToPdf`'s poll loop uses before trusting
 * "size stopped changing" as "the write is actually done".
 */
export function hasPdfEofMarker(pdf: Buffer): boolean {
  const tailStart = Math.max(0, pdf.length - 64);
  return pdf
    .subarray(tailStart)
    .toString("latin1")
    .trimEnd()
    .endsWith("%%EOF");
}

/**
 * Reads a completed PDF from disk, throwing a descriptive error for the
 * four ways "chrome claims success" can still be a lie: no file, an empty
 * one, a file that doesn't start with the `%PDF` magic header, or one
 * that's missing its trailing `%%EOF` marker (a truncated write
 * masquerading as a clean exit — see `hasPdfEofMarker`). Used by the
 * `close`-event completion path (Chrome exited 0 on its own) — the
 * poll-completion path below has different semantics (an
 * empty/incomplete/malformed file there just means "keep waiting", not
 * "fail now"), so it does not reuse this helper.
 */
function readCompletedPdf(pdfPath: string): Buffer {
  if (!existsSync(pdfPath)) {
    throw new Error("chrome produced no PDF file");
  }
  const pdf = readFileSync(pdfPath);
  if (pdf.length === 0) {
    throw new Error("chrome produced a 0-byte PDF");
  }
  if (pdf.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error("chrome PDF missing %PDF header (not a PDF)");
  }
  if (!hasPdfEofMarker(pdf)) {
    throw new Error("chrome PDF missing %%EOF marker (truncated)");
  }
  return pdf;
}

/**
 * Best-effort temp-dir cleanup on a seconds-scale retry schedule.
 *
 * Live-measured on this machine: when `renderHtmlToPdf` kills Chrome itself
 * (poll-completion path — see that function's doc comment for why), the
 * profile dir's `Cache` / `Code Cache` / `index-dir` subtrees stay busy for
 * SECONDS after the process disappears from `ps` — a bare shell `rm -rf`
 * needed ~5s of elapsed wall-clock time after process death to succeed
 * reliably, and Node's built-in `rmSync` millisecond-scale
 * `maxRetries`/`retryDelay` option was not sufficient (still failed with an
 * 11s cumulative backoff budget in testing). This retries on a coarser,
 * explicit schedule (`CLEANUP_RETRY_DELAYS_MS`, ~5.25s total) with a real
 * delay before even the first attempt. Always best-effort: logs and gives
 * up rather than throwing, so a leaked temp dir can never turn a
 * successful render into a reported failure (a throwing `.finally()`
 * callback replaces a resolved promise with a rejection, per plain JS
 * Promise semantics). Leaked dirs under `$TMPDIR` are small and self-heal
 * via the OS's periodic temp-file sweep.
 */
async function cleanupTempDir(dir: string): Promise<void> {
  let lastErr: unknown;
  for (const delayMs of CLEANUP_RETRY_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  console.warn(
    `[print-pdf] failed to clean up temp dir ${dir} after retries:`,
    lastErr,
  );
}

/**
 * Renders `html` to a PDF via headless Chrome. Writes the HTML to a fresh
 * temp dir (own Chrome profile dir alongside it so concurrent renders never
 * collide), spawns Chrome with `--print-to-pdf`, and reads the resulting
 * file back into memory. Best-effort cleans up the temp dir (see
 * `cleanupTempDir` — a cleanup failure is logged, never allowed to turn a
 * successful render into a rejection). Throws on any RENDER failure —
 * missing Chrome binary, non-zero exit, timeout, or a missing/empty output
 * file.
 *
 * Completion detection is filesystem-polling, NOT solely the process
 * `close` event. Live-verified (`sample <pid>` on macOS 26.2 / Chrome 150):
 * with a non-default `--user-data-dir`, this Chrome build boots a real
 * AppKit app whose main thread parks forever in
 * `-[NSApplication run] -> nextEventMatchingMask -> mach_msg` after
 * `--print-to-pdf` finishes writing — it never self-exits, so a pure
 * `close`-event wait times out on every real call on this platform. The
 * poll loop below requires the output file's size to hold steady across
 * `REQUIRED_STABLE_SAMPLES` consecutive checks AND start with the `%PDF`
 * header AND end in a `%%EOF` marker (`hasPdfEofMarker`) before trusting it
 * as complete — a size-only,
 * single-sample check would risk resolving a stable-but-truncated file as
 * a silent success on a slow disk or a larger multi-page render — then
 * kills Chrome itself and resolves with the file bytes. The `close`
 * listener is kept as an alternate completion path (first to settle wins)
 * for platforms/builds where Chrome does exit cleanly on its own (e.g.
 * Linux, or a future macOS fix) — and as the source of the non-zero-exit
 * failure signal. `timeoutMs` remains the outer safety net for a genuine
 * hang (e.g. Chrome never writes the file at all).
 */
export function renderHtmlToPdf(
  html: string,
  opts: {
    chromePath?: string;
    timeoutMs?: number;
    /** Test-only DI seam: stub out the real `node:child_process` spawn. */
    spawnFn?: SpawnFn;
    /** Test-only: override the output-file poll interval (default 150ms). */
    pollIntervalMs?: number;
  } = {},
): Promise<Buffer> {
  const chromePath = opts.chromePath ?? chromeBinaryPath();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? OUTPUT_POLL_INTERVAL_MS;
  const spawnImpl: SpawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);

  if (!chromePath || !existsSync(chromePath)) {
    return Promise.reject(
      new Error(`chrome binary not found at ${chromePath ?? "(none)"}`),
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "vgs-print-"));
  const htmlPath = join(dir, "sheet.html");
  const pdfPath = join(dir, "sheet.pdf");

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    // `pollTimer` is referenced here (inside `settle`'s closure) before its
    // own `const` declaration further down — legal JS/TS: this arrow
    // function body isn't evaluated until `settle` is actually CALLED, by
    // which point the poll `setInterval` below has always already run
    // (both are set up synchronously, before any async callback that could
    // invoke `settle` has a chance to fire).
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(pollTimer);
      fn();
    };

    let child: SpawnedProcess;
    try {
      writeFileSync(htmlPath, html);
      child = spawnImpl(chromePath, [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(dir, "profile")}`,
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        htmlPath,
      ]);
    } catch (err) {
      // No process was ever spawned — nothing racing the cleanup, and the
      // outer `.finally()` below will still best-effort remove `dir`.
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      settle(() =>
        reject(new Error(`chrome timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    let lastSize = -1;
    let stableStreak = 0;
    const pollTimer = setInterval(() => {
      if (settled) return;
      try {
        if (!existsSync(pdfPath)) {
          lastSize = -1;
          stableStreak = 0;
          return;
        }
        const size = statSync(pdfPath).size;
        if (size <= 0) {
          lastSize = -1;
          stableStreak = 0;
          return;
        }
        if (size === lastSize) {
          stableStreak++;
        } else {
          lastSize = size;
          stableStreak = 1;
        }
        if (stableStreak < REQUIRED_STABLE_SAMPLES) return;

        // Size has held steady across REQUIRED_STABLE_SAMPLES consecutive
        // polls. Before trusting that as "done", confirm the file is
        // actually well-formed — a stall mid-write can hold a
        // stable-but-truncated size for a poll or two, and this must never
        // resolve as a silent success on a bad PDF.
        let buf: Buffer;
        try {
          buf = readFileSync(pdfPath);
        } catch {
          return; // transient read race mid-write — keep polling
        }
        if (buf.subarray(0, 4).toString("latin1") !== "%PDF") return; // no header yet — keep polling
        if (!hasPdfEofMarker(buf)) return; // still looks incomplete

        child.kill();
        settle(() => resolve(buf));
      } catch {
        // transient stat error mid-write — keep polling
      }
    }, pollIntervalMs);

    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(`chrome exited ${code}: ${stderr.trim()}`));
          return;
        }
        try {
          resolve(readCompletedPdf(pdfPath));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }).finally(() => cleanupTempDir(dir));
}

/**
 * Sends an already-rendered PDF file to `lp`, always requesting duplex
 * (two-sided long-edge) — the printed sheet is meant to be a multi-page desk
 * document. Same settle/kill-timer shape as `printViaLp`
 * (lib/earnings/worksheet.ts), but the PDF is passed as a trailing ARG
 * (no stdin piping) since `lp` reads the file directly.
 */
export function printPdfViaLp(
  pdfPath: string,
  opts: { printer?: string | null; title?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (opts.printer) args.push("-d", opts.printer);
    if (opts.title) args.push("-t", opts.title);
    args.push("-o", "sides=two-sided-long-edge", pdfPath);

    const child = spawn("lp", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Same wedged-cupsd rationale as printViaLp — offline printers queue-
    // and-exit, bad destinations reject immediately, so a hang means cupsd
    // is stuck. Kill after 20s.
    const timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error("lp timed out after 20s (cupsd wedged?)")));
    }, LP_TIMEOUT_MS);
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) resolve();
        else reject(new Error(`lp exited ${code}: ${stderr.trim()}`));
      });
    });
  });
}
