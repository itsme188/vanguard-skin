import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDbPath } from "@/lib/db/db-path";

/**
 * The suite must never resolve to the REAL database.
 *
 * `lib/db.ts` opens `resolveDbPath()` and runs every pending migration AT
 * MODULE LOAD. With no DATABASE_PATH that resolves to `<cwd>/data/vanguard.db`
 * — the live database in the main checkout. On 2026-09-04 that applied
 * migration 089 to the live DB the moment the slice B merge put it in the
 * CODE_MIGRATIONS registry, bypassing
 * `scripts/migrate-089-document-identity.ts` and every gate it exists to
 * enforce (fresh backup, no other holders, bytes-on-disk).
 *
 * It went unnoticed through 7,899 tests, 8/8 E2E and three review rounds
 * because in a WORKTREE `data/vanguard.db` does not exist: the same code path
 * silently creates a throwaway database and migrates that instead. The blast
 * radius depends entirely on which directory the suite runs from.
 *
 * This asserts the invariant itself — where the database RESOLVES — rather
 * than banning an import, so a transitive import of the singleton (the way it
 * actually happened) is caught too.
 */
describe("tests never touch the live database", () => {
  it("resolves the database somewhere other than the repo's live file", () => {
    const live = path.resolve(process.cwd(), "data", "vanguard.db");
    expect(path.resolve(resolveDbPath())).not.toBe(live);
  });

  it("pins DATABASE_PATH so a singleton import cannot fall back to cwd", () => {
    expect(process.env.DATABASE_PATH).toBeTruthy();
  });

  // The incident came through a TRANSITIVE import, not a direct one — every
  // test that names `@/lib/db` mocks it. So exercise the real thing: this is
  // the only place in the suite that loads the unmocked singleton, and it
  // proves the seal on the actual path rather than on a config value.
  it("opens the scratch database when the real singleton is imported", async () => {
    const live = path.resolve(process.cwd(), "data", "vanguard.db");
    const { db } = await import("@/lib/db");
    expect(path.resolve((db as unknown as { name: string }).name)).not.toBe(live);
  });
});
