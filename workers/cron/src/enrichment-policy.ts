/**
 * Which research sources are AI-summarized — the ONE rule (owner ruling
 * 2026-11-02, AI-spend cut). Import-free on purpose: the Cloudflare Worker
 * carries a byte-identical copy at `workers/cron/src/enrichment-policy.ts`
 * (parity-pinned by tests/gmail/enrichment-policy.test.ts). Change both.
 *
 * Keyed by `research_sources.name`, the same key `SOURCE_KINDS` uses in
 * lib/digest/editions.ts. A source is ONE row however its senders spell the
 * display name (Bloomberg Odd Lots arrives as "Bloomberg Odd Lots <..>",
 * "Bloomberg <..>" and "Mark Gurman at Bloomberg <..>" from one address), so
 * the source name covers every variant and the article's `sender` string is
 * never read.
 *
 * Ingestion is unchanged: these articles are still fetched and stored, and
 * stay searchable. They are only never sent to the model. An article already
 * queued (processed_at NULL) simply stops being selected; nothing is deleted.
 */

/** Sources that are never summarized. */
export const UNSUMMARIZED_SOURCES: readonly string[] = [
  "Semi Doped",
  "Bloomberg Odd Lots",
  "TBPN",
];

/**
 * Sources summarized only when the subject carries the marker. Vital
 * Knowledge: only "Vital Dawn", the early-morning flagship. Verified against
 * stored subjects 2026-11-02: every Dawn issue reads
 * "Vital Knowledge: Vital Dawn for <Weekday> <Month> <day>, <year>", and no
 * other issue contains "Dawn" (Market Recap, Mid-Day Market Update,
 * Company-specific news, Weekend, Talking Points, Catalyst Watch, and the
 * topical notes all differ).
 */
export const SUBJECT_GATED_SOURCES: Readonly<Record<string, string>> = {
  "Vital Knowledge": "Vital Dawn",
};

/** True when this source's article may be sent to the model. */
export function shouldSummarizeArticle(sourceName: string, subject: string): boolean {
  const name = sourceName.trim().toLowerCase();
  if (UNSUMMARIZED_SOURCES.some((s) => s.toLowerCase() === name)) return false;
  for (const [gated, marker] of Object.entries(SUBJECT_GATED_SOURCES)) {
    if (gated.toLowerCase() === name) {
      return subject.toLowerCase().includes(marker.toLowerCase());
    }
  }
  return true;
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function sqlLikeLiteral(s: string): string {
  return sqlQuote(`%${s.replace(/[\\%_]/g, "\\$&")}%`);
}

/**
 * SQL twin of `shouldSummarizeArticle` for the queue SELECT (an AND-able
 * condition over `s.name` and `a.subject`). The skip has to live in the query:
 * filtering after `LIMIT 20` would let skipped rows fill the newest-first
 * window and starve every article behind them. SQLite `=` / LIKE here are
 * ASCII case-insensitive via LOWER()/LIKE; parity with the JS rule is pinned.
 */
export function summarizableArticleSql(nameCol = "s.name", subjectCol = "a.subject"): string {
  const parts: string[] = [];
  if (UNSUMMARIZED_SOURCES.length > 0) {
    parts.push(
      `LOWER(TRIM(${nameCol})) NOT IN (${UNSUMMARIZED_SOURCES.map((s) => sqlQuote(s.toLowerCase())).join(", ")})`,
    );
  }
  for (const [gated, marker] of Object.entries(SUBJECT_GATED_SOURCES)) {
    parts.push(
      `(LOWER(TRIM(${nameCol})) <> ${sqlQuote(gated.toLowerCase())} OR ${subjectCol} LIKE ${sqlLikeLiteral(marker)} ESCAPE '\\')`,
    );
  }
  return parts.length > 0 ? parts.join(" AND ") : "1";
}
