/**
 * A large synthetic book for the tool output size guard (Portfolio Assistant
 * plan, Task 8 follow-up). Synthetic tickers (ZB…), synthetic figures only.
 *
 * 300 holdings across 3 accounts (100 each), 80 live option contracts, 10
 * years of monthly snapshots per account, 36 months of trade reviews with 20
 * graded round trips each, 10,000 transactions, plus calendar, levels,
 * alerts, notes, briefings, research and analyst rows at realistic text
 * lengths. Every tool is then called at its maximum (WORST_CASE_CALLS).
 */
import type Database from "better-sqlite3";
import { todayET, addDays } from "@/lib/calendar/date-utils";

export const text = (n: number, seed: string): string =>
  (seed + " ").repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);

export function seedSizeBook(db: Database.Database): void {
  const today = todayET();
  const yesterday = addDays(today, -1);
  db.transaction(() => {
    const sec = db.prepare(
      "INSERT INTO securities (symbol, name, security_type, currency, sector, asset_class, multiplier) VALUES (?, ?, 'stock', 'USD', ?, 'equity', 1)",
    );
    const hold = db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const price = db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
    const lot = db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, 10, 10, ?)`,
    );
    const sectors = ["Technology", "Financials", "Healthcare", "Industrials", "Energy"];
    const stockIds: number[] = [];
    for (let i = 0; i < 300; i++) {
      const account = (i % 3) + 1;
      const id = sec.run(`ZB${i}`, `ZB${i} Industries Incorporated`, sectors[i % 5]).lastInsertRowid as number;
      stockIds.push(id);
      hold.run(account, id, 10 + (i % 40), 1000 + i * 3.17, today, `sb-h${i}`);
      hold.run(account, id, 10 + (i % 40), 1000 + i * 3.17, yesterday, `sb-hy${i}`);
      price.run(id, today, 100 + i / 7);
      price.run(id, yesterday, 99 + i / 6);
      lot.run(account, id, addDays(today, -400 - i), 100 + i / 3, 1000 + i * 3.17);
    }
    // The market snapshot's benchmarks.
    for (const b of ["SPY", "QQQ", "DIA"]) {
      const id = db
        .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'etf', 'USD')")
        .run(b, `${b} Trust`).lastInsertRowid as number;
      price.run(id, today, 500);
      price.run(id, yesterday, 495);
    }
    // Ten years of daily closes for one name (price history at its cap).
    for (let d = 0; d < 3650; d++) price.run(stockIds[0], addDays(today, -d), 100 + (d % 50) / 3);

    // 80 live option contracts in IBKR (account 3).
    const opt = db.prepare(
      `INSERT INTO securities (symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
       VALUES (?, 'option', ?, ?, ?, ?, 100, 'USD')`,
    );
    for (let i = 0; i < 80; i++) {
      const und = `ZB${i}`;
      const type = i % 2 ? "CALL" : "PUT";
      const id = opt.run(`${und} ${type} ${100 + i}`, type, 100 + i, addDays(today, 10 + i), und).lastInsertRowid as number;
      hold.run(3, id, i % 3 === 0 ? -2 : 3, 0, today, `sb-o${i}`);
      price.run(id, today, 2 + i / 10);
      price.run(id, yesterday, 2.1 + i / 10);
    }

    // 10 years of monthly snapshots per account; daily valuations for a year.
    const snap = db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, starting_value, deposits_withdrawals, dividends, interest, fees, twr, investment_gain)
       VALUES (?, ?, ?, 'statement', ?, 100, 12.5, 3.25, 1.5, 0.0123, 210.75)`,
    );
    for (let a = 1; a <= 3; a++) {
      for (let m = 0; m < 120; m++) {
        const d = new Date(Date.UTC(2016, 11 + m + 1, 0)).toISOString().slice(0, 10);
        snap.run(a, d, 100000 + m * 500 + a, 99500 + m * 500);
      }
    }
    const dv = db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 1000, ?, ?)",
    );
    for (let a = 1; a <= 3; a++) for (let d = 0; d < 365; d++) dv.run(a, addDays(today, -d), 90000 + d, 91000 + d);

    // 10,000 transactions: buys, dividends, interest and fees over ten years.
    const tx = db.prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
    );
    const types = ["BUY", "DIVIDEND", "INTEREST", "FEE"];
    for (let i = 0; i < 10000; i++) {
      const t = types[i % 4];
      const s = stockIds[i % 300];
      tx.run((i % 3) + 1, t === "INTEREST" || t === "FEE" ? null : s, addDays(today, -(i % 3650)), t,
        t === "BUY" ? 5 : null, t === "BUY" ? 100 + (i % 30) : null,
        t === "BUY" ? -(500 + (i % 30)) : t === "FEE" ? -1.25 : 2.5 + (i % 7), `sb-t${i}`);
    }

    // 36 monthly trade reviews for IBKR, 20 graded round trips each.
    const review = db.prepare(
      `INSERT INTO trade_reviews (account_id, period_start, period_end, total_trades, winning_trades, losing_trades, win_rate, total_realized_pnl, avg_holding_days, best_trade_pnl, best_trade_symbol, worst_trade_pnl, worst_trade_symbol, profit_factor, review_markdown, patterns_identified, strengths, weaknesses)
       VALUES (3, ?, ?, 20, 12, 8, 0.6, 1250.5, 14.2, 400.25, 'ZB1', -210.5, 'ZB2', 1.8, ?, ?, ?, ?)`,
    );
    const rt = db.prepare(
      `INSERT INTO trade_roundtrips (review_id, account_id, security_id, symbol, entry_date, entry_price, entry_quantity, entry_cost, exit_date, exit_price, exit_quantity, exit_proceeds, holding_days, realized_pnl, return_pct, grade, what_went_well, what_went_wrong, assessment)
       VALUES (?, 3, ?, ?, ?, 100, 10, 1000, ?, 105, 10, 1050, 12, 50, 5, 'B', ?, ?, ?)`,
    );
    for (let m = 0; m < 36; m++) {
      const start = new Date(Date.UTC(2023, m, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(2023, m + 1, 0)).toISOString().slice(0, 10);
      const rid = review.run(start, end, text(6000, `review ${m}`), text(800, "patterns"), text(500, "strengths"), text(500, "weaknesses")).lastInsertRowid as number;
      for (let k = 0; k < 20; k++) {
        rt.run(rid, stockIds[k], `ZB${k}`, start, end, text(300, "went well"), text(300, "went wrong"), text(400, "assessment"));
      }
    }

    // Calendar: 300 upcoming earnings and 60 past releases with reactions.
    const ev = db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, description, symbol, expected_impact, consensus_estimate, previous_value, actual_value, reaction_snapshot, enriched_at, source_key)
       VALUES ('t', ?, ?, 'AMC', ?, ?, ?, 'medium', 'EPS 1.23', 'EPS 1.10', ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 300; i++) {
      ev.run("earnings", addDays(today, (i % 90) + 1), `ZB${i} Q3 earnings call`, text(300, `event detail ${i}`), `ZB${i}`, null, null, null, `sb-e${i}`);
    }
    const snapJson = JSON.stringify({
      t0_utc: "2026-10-01T12:30:00Z",
      window_min: 120,
      source: "ibkr",
      spy: { symbol: "SPY", t_pre: 500, t_post: 502, delta_pct: 0.4 },
      qqq: { symbol: "QQQ", t_pre: 400, t_post: 403, delta_pct: 0.75 },
      tlt: { symbol: "TLT", t_pre: 90, t_post: 89.5, delta_pct: -0.56 },
      sector: { symbol: "XLK", t_pre: 200, t_post: 201, delta_pct: 0.5 },
    });
    for (let i = 0; i < 60; i++) {
      ev.run("cpi", addDays(today, -30 - i * 7), `CPI release ${i}`, text(300, "macro"), null, "3.1%", snapJson, `${addDays(today, -30 - i * 7)} 20:00:00`, `sb-m${i}`);
    }

    // Levels and alerts: 300 each with realistic thesis and action text.
    const lvl = db.prepare(
      "INSERT INTO security_levels (security_id, level_type, price, source, source_author, thesis, timeframe) VALUES (?, 'support', ?, 'newsletter', 'Eliant Capital', ?, 'swing')",
    );
    const al = db.prepare(
      "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, suggested_action, user_response) VALUES (?, ?, datetime('now', ?), ?, ?, 'pending')",
    );
    for (let i = 0; i < 300; i++) {
      const lid = lvl.run(stockIds[i], 90 + i / 3, text(500, `level thesis ${i}`)).lastInsertRowid as number;
      al.run(lid, stockIds[i], `-${i + 1} hours`, 91 + i / 3, text(800, `suggested action ${i}`));
    }

    // Notes, briefings, research.
    const note = db.prepare("INSERT INTO notes (note_type, content, security_id, event_date, tags) VALUES ('earnings', ?, ?, ?, '[\"earnings\",\"guidance\"]')");
    for (let i = 0; i < 100; i++) note.run(text(1500, `note body ${i}`), stockIds[i], addDays(today, -i));
    for (let w = 0; w < 6; w++) {
      db.prepare(
        "INSERT INTO calendar_briefings (week_of, title, content, event_count, generated_at) VALUES (?, ?, ?, 25, datetime('now'))",
      ).run(addDays("2026-09-28", 7 * w), `Week ${w}`, text(30000, `briefing ${w}`));
    }
    const art = db.prepare(
      `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text, summary, sentiment, key_themes, mentioned_symbols, portfolio_relevance, processed_at)
       VALUES (1, datetime('now', ?), ?, 'feed@example.com', 'body', ?, 'neutral', '["rates","semis","ai"]', '["ZB1","ZB2","ZB3"]', ?, datetime('now', ?))`,
    );
    for (let i = 0; i < 100; i++) art.run(`-${i} hours`, `Morning note ${i}`, text(800, `summary ${i}`), text(280, `relevance ${i}`), `-${i} hours`);
    const doc = db.prepare(
      `INSERT INTO research_documents (title, author, source, filename, raw_text, summary, key_points, mentioned_symbols, tags, document_type, publication_date)
       VALUES (?, 'Analyst', 'Bank', ?, 'body', ?, ?, '["ZB1","ZB2"]', '["semis","rates"]', 'analyst_report', ?)`,
    );
    for (let i = 0; i < 40; i++) {
      doc.run(`Report ${i}`, `r${i}.pdf`, text(1200, `doc summary ${i}`), JSON.stringify(Array.from({ length: 6 }, (_, k) => text(150, `point ${k}`))), addDays(today, -i));
    }
    const pr = db.prepare(
      "INSERT INTO press_releases (finnhub_id, symbol, headline, summary, source, category, url, published_at) VALUES (?, 'ZB1', ?, ?, 'Business Wire', 'company news', ?, ?)",
    );
    for (let i = 0; i < 150; i++) {
      pr.run(i + 1, `ZB1 announces item ${i}`, text(500, `press summary ${i}`), `https://example.com/pr/${i}`, `${addDays(today, -(i % 300))}T13:00:00Z`);
    }
    const rec = db.prepare("INSERT INTO analyst_recommendations (symbol, period, strong_buy, buy, hold, sell, strong_sell) VALUES ('ZB1', ?, 5, 10, 6, 1, 0)");
    for (let m = 0; m < 30; m++) rec.run(new Date(Date.UTC(2024, m, 1)).toISOString().slice(0, 10));
    const rc = db.prepare("INSERT INTO analyst_rating_changes (symbol, rating_date, firm, from_grade, to_grade, action) VALUES ('ZB1', ?, ?, 'Hold', 'Buy', 'up')");
    for (let i = 0; i < 60; i++) rc.run(addDays(today, -i * 5), `Firm ${i}`);
    db.prepare(
      "INSERT INTO analyst_price_targets (symbol, target_high, target_low, target_mean, target_median, number_of_analysts, last_updated) VALUES ('ZB1', 200, 100, 150, 150, 30, ?)",
    ).run(today);
  })();
}

