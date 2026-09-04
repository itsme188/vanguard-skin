import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `next build` OPENS THE DATABASE AND RUNS MIGRATIONS.
 *
 * Next evaluates route modules while collecting page data, those modules reach
 * `lib/db.ts`, and `lib/db.ts` runs `runMigrations()` at module load against
 * `resolveDbPath()`. Proved directly on 2026-09-04:
 * `DATABASE_PATH=<empty dir>/vanguard.db npx next build` creates the file and
 * migrates it.
 *
 * Unpinned, that path is `<cwd>/data/vanguard.db` — the live database. It is
 * what applied migrations 090 and 091 during `electron:deploy`'s build step,
 * NINE MINUTES before the new server was installed, leaving the old binary
 * running against the new schema in between.
 *
 * So every script that invokes `next build` must pin DATABASE_PATH somewhere
 * else. Migrations then apply where they belong: when the app actually starts.
 *
 * It is pinned at `:memory:` rather than a scratch FILE on purpose. Next
 * collects page data with seven parallel workers, and they all open whatever
 * DATABASE_PATH names — on a shared fresh file they race each other's
 * migrations and the build dies with `table accounts already exists`. (That
 * race was always there; it never fired because the live database already had
 * every migration applied, so `runMigrations` was a no-op.) `:memory:` gives
 * each worker its own database and removes the race instead of moving it.
 *
 * Residual this does NOT cover: a bare `npx next build` typed by hand still
 * resolves to the live database. Use `npm run build`.
 */
describe("build scripts never touch the live database", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
  ) as { scripts: Record<string, string> };

  const buildScripts = Object.entries(pkg.scripts).filter(([, cmd]) =>
    /(^|\s|&&\s*)(npx\s+)?next\s+build\b/.test(cmd),
  );

  it("finds at least one script invoking next build", () => {
    expect(buildScripts.length).toBeGreaterThan(0);
  });

  it.each(buildScripts)("%s pins DATABASE_PATH away from data/vanguard.db", (_name, cmd) => {
    const match = /DATABASE_PATH=("[^"]*"|'[^']*'|\S+)/.exec(cmd);
    expect(match, "script must set DATABASE_PATH before `next build`").not.toBeNull();

    const value = match![1].replace(/^["']|["']$/g, "");
    expect(value).not.toBe("");
    // Must not resolve to the repo's own data/vanguard.db, however spelled.
    expect(value).not.toMatch(/(^|\/)data\/vanguard\.db$/);
  });
});
