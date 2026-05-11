/**
 * Verify a generated briefing against deterministic inputs.
 *
 * Run: npx tsx scripts/verify-briefing-content.ts --weekOf 2026-05-04
 *
 * Checks:
 *   §6 macro-exposure verbatim — for each macro event with a deterministic
 *       exposure list, the rendered paragraph must contain every symbol in
 *       the list and no symbols that aren't.
 *   §3 earnings combined-position — for each held earnings event, the
 *       rendered paragraph must mention every account/leg.
 *   A1 price hallucination — every $price near a held symbol must be
 *       within 5% of the latest close in `prices`.
 *   A5 self-admission — regex sweep for "data looks corrupted" / "isn't
 *       available" patterns.
 *   A8 thesis paraphrase — every level mentioned must include the stored
 *       thesis text (substring tolerance).
 *
 * Exits 0 on PASS, 1 on any FAIL. Prints per-check verdict.
 */
import Database from "better-sqlite3";
import { buildMacroExposures } from "@/lib/calendar/briefing";
import { buildSelfAdmissionRegex } from "@/lib/calendar/briefing-self-admission";
import { getEventsByWeek, getBriefingByWeek } from "@/lib/queries/calendar";
import { issuerSiblings } from "@/lib/securities/issuer-family";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const weekOf = arg("--weekOf");
if (!weekOf) {
  console.error("Usage: npx tsx scripts/verify-briefing-content.ts --weekOf YYYY-MM-DD");
  process.exit(2);
}

const db = new Database("data/vanguard.db", { readonly: true });

const briefing = getBriefingByWeek(db, weekOf);
if (!briefing) {
  console.error(`No briefing in DB for week_of=${weekOf}. Generate first.`);
  process.exit(2);
}

const content = briefing.content;
console.log(`Briefing: week_of=${weekOf}, generated_at=${briefing.generated_at}, length=${content.length} chars\n`);

// ── Build the candidate symbol set from securities table ───────────
const allSymbolsRows = db
  .prepare("SELECT DISTINCT UPPER(symbol) AS s FROM securities WHERE symbol IS NOT NULL")
  .all() as Array<{ s: string }>;
const SECURITY_SYMBOLS = new Set(allSymbolsRows.map((r) => r.s));

// Common false positives — section labels, units, country/source acronyms
const SYMBOL_STOPLIST = new Set([
  "FOMC", "PCE", "GDP", "ISM", "ADP", "JOLTS", "ETF", "USD", "ETH", "BTC",
  "EPS", "REV", "Q1", "Q2", "Q3", "Q4", "YOY", "MOM", "PPI", "CPI",
  "BMO", "AMC", "DMH", "ITM", "OTM", "ATM", "BPS", "TWR", "XIRR",
  "API", "URL", "CSV", "PDF", "JSON", "SQL", "TWS", "IBKR", "WSH",
  "USA", "EU", "ECB", "FED", "ET", "PT", "MT", "ST", "EST", "EDT",
  "AT", "BY", "CO", "GO", "HE", "IF", "IN", "IS", "IT", "OF", "ON", "OR", "TO", "UP",
  "AI", "OK", "NO", "SO", "WE",
]);

// Tokenize a markdown blob for ALL_CAPS symbols in the security set
function extractSymbols(text: string): Set<string> {
  const found = new Set<string>();
  // Match standalone cap tokens; also pick up [SYM](...) links
  const re = /\b[A-Z]{1,5}(?:\.[A-Z])?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[0];
    if (SYMBOL_STOPLIST.has(tok)) continue;
    if (!SECURITY_SYMBOLS.has(tok)) continue;
    found.add(tok);
  }
  // Special handling for "BRK B" (space-separated)
  if (/\bBRK\s+B\b/i.test(text) && SECURITY_SYMBOLS.has("BRK B")) {
    found.add("BRK B");
  }
  return found;
}