/** Each tool at its worst realistic case (maximum limits and windows). */
export const WORST_CASE_CALLS: Array<[string, Record<string, unknown>]> = [
  ["query_holdings", { limit: 200 }],
  ["query_price_history", { symbol: "ZB0", start_date: "2010-01-01" }],
  ["query_allocation", { group_by: "symbol", limit: 200 }],
  ["query_tax_lots", { status: "all", limit: 200 }],
  ["query_transactions", { limit: 200 }],
  ["query_performance", { months: 120 }],
  ["query_income_summary", { period: "all_time", group_by: "symbol" }],
  ["query_twr", { period: "inception" }],
  ["query_fred", { series_id: "DGS10", limit: 100 }],
  ["query_company_fundamentals", { ticker: "ZB1", include_filings: true }],
  ["query_insider_trades", { ticker: "ZB1", limit: 20 }],
  ["query_notes", { limit: 30 }],
  ["create_note", { note_type: "journal", content: text(2000, "a long thought") }],
  ["query_analyst_coverage", { ticker: "ZB1", months_history: 24, rating_changes_limit: 50 }],
  ["query_press_releases", { ticker: "ZB1", days_back: 365, limit: 100 }],
  ["query_earnings_transcript", { ticker: "ZB1", include_full_text: true }],
  ["query_research_documents", { limit: 25 }],
  ["query_filing_section", { ticker: "ZB1", filing_type: "10-K", section: "risk_factors" }],
  ["query_trade_reviews", { period_start: "2023-06-01", include_grades: true }],
  ["query_options_greeks", {}],
  ["query_research_feeds", { days_back: 365, limit: 50 }],
  ["query_calendar_events", { days_ahead: 365, limit: 100 }],
  ["query_calendar_briefings", { weeks_back: 4 }],
  ["query_levels", { limit: 100 }],
  ["query_alerts", { limit: 50, since_days: 365 }],
  ["query_release_reactions", { limit: 50 }],
  ["query_market_snapshot", {}],
  ["query_risk", {}],
  ["query_scenarios", {}],
  ["query_performance_vs_benchmark", {}],
  ["query_realized_gains", { include_rows: true, limit: 50 }],
  ["query_options_book", { days: 120, limit: 50 }],
  ["query_data_confidence", {}],
];

/** Tools whose output is deliberately not capped (the full transcript text). */
export const SIZE_GUARD_EXEMPT: ReadonlySet<string> = new Set(["query_earnings_transcript"]);
