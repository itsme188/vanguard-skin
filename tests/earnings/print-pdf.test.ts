import { describe, it, expect } from "vitest";
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
