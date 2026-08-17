/**
 * mint-qa-session.ts — Mints (or revokes) a `qa`-labeled app_sessions row
 * for the nightly QA runners (qa/run-qa.sh, qa/sandbox.sh) to authenticate
 * against the #35 packaged-app trust boundary.
 *
 * Trust model: this script opens the target SQLite file directly with no
 * auth of its own. That is intentional, not a hole — local filesystem
 * access to data/vanguard.db (or a sandbox copy of it) already grants
 * everything a session grants (the DB itself is the source of truth the
 * session protects). Minting a session here is a convenience so the QA
 * scripts can drive the app over HTTP like a real browser, not a new
 * privilege boundary.
 *
 * Usage:
 *   npx tsx scripts/mint-qa-session.ts --db <path>            # mint
 *   npx tsx scripts/mint-qa-session.ts --db <path> --revoke   # revoke-only
 *
 * Mint prints EXACTLY two shell-sourceable lines to stdout (nothing else on
 * stdout — all logging goes to stderr):
 *   VGS_SESSION='<rawToken>'
 *   VGS_CSRF='<csrfToken>'
 *
 * --revoke prints nothing to stdout; the revoked-row count goes to stderr.
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { createSession, revokeSessionsByLabel } from "../lib/mutations/sessions";

const QA_LABEL = "qa";

function parseArgs(argv: string[]): { dbPath: string; revoke: boolean } {
  const dbFlagIndex = argv.indexOf("--db");
  const dbPath = dbFlagIndex >= 0 ? argv[dbFlagIndex + 1] : undefined;
  const revoke = argv.includes("--revoke");

  if (!dbPath) {
    console.error(
      "Usage:\n" +
        "  npx tsx scripts/mint-qa-session.ts --db <path>            # mint\n" +
        "  npx tsx scripts/mint-qa-session.ts --db <path> --revoke   # revoke-only"
    );
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.error(`mint-qa-session: no such database file: ${dbPath}`);
    process.exit(1);
  }

  return { dbPath, revoke };
}

function main(): void {
  const { dbPath, revoke } = parseArgs(process.argv.slice(2));

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    if (revoke) {
      const deleted = revokeSessionsByLabel(db, QA_LABEL);
      console.error(`mint-qa-session: revoked ${deleted} qa-labeled session(s)`);
      return;
    }

    // Hygiene: a previous run's session dies before minting a new one.
    revokeSessionsByLabel(db, QA_LABEL);
    const { rawToken, csrfToken } = createSession(db, { label: QA_LABEL }, Date.now());

    process.stdout.write(`VGS_SESSION='${rawToken}'\n`);
    process.stdout.write(`VGS_CSRF='${csrfToken}'\n`);
  } finally {
    db.close();
  }
}

main();
