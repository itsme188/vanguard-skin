import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTORE_NOTES_NAME, RESTORE_NOTES_VERSION_LINE, ensureRestoreNotes } from "@/lib/backup/restore-notes";

let home: string;
const notes = () => path.join(home, RESTORE_NOTES_NAME);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-notes-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ensureRestoreNotes", () => {
  it("creates the notes when they are missing", () => {
    ensureRestoreNotes(home);
    const text = fs.readFileSync(notes(), "utf8");
    expect(text.split("\n")[0]).toBe(RESTORE_NOTES_VERSION_LINE);
    expect(text).toContain("zstd -dc --long=31");
    expect(text).toContain("tar -tf -");
    expect(text).toContain("PRAGMA integrity_check");
    expect(text).toContain("-wal");
    expect(text).toContain("portfolio-desk-backups-through-2026-11-16.tar.zst");
  });

  it("rewrites the notes when the version line differs", () => {
    fs.writeFileSync(notes(), "old notes, version 0\nstale steps\n");
    ensureRestoreNotes(home);
    expect(fs.readFileSync(notes(), "utf8").split("\n")[0]).toBe(RESTORE_NOTES_VERSION_LINE);
  });

  it("leaves current notes alone", () => {
    const current = `${RESTORE_NOTES_VERSION_LINE}\nan owner's own extra line\n`;
    fs.writeFileSync(notes(), current);
    const before = fs.statSync(notes()).mtimeMs;
    ensureRestoreNotes(home);
    expect(fs.readFileSync(notes(), "utf8")).toBe(current);
    expect(fs.statSync(notes()).mtimeMs).toBe(before);
  });
});
