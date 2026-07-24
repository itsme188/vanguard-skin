/**
 * Repair research_articles.key_themes rows contaminated with structured-
 * output tag debris (the 2026-07-22 Research Desk leak) or mangled non-JSON
 * strings. Re-cleans through sanitizeThemeList and stores canonical JSON.
 *
 * Dry-run by default:  npx tsx scripts/repair-key-themes.ts
 * Apply:               npx tsx scripts/repair-key-themes.ts --apply
 */
import Database from "better-sqlite3";
import path from "path";
import { sanitizeThemeList } from "../lib/gmail/process";

const apply = process.argv.includes("--apply");
const db = new Database(path.join(process.cwd(), "data", "vanguard.db"));

const rows = db
  .prepare(
    `SELECT id, key_themes FROM research_articles
      WHERE key_themes IS NOT NULL AND key_themes != '' AND key_themes != '[]'`
  )
  .all() as { id: number; key_themes: string }[];

// sanitizeThemeList's per-element boundary strip
// (/^[\s"'[\]]+|[\s"'[\]]+$/g) treats a leading/trailing SINGLE quote as
// stray JSON debris, but a healthy theme legitimately ends with one when it
// closes a scare-quoted phrase (e.g. "Jensen Huang 'demand has gone
// parabolic'"). That's a real content-loss risk, not cosmetic noise — a
// dry-run pass over the full table found 9 such rows (14395, 18250, 22442,
// 44512, 48240, 48257, 50379, 50384, 51433), each a well-formed 5-element
// array with zero tag debris, where naive re-cleaning would clip a trailing
// apostrophe. Genuine contamination in this table always shows a
// *structural* signature instead — an angle-bracket tag fragment
// (`<parameter…>`) or a literal stray `"`/`[`/`]` character sitting at an
// element's boundary (double-JSON-encoded elements, e.g. row 55380's
// `"\"search/AI Mode…\""`). Gate the apply set on that structural signature
// so single-quote-only diffs are left untouched.
function hasStructuralContamination(raw: string): boolean {
  const t = raw.trim();
  return /[<>]/.test(t) || /^["[\]]/.test(t) || /["[\]]$/.test(t);
}

let matched = 0;
let repaired = 0;
let skippedLossy = 0;
const update = db.prepare(`UPDATE research_articles SET key_themes = ? WHERE id = ?`);

for (const row of rows) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.key_themes);
  } catch {
    parsed = row.key_themes; // mangled non-JSON string — clean as raw string
  }
  const cleaned = sanitizeThemeList(parsed);
  const cleanedJson = JSON.stringify(cleaned);

  // Skip rows where cleaning is a no-op on CONTENT — ignore pure JSON
  // formatting/whitespace noise from re-serialization or cap-induced
  // truncation of an already-healthy >5-theme row. Element-wise array
  // comparison (not string equality) so a healthy row's whitespace or key
  // order never masquerades as a "change": build the same trim+cap(5)
  // baseline sanitizeThemeList would apply to already-clean string elements,
  // and only count a row as a genuine hit when the cleaned array actually
  // differs element-by-element from that baseline.
  const originalStrings = Array.isArray(parsed)
    ? parsed
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .slice(0, 5)
    : null;
  const isCosmeticOnly =
    originalStrings !== null &&
    originalStrings.length === cleaned.length &&
    originalStrings.every((s, i) => s === cleaned[i]);
  if (isCosmeticOnly) continue;

  // A diff exists. If it's on an array (not the mangled-non-JSON-string
  // case) AND no source element shows a structural contamination
  // signature, the diff is the single-quote-strip artifact described above
  // — applying it would lose legitimate content, so skip and flag it
  // instead of writing.
  if (originalStrings !== null && !originalStrings.some(hasStructuralContamination)) {
    skippedLossy += 1;
    console.log(
      `row ${row.id}: SKIPPED (would lose legitimate content, no structural contamination found): ` +
        `${row.key_themes.slice(0, 100)} -> ${cleanedJson.slice(0, 100)}`
    );
    continue;
  }

  matched += 1;
  console.log(`row ${row.id}: ${row.key_themes.slice(0, 100)} -> ${cleanedJson.slice(0, 100)}`);
  if (apply) {
    update.run(cleanedJson, row.id);
    repaired += 1;
  }
}

if (skippedLossy > 0) {
  console.log(
    `\nSkipped ${skippedLossy} row(s) with no structural contamination signature — cleaning them ` +
      `would have clipped a legitimate trailing/leading single quote (sanitizeThemeList boundary-strip ` +
      `artifact, not real contamination). Left untouched; see script comment above for detail.`
  );
}

console.log(
  apply
    ? `Repaired ${repaired} of ${matched} rows.`
    : `Would repair ${matched} rows. Re-run with --apply.`
);
db.close();
