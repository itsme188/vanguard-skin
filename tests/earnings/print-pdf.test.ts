import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  countPdfPages,
  chromeBinaryPath,
  renderHtmlToPdf,
  hasPdfEofMarker,
} from "@/lib/earnings/print-pdf";

describe("countPdfPages", () => {
  it("counts /Type /Page objects, not the /Pages root", () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n%%EOF");
    expect(countPdfPages(pdf)).toBe(2);
  });
  it("returns 0 for garbage", () => {
    expect(countPdfPages(Buffer.from("not a pdf"))).toBe(0);
  });

  it("stays silent on a small buffer even with 0 pages", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(countPdfPages(Buffer.from("not a pdf"))).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("breadcrumbs (grep-able 'countPdfPages') a 0-page count on a non-trivial buffer without changing the return value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 25KB of padding with no "/Type /Page" token at all — simulates a
    // future Chrome build hiding pages in a compressed object stream.
    const pdf = Buffer.from("%PDF-1.7\n" + "x".repeat(25_000) + "\n%%EOF");
    expect(countPdfPages(pdf)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("countPdfPages");
    warn.mockRestore();
  });

  it("breadcrumbs an implausibly low (but nonzero) count for a large buffer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // One real page token in a 250KB buffer — 250KB/page is far above the
    // suspicious-ratio threshold for these plain monospace/markdown sheets.
    const pdf = Buffer.from(
      "%PDF-1.7\n1 0 obj << /Type /Page >>\n" + "x".repeat(250_000) + "\n%%EOF",
    );
    expect(countPdfPages(pdf)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("countPdfPages");
    warn.mockRestore();
  });

  it("stays silent on a plausible page count for the buffer size", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      countPdfPages(
        Buffer.from(
          "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n%%EOF",
        ),
      ),
    ).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("hasPdfEofMarker", () => {
  it("is true for content ending in %%EOF", () => {
    expect(hasPdfEofMarker(Buffer.from("%PDF-1.4\n...\n%%EOF"))).toBe(true);
  });
  it("tolerates trailing whitespace/newline after %%EOF", () => {
    expect(hasPdfEofMarker(Buffer.from("%PDF-1.4\n...\n%%EOF\n"))).toBe(true);
  });
  it("is false for a truncated file with no trailer", () => {
    expect(hasPdfEofMarker(Buffer.from("%PDF-1.4\n<mid-write, no trailer>"))).toBe(false);
  });
  it("is false for an empty buffer", () => {
    expect(hasPdfEofMarker(Buffer.alloc(0))).toBe(false);
  });
});

describe("renderHtmlToPdf", () => {
  it("throws immediately when the chrome binary does not exist", async () => {
    await expect(
      renderHtmlToPdf("<html></html>", { chromePath: "/nonexistent/chrome" }),
    ).rejects.toThrow(/chrome/i);
  });
});

describe("chromeBinaryPath", () => {
  it("returns a string path or null, never throws", () => {
    const p = chromeBinaryPath();
    expect(p === null || typeof p === "string").toBe(true);
  });
});

// --- Race-condition coverage via an injected spawnFn (DI seam, test-only) ---
//
// `chromePath` just needs to satisfy `existsSync` — the real Node binary is
// guaranteed to exist and is never actually spawned since `spawnFn` is
// injected. `pollIntervalMs` is set tiny so these tests run in real
// (non-mocked) time without needing fake-timer/microtask juggling.
const STUB_CHROME_PATH = process.execPath;

interface FakeProc extends EventEmitter {
  stderr: EventEmitter;
  kill: () => void;
}

/** Builds a fake spawned process and hands the real `--print-to-pdf=<path>`
 * argument back to `behavior` so the test can write to the exact file
 * `renderHtmlToPdf` is polling. */
function makeStubSpawn(
  behavior: (
    pdfPath: string,
    proc: FakeProc,
  ) => void,
): { spawnFn: (command: string, args: string[]) => FakeProc; killCount: () => number } {
  let killCount = 0;
  const spawnFn = (_command: string, args: string[]): FakeProc => {
    const flag = args.find((a) => a.startsWith("--print-to-pdf="));
    const pdfPath = flag ? flag.slice("--print-to-pdf=".length) : "";
    const proc = new EventEmitter() as FakeProc;
    proc.stderr = new EventEmitter();
    proc.kill = () => {
      killCount++;
    };
    behavior(pdfPath, proc);
    return proc;
  };
  return { spawnFn, killCount: () => killCount };
}

describe("renderHtmlToPdf completion racing (injected spawnFn)", () => {
  it("does not resolve on a stable-but-truncated file; waits for the EOF marker", async () => {
    let secondWriteAt = 0;
    const { spawnFn } = makeStubSpawn((pdfPath) => {
      // A truncated write with NO %%EOF trailer, held perfectly steady —
      // long enough that a naive single-sample "size didn't change" check
      // (the pre-fix heuristic) would have declared victory and resolved
      // with bad, incomplete content.
      writeFileSync(pdfPath, "%PDF-1.4\n<truncated, no trailer>");
      setTimeout(() => {
        secondWriteAt = Date.now();
        writeFileSync(
          pdfPath,
          "%PDF-1.4\n1 0 obj<</Type/Page>>\n%%EOF",
        );
      }, 60); // several pollIntervalMs beyond the pre-fix 1-sample threshold
    });

    const pdf = await renderHtmlToPdf("<h1>hi</h1>", {
      chromePath: STUB_CHROME_PATH,
      spawnFn,
      pollIntervalMs: 5,
      timeoutMs: 5000,
    });

    expect(Date.now()).toBeGreaterThanOrEqual(secondWriteAt);
    expect(hasPdfEofMarker(pdf)).toBe(true);
    expect(pdf.toString("latin1")).not.toContain("truncated");
  });

  it("rejects on timeout when chrome never produces output", async () => {
    const { spawnFn, killCount } = makeStubSpawn(() => {
      // never writes, never closes — the file simply never appears
    });

    await expect(
      renderHtmlToPdf("<h1>hi</h1>", {
        chromePath: STUB_CHROME_PATH,
        spawnFn,
        pollIntervalMs: 5,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);

    expect(killCount()).toBeGreaterThan(0);
  });

  it("rejects when chrome exits 0 without producing a PDF file", async () => {
    const { spawnFn } = makeStubSpawn((_pdfPath, proc) => {
      setTimeout(() => proc.emit("close", 0), 5);
    });

    await expect(
      renderHtmlToPdf("<h1>hi</h1>", {
        chromePath: STUB_CHROME_PATH,
        spawnFn,
        pollIntervalMs: 5,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/no pdf file/i);
  });

  it("rejects on a non-zero exit code", async () => {
    const { spawnFn } = makeStubSpawn((_pdfPath, proc) => {
      setTimeout(() => proc.emit("close", 1), 5);
    });

    await expect(
      renderHtmlToPdf("<h1>hi</h1>", {
        chromePath: STUB_CHROME_PATH,
        spawnFn,
        pollIntervalMs: 5,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited 1/);
  });

  it("settles exactly once when the poll-completion path and a close(0) event race", async () => {
    const { spawnFn } = makeStubSpawn((pdfPath, proc) => {
      // Write a complete, EOF-terminated PDF immediately so the poll loop
      // is racing to declare victory around the same time as `close`.
      writeFileSync(pdfPath, "%PDF-1.4\n1 0 obj<</Type/Page>>\n%%EOF");
      setTimeout(() => proc.emit("close", 0), 20);
    });

    const pdf = await renderHtmlToPdf("<h1>hi</h1>", {
      chromePath: STUB_CHROME_PATH,
      spawnFn,
      pollIntervalMs: 5,
      timeoutMs: 5000,
    });

    // Whichever path won, the resolved value must be the real, complete
    // file content exactly once (a native Promise can only settle once,
    // but this also exercises the `settled` guard's bookkeeping — an
    // unguarded race here would show up as flakiness or a thrown error
    // from a second kill()/read() attempt racing the first).
    expect(hasPdfEofMarker(pdf)).toBe(true);
  });
});

// --- readCompletedPdf validation, exercised via the close(0) completion
// path (readCompletedPdf is module-private; renderHtmlToPdf's injected
// spawnFn is the existing seam other tests in this file use to reach it). A
// large pollIntervalMs keeps the poll-completion path from ever firing a
// tick inside the test's window, so only the close(0)->readCompletedPdf
// path can settle the promise — isolating the assertion to that path.
describe("readCompletedPdf validation (via close(0) path)", () => {
  it("accepts a buffer starting with %PDF and ending with %%EOF", async () => {
    const { spawnFn } = makeStubSpawn((pdfPath, proc) => {
      writeFileSync(pdfPath, "%PDF-1.4\n1 0 obj<</Type/Page>>\n%%EOF");
      setTimeout(() => proc.emit("close", 0), 5);
    });

    const pdf = await renderHtmlToPdf("<h1>hi</h1>", {
      chromePath: STUB_CHROME_PATH,
      spawnFn,
      pollIntervalMs: 10_000,
      timeoutMs: 5000,
    });

    expect(pdf.toString("latin1")).toContain("%PDF-1.4");
    expect(hasPdfEofMarker(pdf)).toBe(true);
  });

  it("rejects a non-empty buffer missing the %PDF header", async () => {
    const { spawnFn } = makeStubSpawn((pdfPath, proc) => {
      // Ends with a valid %%EOF trailer so this isolates the header check
      // specifically, but never starts with the %PDF magic bytes.
      writeFileSync(pdfPath, "not a pdf at all\n%%EOF");
      setTimeout(() => proc.emit("close", 0), 5);
    });

    await expect(
      renderHtmlToPdf("<h1>hi</h1>", {
        chromePath: STUB_CHROME_PATH,
        spawnFn,
        pollIntervalMs: 10_000,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/missing %PDF header/i);
  });

  it("rejects a buffer with a %PDF header but no %%EOF tail (truncated)", async () => {
    const { spawnFn } = makeStubSpawn((pdfPath, proc) => {
      writeFileSync(pdfPath, "%PDF-1.4\n<mid-write, no trailer>");
      setTimeout(() => proc.emit("close", 0), 5);
    });

    await expect(
      renderHtmlToPdf("<h1>hi</h1>", {
        chromePath: STUB_CHROME_PATH,
        spawnFn,
        pollIntervalMs: 10_000,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/missing %%EOF marker \(truncated\)/i);
  });
});
