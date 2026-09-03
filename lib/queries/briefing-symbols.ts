import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getArmedEventIds, getArmedSymbolsInHorizon } from "./earnings-worksheet-flags";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * Returns distinct stock symbols currently held across all accounts (latest
 * per (account, security), quantity > 0). Excludes ETFs, bonds, options,
 * and mutual funds — only individual equities where an earnings release is
 * a meaningful event.
 *
 * Case-insensitive on security_type (DB stores capitalized values like
 * "Stock", "ETF", "Bond", "Option", "Mutual Fund"; see CLAUDE.md).
 */
export function getHeldStockSymbols(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
         AND s.symbol IS NOT NULL
         AND s.symbol != ''
         AND ${latestHoldingsPredicate({ includeShorts: false })}
       ORDER BY s.symbol`
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * Resolve a symbol to its current security_id (if we hold it). Used by the
 * Finnhub fetch to attach security_id on calendar_events rows so the chat +
 * briefing layers can cross-reference holdings.
 */
export function getSecurityIdForSymbol(
  db: Database.Database,
  symbol: string
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM securities WHERE symbol = ? AND LOWER(COALESCE(security_type, '')) IN ('stock', 'common stock') LIMIT 1`
    )
    .get(symbol) as { id: number } | undefined;
  return row?.id ?? null;
}

export type SymbolStatus = "held" | "watchlist" | "armed" | "neither";
export interface SymbolStatusReasons {
  held: boolean;
  watchlist: boolean;
  armed: boolean;
}

/**
 * Held / watchlist (family-aware, unchanged) plus the DISPLAY-ONLY `armed`
 * reason: the symbol (or a share-class sibling) has an unsuperseded earnings
 * event within 14 ET days carrying a worksheet flag. Precedence held >
 * watchlist > armed > neither. Event decisions never use this — they call
 * coveredForEvents / isEventArmed (spec §4.1).
 *
 * Symbols are matched case-insensitively on the input + DB sides so the
 * caller doesn't need to upper-case before passing. Empty input returns `{}`.
 */