// Extract a section by heading number OR by canonical title.
// Opus sometimes drops numbering ("## 6. Macro" → "## Macro"), so we accept
// both. Pass either an integer (1-7) or a title fragment.
const SECTION_TITLES: Record<number, string[]> = {
  1: ["week overview"],
  2: ["weekend reading", "weekend market context"],
  3: ["portfolio earnings"],
  4: ["options expiring", "expiring options"],
  5: ["price levels in play", "price levels"],
  6: ["macro & other events", "macro and other events", "macro events"],
  7: ["portfolio implications"],
};

function getSection(content: string, sectionNumber: number): string {
  const titles = SECTION_TITLES[sectionNumber] || [];
  // Match "## 6.", "## 6 ", "## **6.", OR "## <Title>"
  const numberRe = new RegExp(`^##\\s+\\*?\\*?${sectionNumber}\\b[^\\n]*$`, "m");
  const titleRe = new RegExp(
    `^##\\s+(?:${titles.map((t) => t.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).join("|")})\\b[^\\n]*$`,
    "im",
  );
  let startMatch = numberRe.exec(content);
  if (!startMatch && titles.length > 0) startMatch = titleRe.exec(content);
  if (!startMatch) return "";
  const start = startMatch.index;
  const nextHeading = /\n##\s+(?!#)/g;
  nextHeading.lastIndex = start + 1;
  const next = nextHeading.exec(content);
  const end = next ? next.index : content.length;
  return content.slice(start, end);
}

// Aliases for macro events whose stored title isn't how Opus refers to them.
function eventAliases(title: string): string[] {
  const t = title.toLowerCase();
  const aliases: string[] = [t];
  if (t.includes("personal income") || t.includes("pce")) aliases.push("pce");
  if (t.includes("gdp")) aliases.push("gdp");
  if (t.includes("ism manufacturing")) aliases.push("ism manufacturing", "ism mfg");
  if (t.includes("ism services")) aliases.push("ism services", "ism svc");
  if (t.includes("jobless claims")) aliases.push("jobless claims", "claims");
  if (t.includes("nonfarm payrolls")) aliases.push("nfp", "nonfarm", "payrolls");
  if (t.includes("jolts")) aliases.push("jolts");
  if (t.includes("housing starts")) aliases.push("housing starts");
  if (t.includes("durable goods")) aliases.push("durable goods", "durables");
  if (t.includes("trade balance")) aliases.push("trade balance");
  if (t.includes("consumer sentiment") || t.includes("u. of michigan")) aliases.push("umich", "consumer sentiment", "michigan");
  if (t.includes("consumer confidence")) aliases.push("consumer confidence");
  if (t.includes("ad p employment") || t.includes("adp employment")) aliases.push("adp");
  if (t.includes("fomc")) aliases.push("fomc");
  if (t.includes("new home sales")) aliases.push("home sales");
  return [...new Set(aliases)];
}

