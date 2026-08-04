/**
 * Durable server-log sink for the packaged app (2026-08-04 observability
 * gap): the Next server's stdout/stderr reach Electron main's console only,
 * which a Finder-launched .app discards — the useRTH reaction failure had to
 * be diagnosed with a live probe because no breadcrumb survived. main.ts
 * tees both pipes through this module into
 * ~/Library/Logs/Vanguard Dashboard/server.log (app.getPath("logs")).
 *
 * Deliberately imports nothing from "electron" so the rotation/formatting
 * logic is unit-testable (tests/electron/server-log.test.ts) against a tmp
 * dir. Logging must never take the app down: every failure path degrades to
 * "no file log" (openServerLog returns null; stream "error" is swallowed).
 */
import fs from "node:fs";
import path from "node:path";

export const SERVER_LOG_NAME = "server.log";

/** One rotation generation at 5MB keeps worst-case disk use ~10MB. */
export const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Open an append stream to `<logDir>/server.log`, creating the directory and
 * rotating the current file aside to `server.log.1` (replacing any older
 * generation) once it has reached `maxBytes`. Returns null on any failure —
 * callers treat a null sink as "console-only logging", never an error.
 */
export function openServerLog(
  logDir: string,
  maxBytes: number = SERVER_LOG_MAX_BYTES,
): fs.WriteStream | null {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, SERVER_LOG_NAME);
    try {
      if (fs.statSync(logPath).size >= maxBytes) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // No existing log (first run) — nothing to rotate.
    }
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => {
      /* disk-full/permission errors must never crash the app */
    });
    return stream;
  } catch {
    return null;
  }
}

/**
 * Format one stdout/stderr chunk as a timestamped log line. Chunks arrive
 * with trailing newlines (and sometimes several buffered lines); interior
 * newlines are preserved, the tail is normalized to exactly one "\n".
 */
export function serverLogLine(tag: string, chunk: string): string {
  return `${new Date().toISOString()} ${tag} ${chunk.trim()}\n`;
}