export function getSymbolStatusDetailed(
  db: Database.Database,
  symbols: string[],
  opts: { today?: string } = {},
): Record<string, { status: SymbolStatus; reasons: SymbolStatusReasons }> {
  if (symbols.length === 0) return {};
  const upperInput = symbols.map((s) => s.toUpperCase());

  // Dual-class aware: GOOGL's earnings event should classify as "held" when
  // the user holds GOOG (or any sibling). We expand each input symbol to its
  // family, query against the union, then collapse the held/watchlist hits
  // back through the family to the original input keys.
  const inputFamilies = new Map<string, readonly string[]>();
  for (const sym of upperInput) {
    if (inputFamilies.has(sym)) continue;
    inputFamilies.set(sym, issuerSiblings(sym).map((s) => s.toUpperCase()));
  }

  const allFamilyMembers = new Set<string>();
  for (const fam of inputFamilies.values()) {
    for (const m of fam) allFamilyMembers.add(m);
  }

  const armedSymbols = getArmedSymbolsInHorizon(db, { today: opts.today ?? todayET() });

  const buildOut = (
    held: Set<string>,
    watched: Set<string>,
  ): Record<string, { status: SymbolStatus; reasons: SymbolStatusReasons }> => {
    const out: Record<string, { status: SymbolStatus; reasons: SymbolStatusReasons }> = {};
    for (const sym of upperInput) {
      const family = inputFamilies.get(sym) ?? [sym];
      const reasons: SymbolStatusReasons = {
        held: family.some((m) => held.has(m)),
        watchlist: family.some((m) => watched.has(m)),
        armed: family.some((m) => armedSymbols.has(m)),
      };
      const status: SymbolStatus = reasons.held
        ? "held"
        : reasons.watchlist
          ? "watchlist"
          : reasons.armed
            ? "armed"
            : "neither";
      out[sym] = { status, reasons };
    }
    return out;
  };

  if (allFamilyMembers.size === 0) {
    return buildOut(new Set(), new Set());
  }
  const distinctInput = Array.from(allFamilyMembers);
  const placeholders = distinctInput.map(() => "?").join(",");

  // A short into a print is exposure — aligns with the option branch below
  // and getCrossAccountPositions (B7); quantity != 0 rather than > 0.
  const heldRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE UPPER(s.symbol) IN (${placeholders})
          AND h.quantity != 0
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
          )`,
    )
    .all(...distinctInput) as { symbol: string }[];
  const held = new Set(heldRows.map((r) => r.symbol));

  // Option-only exposure counts as held: a TER LEAP with no TER stock still
  // makes TER's print matter (same look-through the earnings composer does
  // via underlying_symbol). Unexpired, quantity != 0 (shorts carry exposure).
  const optionHeldRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.underlying_symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders})
          AND LOWER(COALESCE(s.security_type, '')) = 'option'
          AND h.quantity != 0
          AND (s.expiration_date IS NULL OR s.expiration_date >= date('now'))
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )`,
    )
    .all(...distinctInput) as { symbol: string }[];
  for (const r of optionHeldRows) held.add(r.symbol);

  const watchlistRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND UPPER(s.symbol) IN (${placeholders})`,
    )
    .all(...distinctInput) as { symbol: string }[];
  const watched = new Set(watchlistRows.map((r) => r.symbol));

  return buildOut(held, watched);
}

/**
 * Classify a batch of symbols as held / watchlist / armed / neither in one
 * round trip. Used by the EarningsHub block on `/dashboard/today` to render
 * a status chip per row, and by Phase-3's email-sweep to filter candidate
 * events to only held + watchlist names (no inbox flooding from S&P-500
 * earnings the user doesn't own or care about).
 *
 * Held wins over watchlist wins over armed when more than one applies.
 * DISPLAY-ONLY — an event coverage decision must use coveredForEvents /
 * isEventArmed instead (spec §4.1), never this status string.
 */
export function getSymbolStatus(
  db: Database.Database,
  symbols: string[],
  opts: { today?: string } = {},
): Record<string, SymbolStatus> {
  const detailed = getSymbolStatusDetailed(db, symbols, opts);
  const out: Record<string, SymbolStatus> = {};
  for (const [k, v] of Object.entries(detailed)) out[k] = v.status;
  return out;
}

/** Event-scoped coverage (spec §4.1 consumer matrix): held or watchlist
 *  (family-aware) OR isEventArmed(eventId). Returns the covered event ids. */
export function coveredForEvents(
  db: Database.Database,
  rows: Array<{ symbol: string | null; eventId: number }>,
): Set<number> {
  const out = new Set<number>();
  if (rows.length === 0) return out;
  const symbols = Array.from(
    new Set(
      rows
        .map((r) => r.symbol)
        .filter((s): s is string => !!s)
        .map((s) => s.toUpperCase()),
    ),
  );
  const detailed = getSymbolStatusDetailed(db, symbols);
  const armed = getArmedEventIds(
    db,
    rows.map((r) => r.eventId),
  );
  for (const r of rows) {
    const reasons = r.symbol ? detailed[r.symbol.toUpperCase()]?.reasons : undefined;
    if ((reasons && (reasons.held || reasons.watchlist)) || armed.has(r.eventId)) out.add(r.eventId);
  }
  return out;
}

export function coveredForEvent(db: Database.Database, symbol: string | null, eventId: number): boolean {
  return coveredForEvents(db, [{ symbol, eventId }]).has(eventId);
}

/**
 * Distinct underlyings of currently-held unexpired options (quantity != 0).
 * Fed into the Finnhub earnings scan so option-only names get their events
 * synced (Wave 1 B10 — a TER-LEAP-only book must still see TER's print).
 */
export function getHeldOptionUnderlyingSymbols(db: Database.Database): string[] {
  // Fund-type underlyings are excluded: both consumers (the Finnhub/Nasdaq
  // earnings scan in lib/calendar/sync.ts and the coverage guard) are
  // earnings surfaces, and an ETF/mutual-fund underlying never reports —
  // the book's index-hedge options (SPY/XLF/SOXX puts) were producing
  // guard "no_history gaps" and pointless Finnhub queries (guard debut
  // triage, 2026-07-16). NULL / missing-row underlyings are KEPT: unknown
  // is not proven-fund, and real single-name exposure must never be
  // silently dropped.
  const rows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.underlying_symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         LEFT JOIN securities u ON UPPER(u.symbol) = UPPER(s.underlying_symbol)
        WHERE LOWER(COALESCE(s.security_type, '')) = 'option'
          AND s.underlying_symbol IS NOT NULL AND s.underlying_symbol != ''
          AND LOWER(COALESCE(u.security_type, '')) NOT IN ('etf', 'mutual fund')
          AND h.quantity != 0
          AND (s.expiration_date IS NULL OR s.expiration_date >= date('now'))
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )
        ORDER BY symbol`,
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * Resolve `symbol` to a `security_id` we can link to. Falls back to issuer
 * siblings if the exact symbol isn't in the securities table — e.g., the
 * Finnhub event for GOOGL still resolves to the GOOG securities row when
 * that's the only sibling we own. Returns null only when no family member
 * is in the table.
 */
export function getSecurityIdForSymbolWithSiblings(
  db: Database.Database,
  symbol: string,
): number | null {
  const family = issuerSiblings(symbol);
  for (const candidate of family) {
    const row = db
      .prepare(`SELECT id FROM securities WHERE UPPER(symbol) = ? LIMIT 1`)
      .get(candidate.toUpperCase()) as { id: number } | undefined;
    if (row) return row.id;
  }
  return null;
}