// Try to find the paragraph(s) discussing a given event title.
// Split section on ### subheadings only (each block = heading + body until
// next ###). This handles the common case of "### Day — Event Name" blocks
// without false-splitting between heading and body on a blank line.
function findEventParagraph(section: string, eventTitle: string): string | null {
  if (!section) return null;
  const blocks = section
    .split(/\n(?=###\s)/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const aliases = eventAliases(eventTitle);
  let bestBlock: string | null = null;
  let bestScore = 0;
  for (const block of blocks) {
    const lower = block.toLowerCase();
    let score = 0;
    for (const alias of aliases) {
      if (lower.includes(alias)) score += alias.split(/\s+/).length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestBlock = block;
    }
  }
  return bestScore >= 1 ? bestBlock : null;
}

// Extract every "Holdings exposed:" line and the symbols within.
// Returns array of {raw, symbols} in document order.
function extractHoldingsExposedLines(section: string): Array<{ raw: string; symbols: Set<string> }> {
  if (!section) return [];
  const lines: Array<{ raw: string; symbols: Set<string> }> = [];
  // Match "**Holdings exposed:**", "Holdings exposed:", "**Holdings exposure:**" etc
  const re = /\*?\*?holdings\s+exposed?\*?\*?\s*:\s*([^\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const tail = m[1];
    lines.push({ raw: tail.trim(), symbols: extractSymbols(tail) });
  }
  return lines;
}

let totalChecks = 0;
let totalFails = 0;

// ── Check 1: §6 macro-exposure verbatim ────────────────────────────
console.log("─── §6 Macro-exposure verbatim ───");
const events = getEventsByWeek(db, weekOf);
const macroEvents = events.filter(
  (e) => e.source !== "finnhub" && !(e.source === "wsh" && e.event_type === "earnings")
);
const exposures = buildMacroExposures(db, macroEvents);
const section6 = getSection(content, 6);

if (!section6) {
  console.log("  FAIL: could not locate §6 in briefing");
  totalFails++;
}

const exposedLines = extractHoldingsExposedLines(section6);
console.log(`  ${exposedLines.length} "Holdings exposed:" line(s) found in §6:`);
for (const line of exposedLines) console.log(`    → ${line.raw}`);
console.log("");

for (const e of macroEvents) {
  if (e.id == null) continue;
  const exp = exposures.get(e.id);
  if (!exp) continue; // no mapping → not subject to verbatim rule
  totalChecks++;
  const paragraph = findEventParagraph(section6, e.title);
  if (!paragraph) {
    console.log(`  FAIL [${e.title}]: no paragraph found in §6`);
    console.log(`    deterministic: ${exp.symbols.join(", ")}`);
    totalFails++;
    continue;
  }
  const expected = new Set(exp.symbols.map((s) => s.toUpperCase()));
  const actual = extractSymbols(paragraph);
  const missing = [...expected].filter((s) => !actual.has(s));
  // For "extra", restrict to symbols that aren't held by ANY of the macro
  // exposures or earnings events for this week — those are clear adds
  const allHeldThisWeek = new Set<string>();
  for (const x of exposures.values()) for (const s of x.symbols) allHeldThisWeek.add(s.toUpperCase());
  const earningsThisWeek = events
    .filter((e2) => e2.event_type === "earnings")
    .map((e2) => (e2.symbol || "").toUpperCase())
    .filter(Boolean);
  for (const s of earningsThisWeek) allHeldThisWeek.add(s);
  const extra = [...actual].filter((s) => !expected.has(s) && !allHeldThisWeek.has(s));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`  PASS [${e.title}]: ${expected.size} symbols matched`);
  } else {
    console.log(`  FAIL [${e.title}]:`);
    console.log(`    expected (${expected.size}): ${[...expected].sort().join(", ")}`);
    console.log(`    actual   (${actual.size}): ${[...actual].sort().join(", ")}`);
    if (missing.length) console.log(`    missing  (${missing.length}): ${missing.join(", ")}`);
    if (extra.length) console.log(`    extra    (${extra.length}): ${extra.join(", ")}`);
    totalFails++;
  }
}

// ── Check 2: §3 earnings combined-position ─────────────────────────
console.log("\n─── §3 Earnings combined-position ───");
const section3 = getSection(content, 3);
if (!section3) {
  console.log("  FAIL: could not locate §3 in briefing");
  totalFails++;
}

const earningsEvents = events.filter((e) => e.event_type === "earnings");
const heldEarningsCount = { checked: 0, missing: 0 };
for (const e of earningsEvents) {
  if (!e.symbol) continue;
  const family = issuerSiblings(e.symbol);
  const placeholders = family.map(() => "?").join(",");
  const positions = db
    .prepare(
      `SELECT a.name AS account_name, s.symbol, s.security_type
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       JOIN accounts a ON a.id = h.account_id
       WHERE (UPPER(s.symbol) IN (${placeholders})
           OR UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders}))
         AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
         AND h.quantity != 0`
    )
    .all(...family, ...family) as Array<{ account_name: string; symbol: string; security_type: string }>;
  if (positions.length === 0) continue; // not held → not subject to combined-position check

  totalChecks++;
  heldEarningsCount.checked++;
  const paragraph = findEventParagraph(section3, `${e.symbol} earnings`);
  const fallback = paragraph ?? section3; // fallback to whole section if per-event not found
  const lowerPara = fallback.toLowerCase();

  // The symbol itself must appear
  const symMentioned = lowerPara.includes(e.symbol.toLowerCase());
  // Check for option mention if any leg is an Option
  const hasOptions = positions.some((p) => p.security_type.toLowerCase() === "option");
  // Check for cross-account mention if multiple accounts
  const accounts = new Set(positions.map((p) => p.account_name));
  const multiAccount = accounts.size > 1;

  const issues: string[] = [];
  if (!symMentioned) issues.push(`symbol not mentioned`);
  if (hasOptions) {
    const optionCues = ["call", "put", "leap", "option", "strike", "contract"];
    const cueHit = optionCues.some((c) => lowerPara.includes(c));
    if (!cueHit) issues.push(`held option leg but no option cue`);
  }
  if (multiAccount) {
    const accCues = [...accounts].filter((a) => lowerPara.includes(a.toLowerCase()));
    if (accCues.length < accounts.size) {
      const missingAccs = [...accounts].filter((a) => !lowerPara.includes(a.toLowerCase()));
      issues.push(`accounts not surfaced: ${missingAccs.join(", ")}`);
    }
  }

  if (issues.length === 0) {
    console.log(`  PASS [${e.symbol}]: ${positions.length} legs covered`);
  } else {
    console.log(`  FAIL [${e.symbol}]: ${issues.join("; ")}`);
    heldEarningsCount.missing++;
    totalFails++;
  }
}

// ── Check 3: A1 price hallucination ────────────────────────────────
console.log("\n─── A1 Price-hallucination scan ───");
// For every held symbol, find $X.XX or $X mentions in §1 + §2 + §3 + §6 + §7,
// pull each $value and the latest close from `prices` table for spot-comparison.
const heldSymbolsRows = db
  .prepare(
    `SELECT DISTINCT UPPER(s.symbol) AS sym
     FROM holdings h
     JOIN securities s ON s.id = h.security_id
     WHERE h.quantity != 0
       AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings h2 WHERE h2.account_id = h.account_id)
       AND s.security_type IN ('Stock', 'stock', 'Common Stock', 'common stock', 'ETF')`
  )
  .all() as Array<{ sym: string }>;
const HELD_STOCKS = new Set(heldSymbolsRows.map((r) => r.sym));

const latestPriceStmt = db.prepare(
  `SELECT close_price AS price FROM prices p
   JOIN securities s ON s.id = p.security_id
   WHERE UPPER(s.symbol) = ?
   ORDER BY date DESC LIMIT 1`
);

const priceHits: Array<{ symbol: string; cited: number; latest: number; deltaPct: number; context: string }> = [];
const priceRe = /\b([A-Z]{1,5})\b[^.\n]{0,80}?\$\s?(\d{1,5}(?:\.\d{1,2})?)/g;
// Skip patterns that signal EPS / dividend / consensus / strike / premium etc
const NOT_A_PRICE_RE = /\b(eps|earnings\s+per\s+share|dividend|div\.|yield|consensus|strike|premium|cost\s+basis|paid|bought|sold|@|target|upside|cents?\s+per|per\s+share|spent|raised|guidance|guides?|prelim|estimate)\b/i;
let pm: RegExpExecArray | null;
while ((pm = priceRe.exec(content)) !== null) {
  const sym = pm[1];
  const cited = parseFloat(pm[2]);
  if (!HELD_STOCKS.has(sym)) continue;
  if (SYMBOL_STOPLIST.has(sym)) continue;
  if (cited > 10000 || cited < 0.5) continue;
  const row = latestPriceStmt.get(sym) as { price: number } | undefined;
  if (!row || row.price == null) continue;
  const latest = row.price;
  // 100-char window around the match to check for non-price context
  const winStart = Math.max(0, pm.index - 50);
  const winEnd = Math.min(content.length, pm.index + (pm[0]?.length ?? 0) + 50);
  const window = content.slice(winStart, winEnd);
  if (NOT_A_PRICE_RE.test(window)) continue; // EPS / dividend / strike etc — not a stock price
  // Order-of-magnitude filter: if cited is < 20% of latest OR > 5x latest,
  // it's almost certainly not a stock price quote (EPS / strike / etc that slipped past)
  if (cited < latest * 0.2 || cited > latest * 5) continue;
  const deltaPct = Math.abs(cited - latest) / latest;
  priceHits.push({ symbol: sym, cited, latest, deltaPct, context: window.replace(/\s+/g, " ").trim() });
}

const priceFails = priceHits.filter((h) => h.deltaPct > 0.05);
totalChecks += priceHits.length;
if (priceHits.length === 0) {
  console.log("  (no held-stock price citations detected)");
} else {
  for (const h of priceHits) {
    const tag = h.deltaPct > 0.05 ? "FAIL" : "ok  ";
    console.log(`  ${tag} ${h.symbol}: cited $${h.cited.toFixed(2)}, latest $${h.latest.toFixed(2)} (Δ ${(h.deltaPct * 100).toFixed(1)}%)`);
    if (h.deltaPct > 0.05) console.log(`         context: …${h.context}…`);
  }
  totalFails += priceFails.length;
}

// ── Check 4: A5 self-admission scan ────────────────────────────────
// Regex shared with the auto-regen path in `lib/calendar/briefing.ts`
// (single source of truth) — keep `briefing-self-admission.ts` as the
// only place patterns are defined so a tightening here lands in both.
console.log("\n─── A5 Self-admission scan ───");
const selfAdmitRe = buildSelfAdmissionRegex();
const admissions: string[] = [];
let am: RegExpExecArray | null;
while ((am = selfAdmitRe.exec(content)) !== null) {
  const start = Math.max(0, am.index - 40);
  const end = Math.min(content.length, am.index + 100);
  admissions.push(content.slice(start, end).replace(/\n/g, " "));
}
totalChecks++;
if (admissions.length === 0) {
  console.log("  PASS: no self-admission patterns detected");
} else {
  console.log(`  FAIL: ${admissions.length} admission(s):`);
  for (const a of admissions) console.log(`    …${a}…`);
  totalFails++;
}

// ── Check 5: A8 thesis paraphrase ──────────────────────────────────
console.log("\n─── A8 Level-thesis verbatim ───");
// For each level in the §4 paragraph that mentions a symbol, check if its
// stored thesis text appears (substring tolerance).
const section4 = getSection(content, 4);
const levelsRows = db
  .prepare(
    `SELECT s.symbol, l.price, l.thesis, l.direction, l.level_type
     FROM security_levels l
     JOIN securities s ON s.id = l.security_id
     WHERE l.is_active = 1
       AND l.review_status = 'auto_approved'
       AND l.thesis IS NOT NULL
       AND length(l.thesis) > 10`
  )
  .all() as Array<{ symbol: string; price: number; thesis: string; direction: string; level_type: string }>;

let thesisChecked = 0;
let thesisFailed = 0;
for (const lv of levelsRows) {
  // Only check levels whose symbol is mentioned in §4
  if (!section4 || !section4.toUpperCase().includes(lv.symbol.toUpperCase())) continue;
  thesisChecked++;
  // Pull a 6-word fingerprint from the thesis
  const fingerprint = lv.thesis
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4)
    .join(" ");
  if (fingerprint && section4.toLowerCase().includes(fingerprint)) {
    // PASS — thesis substring found
  } else {
    // Soft-fail (likely paraphrased not quoted)
    thesisFailed++;
    console.log(`  WARN [${lv.symbol} @ ${lv.price}]: thesis fingerprint "${fingerprint}" not in §4 verbatim`);
  }
}
totalChecks++;
if (thesisChecked === 0) {
  console.log("  (no levels with stored thesis intersect §4 — nothing to check)");
} else if (thesisFailed === 0) {
  console.log(`  PASS: ${thesisChecked}/${thesisChecked} thesis fingerprints in §4`);
} else {
  console.log(`  ${thesisChecked - thesisFailed}/${thesisChecked} pass; A8 is currently a soft directive — not counted as hard FAIL`);
}

// ── Verdict ────────────────────────────────────────────────────────
console.log("\n─── Verdict ───");
console.log(`Total checks: ${totalChecks}`);
console.log(`Total fails:  ${totalFails}`);
if (totalFails === 0) {
  console.log("\n✓ PASS — briefing matches deterministic inputs");
  process.exit(0);
} else {
  console.log(`\n✗ FAIL — ${totalFails} check(s) failed; review above`);
  process.exit(1);
}
