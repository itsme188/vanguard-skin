/**
 * One-row operator backfill for a newsletter article that should have
 * linked to a security but didn't — either because the extraction model
 * dropped the ticker from mentioned_symbols (see lib/gmail/subject-symbol-
 * backstop.ts for the automated deterministic fix going forward) or any
 * other one-off miss an operator spots manually.
 *
 * Resolves the symbol via the same sibling-aware resolver the rest of the
 * codebase uses (getSecurityIdForSymbolWithSiblings, lib/queries/
 * briefing-symbols.ts) — a GOOGL backfill still resolves onto a GOOG-only
 * securities row, for example.
 *
 * Dry-run by default: prints the article subject, current mentioned_symbols,
 * and the security row it would link, then exits without touching the DB.
 * Pass --apply to actually write. Both writes are idempotent:
 *   - research_article_securities: INSERT OR IGNORE, skipped if the
 *     (article_id, security_id) pair already exists.
 *   - mentioned_symbols: the symbol is appended to the stored JSON array
 *     only if not already present.
 * No DB backup is taken (single additive row + one JSON array append —
 * trivially reversible by hand if ever needed).
 *
 * Usage:
 *   npx tsx scripts/backfill-article-symbol.ts <articleId> <SYMBOL>            # dry-run
 *   npx tsx scripts/backfill-article-symbol.ts <articleId> <SYMBOL> --apply    # commit
 *
 * Example (the live miss this was written for):
 *   npx tsx scripts/backfill-article-symbol.ts 67770 U --apply
 */

import Database from "better-sqlite3";
import path from "node:path";
import { getSecurityIdForSymbolWithSiblings } from "../lib/queries/briefing-symbols";

interface ArticleRow {
  id: number;
  subject: string;
  mentioned_symbols: string | null;
  sentiment: string | null;
}

interface SecurityRow {
  id: number;
  symbol: string;
  name: string | null;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => a !== "--apply");
  const [articleIdArg, symbolArg] = positional;

  if (!articleIdArg || !symbolArg) {
    console.error("Usage: npx tsx scripts/backfill-article-symbol.ts <articleId> <SYMBOL> [--apply]");
    process.exit(1);
  }

  const articleId = Number(articleIdArg);
  if (!Number.isInteger(articleId) || articleId <= 0) {
    console.error(`Invalid articleId: "${articleIdArg}" (must be a positive integer)`);
    process.exit(1);
  }

  const symbol = symbolArg.trim().toUpperCase();
  if (!symbol) {
    console.error("Invalid SYMBOL: empty after trim");
    process.exit(1);
  }

  const dbPath = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  console.log(`Backfill article symbol link — ${apply ? "APPLY MODE" : "dry-run (pass --apply to commit)"}`);
  console.log(`DB: ${dbPath}`);
  console.log();

  const article = db
    .prepare(`SELECT id, subject, mentioned_symbols, sentiment FROM research_articles WHERE id = ?`)
    .get(articleId) as ArticleRow | undefined;
  if (!article) {
    console.error(`No research_articles row with id=${articleId}`);
    db.close();
    process.exit(1);
  }

  const securityId = getSecurityIdForSymbolWithSiblings(db, symbol);
  if (securityId === null) {
    console.error(`No securities row for symbol "${symbol}" (checked issuer siblings too)`);
    db.close();
    process.exit(1);
  }

  const security = db
    .prepare(`SELECT id, symbol, name FROM securities WHERE id = ?`)
    .get(securityId) as SecurityRow;

  let currentSymbols: string[] = [];
  try {
    const parsed = JSON.parse(article.mentioned_symbols || "[]");
    if (Array.isArray(parsed)) currentSymbols = parsed;
  } catch {
    console.warn(`Warning: mentioned_symbols on article ${articleId} is malformed JSON — treating as []`);
  }

  const existingLink = db
    .prepare(`SELECT 1 FROM research_article_securities WHERE article_id = ? AND security_id = ?`)
    .get(articleId, securityId);

  console.log(`Article ${article.id}: "${article.subject}"`);
  console.log(`Current mentioned_symbols: ${JSON.stringify(currentSymbols)}`);
  console.log(
    `Resolves "${symbol}" -> securities.id=${security.id} (${security.symbol}${security.name ? ` — ${security.name}` : ""})`
  );
  console.log(
    `research_article_securities link (article ${articleId} -> security ${securityId}): ${existingLink ? "already exists" : "missing"}`
  );
  console.log(`mentioned_symbols already contains "${symbol}": ${currentSymbols.includes(symbol)}`);

  if (!apply) {
    console.log("\nDry run — no changes made. Pass --apply to commit.");
    db.close();
    return;
  }

  console.log();
  let changed = false;

  if (!existingLink) {
    db.prepare(
      `INSERT OR IGNORE INTO research_article_securities (article_id, security_id, mention_context, sentiment)
       VALUES (?, ?, ?, ?)`
    ).run(articleId, securityId, `Manual backfill: ${symbol}`, article.sentiment);
    changed = true;
    console.log(`Inserted research_article_securities link (article ${articleId} -> security ${securityId}).`);
  } else {
    console.log("Link already exists — skipped (idempotent).");
  }

  if (!currentSymbols.includes(symbol)) {
    const updated = [...currentSymbols, symbol];
    db.prepare(`UPDATE research_articles SET mentioned_symbols = ? WHERE id = ?`).run(
      JSON.stringify(updated),
      articleId
    );
    changed = true;
    console.log(`Appended "${symbol}" to mentioned_symbols: ${JSON.stringify(updated)}`);
  } else {
    console.log(`"${symbol}" already present in mentioned_symbols — skipped.`);
  }

  if (!changed) console.log("Nothing to do — already fully backfilled.");
  db.close();
}

main();
