import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { resolveDbPath, resolveDbDir } from "@/lib/db/db-path";
import { defaultManifestDir } from "@/lib/import/recovery";

/**
 * QA import-undo--500-eperm-recovery-manifest-in-app-bundle.
 *
 * The undo-recovery manifest dir was pinned to `process.cwd()/data`, but the
 * packaged app's cwd is the read-only, code-signed bundle
 * (/Applications/Vanguard Dashboard.app/Contents/Resources/standalone) — the
 * .tmp manifest write threw EPERM and every Undo 500'd. The manifest must
 * live next to the database itself, which Electron points at the user's
 * writable data dir via VANGUARD_DB_DIR.
 *
 * Both helpers take env + cwd explicitly so this test never mutates the real
 * process environment.
 */

const CWD = "/repo";

describe("resolveDbPath", () => {
  it("prefers DATABASE_PATH verbatim (full path to a .db file)", () => {
    expect(resolveDbPath({ DATABASE_PATH: "/elsewhere/live.db" }, CWD)).toBe("/elsewhere/live.db");
  });

  it("falls back to VANGUARD_DB_DIR/vanguard.db (the Electron packaged-app path)", () => {
    expect(resolveDbPath({ VANGUARD_DB_DIR: "/Users/me/Library/App Support/vgs" }, CWD)).toBe(
      "/Users/me/Library/App Support/vgs/vanguard.db",
    );
  });

  it("falls back to <cwd>/data/vanguard.db when neither is set (dev server)", () => {
    expect(resolveDbPath({}, CWD)).toBe(join(CWD, "data", "vanguard.db"));
  });

  it("DATABASE_PATH wins over VANGUARD_DB_DIR", () => {
    expect(
      resolveDbPath({ DATABASE_PATH: "/elsewhere/live.db", VANGUARD_DB_DIR: "/other" }, CWD),
    ).toBe("/elsewhere/live.db");
  });
});

describe("resolveDbDir", () => {
  it("is the directory holding the resolved database file", () => {
    expect(resolveDbDir({ DATABASE_PATH: "/elsewhere/live.db" }, CWD)).toBe("/elsewhere");
    expect(resolveDbDir({ VANGUARD_DB_DIR: "/data/vgs" }, CWD)).toBe("/data/vgs");
    expect(resolveDbDir({}, CWD)).toBe(join(CWD, "data"));
  });
});

describe("defaultManifestDir", () => {
  it("sits next to the database, not next to the (possibly read-only) cwd", () => {
    const packagedCwd = "/Applications/Vanguard Dashboard.app/Contents/Resources/standalone";
    const dataDir = "/Users/me/Library/Application Support/Vanguard Dashboard/data";

    const dir = defaultManifestDir({ VANGUARD_DB_DIR: dataDir }, packagedCwd);

    expect(dir).toBe(join(dataDir, "undo-recovery"));
    expect(dir.startsWith(packagedCwd)).toBe(false);
  });

  it("still resolves to <cwd>/data/undo-recovery in a plain dev checkout", () => {
    expect(defaultManifestDir({}, CWD)).toBe(join(CWD, "data", "undo-recovery"));
  });
});
