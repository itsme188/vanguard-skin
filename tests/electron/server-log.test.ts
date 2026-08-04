/**
 * Electron server-log persistence (2026-08-04 observability gap): the
 * packaged app's Next server stdout/stderr previously went only to Electron
 * main's own console — nowhere durable for a Finder-launched app, so the
 * useRTH reaction diagnosis had zero breadcrumbs. electron/server-log.ts
 * tees them to a size-rotated file under ~/Library/Logs/Vanguard Dashboard/.
 *
 * The module is deliberately electron-import-free (node:fs/path only) so it
 * is unit-testable here against a real tmp dir; main.ts owns the electron
 * side (app.getPath("logs")) and stays compile-checked only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openServerLog, serverLogLine, SERVER_LOG_NAME } from "@/electron/server-log";

let tmpDir: string;
const openStreams: fs.WriteStream[] = [];

function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-log-test-"));
});

afterEach(async () => {
  for (const s of openStreams.splice(0)) {
    if (!s.closed) await endStream(s);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("openServerLog", () => {
  it("creates the log directory and appends lines to server.log", async () => {
    const logDir = path.join(tmpDir, "Vanguard Dashboard");
    const stream = openServerLog(logDir)!;
    openStreams.push(stream);
    expect(stream).not.toBeNull();

    stream.write("first line\n");
    await endStream(stream);

    const logPath = path.join(logDir, SERVER_LOG_NAME);
    expect(fs.readFileSync(logPath, "utf8")).toBe("first line\n");
  });

  it("appends across open/close cycles (restart keeps prior content)", async () => {
    const s1 = openServerLog(tmpDir)!;
    s1.write("run 1\n");
    await endStream(s1);

    const s2 = openServerLog(tmpDir)!;
    openStreams.push(s2);
    s2.write("run 2\n");
    await endStream(s2);

    const content = fs.readFileSync(path.join(tmpDir, SERVER_LOG_NAME), "utf8");
    expect(content).toBe("run 1\nrun 2\n");
  });

  it("rotates server.log to server.log.1 when it reaches maxBytes at open, replacing an older .1", async () => {
    const logPath = path.join(tmpDir, SERVER_LOG_NAME);
    fs.writeFileSync(logPath, "OLD".repeat(10)); // 30 bytes
    fs.writeFileSync(`${logPath}.1`, "ANCIENT");

    const stream = openServerLog(tmpDir, 20)!; // 30 >= 20 → rotate
    openStreams.push(stream);
    stream.write("fresh\n");
    await endStream(stream);

    expect(fs.readFileSync(`${logPath}.1`, "utf8")).toBe("OLD".repeat(10));
    expect(fs.readFileSync(logPath, "utf8")).toBe("fresh\n");
  });

  it("does not rotate below maxBytes", async () => {
    const logPath = path.join(tmpDir, SERVER_LOG_NAME);
    fs.writeFileSync(logPath, "small\n");

    const stream = openServerLog(tmpDir, 1024)!;
    openStreams.push(stream);
    stream.write("more\n");
    await endStream(stream);

    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(fs.readFileSync(logPath, "utf8")).toBe("small\nmore\n");
  });

  it("returns null instead of throwing when the log dir cannot be created", () => {
    const fileAsDir = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(fileAsDir, "x"); // a FILE where the dir should go
    expect(openServerLog(path.join(fileAsDir, "nested"))).toBeNull();
  });
});

describe("serverLogLine", () => {
  it("prefixes an ISO timestamp + tag and trims the chunk to one terminated line", () => {
    const line = serverLogLine("[server]", "  Ready in 1.2s\n\n");
    expect(line).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[server\] Ready in 1\.2s\n$/,
    );
  });

  it("preserves interior newlines of a multi-line chunk", () => {
    const line = serverLogLine("[server:err]", "boom\n  at foo()\n");
    expect(line).toBe(line.trimEnd() + "\n");
    expect(line).toContain("boom\n  at foo()");
  });
});
