# Trade Review System — Design Doc

> **Status:** Design only — not yet implemented
> **Created:** 2026-03-29
> **Purpose:** Monthly AI-driven trade analysis that provides immediate feedback per statement period, persists reviews for longitudinal pattern recognition, and builds a cumulative trading improvement profile over time.

## Problem

A short-term trader making frequent trades (days/weeks holding periods) needs structured feedback on their decisions. Current tools show *what* happened (P&L, tax lots) but not *why* it happened or whether the decision-making was sound. One month of trades doesn't reveal behavioral patterns — you need 3-6+ months to spot tendencies like "cuts winners too early in rallies" or "holds losers through earnings hoping for recovery."

## User Story

1. User uploads IBKR monthly activity statement (existing import flow)
2. System detects the new month's trades and offers to generate a trade review
3. AI analyzes every round-trip trade: entry thesis (inferred from context), exit quality, timing, sizing
4. Produces a monthly review with trade grades, win/loss analysis, and tactical feedback
5. Review is saved permanently
6. Each subsequent month's review incorporates prior months — building a cumulative profile that identifies patterns, strengths, weaknesses, and improvement trends

## Architecture

### Data Model

**New table: `trade_reviews` (migration 016)**

```sql
CREATE TABLE trade_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  period_start TEXT NOT NULL,        -- first day of month (YYYY-MM-01)
  period_end TEXT NOT NULL,          -- last day of month
  import_batch_id INTEGER,           -- links to the import that triggered this review

  -- Summary metrics (computed, not AI-generated)
  total_trades INTEGER NOT NULL,
  winning_trades INTEGER NOT NULL,
  losing_trades INTEGER NOT NULL,
  win_rate REAL NOT NULL,            -- winning_trades / total_trades
  total_realized_pnl REAL NOT NULL,
  avg_holding_days REAL,
  best_trade_pnl REAL,
  best_trade_symbol TEXT,
  worst_trade_pnl REAL,
  worst_trade_symbol TEXT,
  avg_win REAL,
  avg_loss REAL,
  profit_factor REAL,                -- gross_wins / gross_losses

  -- AI-generated content
  review_markdown TEXT NOT NULL,      -- full monthly review (Claude output)
  trade_grades TEXT,                  -- JSON: [{ symbol, entry_date, exit_date, grade, reasoning }]
  patterns_identified TEXT,           -- JSON: patterns found this month
  strengths TEXT,                     -- JSON: what went well
  weaknesses TEXT,                    -- JSON: what needs improvement
  cumulative_patterns TEXT,           -- JSON: patterns across all prior months (updated each review)

  -- Meta
  model TEXT,                         -- Claude model used
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  generated_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  UNIQUE(account_id, period_start)    -- one review per account per month
);
```

**New table: `trade_roundtrips` (migration 016)**

Pre-computed round-trip trades that feed the AI analysis:

```sql
CREATE TABLE trade_roundtrips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,

  -- Entry
  entry_date TEXT NOT NULL,
  entry_price REAL NOT NULL,
  entry_quantity REAL NOT NULL,
  entry_cost REAL NOT NULL,

  -- Exit
  exit_date TEXT NOT NULL,
  exit_price REAL NOT NULL,
  exit_quantity REAL NOT NULL,
  exit_proceeds REAL NOT NULL,

  -- Metrics
  holding_days INTEGER NOT NULL,
  realized_pnl REAL NOT NULL,
  return_pct REAL NOT NULL,

  -- AI-generated per-trade
  grade TEXT,                         -- A/B/C/D/F
  entry_thesis TEXT,                  -- inferred reason for entering
  exit_assessment TEXT,               -- was the exit well-timed?
  what_went_well TEXT,
  what_went_wrong TEXT,

  FOREIGN KEY(review_id) REFERENCES trade_reviews(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES accounts(id),
  FOREIGN KEY(security_id) REFERENCES securities(id)
);
```

### Round-Trip Computation

Before AI analysis, compute round-trips from the existing `tax_lot_sales` data:

```typescript
// lib/compute/trade-roundtrips.ts

function computeRoundTrips(db, accountId, periodStart, periodEnd): RoundTrip[] {
  // Query closed tax lot sales in this period for this account
  // Group by security: match BUY lots to SELL transactions
  // A round-trip = acquisition → disposition of the same lot
  // Already computed by the FIFO tax lot engine — just need to
  // query tax_lot_sales WHERE sale_date BETWEEN periodStart AND periodEnd
  // and JOIN with tax_lots for the acquisition side
}
```

This is essentially a view over `tax_lot_sales` + `tax_lots` — the FIFO engine already matches buys to sells. We just need to format it as round-trips.

### AI Analysis Pipeline

```
Import Statement → Detect New Month → Compute Round-Trips → Generate Review
                                                                  ↓
                                                          Load Prior Reviews
                                                                  ↓
                                                          Build Prompt with:
                                                          - This month's trades
                                                          - Market context (if available)
                                                          - Prior month summaries
                                                          - Cumulative patterns
                                                                  ↓
                                                          Claude Opus 4.6
                                                          (adaptive thinking)
                                                                  ↓
                                                          Parse & Store Review
```

### Prompt Design

The prompt is the heart of this feature. It needs to be structured to produce actionable, specific feedback — not generic platitudes.

**System prompt structure:**

```
You are an elite trading coach analyzing a short-term trader's monthly activity.
You have access to their complete trading history for this month and summaries of
prior months. Your job is to provide honest, specific, actionable feedback.

TRADER PROFILE:
- Short-term trader (holding periods: days to weeks)
- Two accounts: IBKR (active trading) and Vanguard (long-term hold)
- This review covers the IBKR trading account only

THIS MONTH'S TRADES:
[Round-trip table: Symbol, Entry Date, Entry Price, Exit Date, Exit Price,
 Holding Days, P&L, Return%]

MARKET CONTEXT (if available):
[S&P 500 performance this month, VIX range, major macro events]

PRIOR MONTH SUMMARIES (if available):
[Condensed 2-3 sentences per prior month + cumulative patterns identified]

ANALYSIS FRAMEWORK:
For each trade, assess:
1. Entry quality: Was the entry well-timed? What was the likely thesis?
2. Exit quality: Was the exit disciplined or emotional? Did you leave money on the table?
3. Sizing: Was position sizing appropriate relative to conviction and risk?
4. Holding period: Was the duration appropriate for the thesis?

Grade each trade A through F:
- A: Excellent execution on both entry and exit
- B: Good trade with minor improvements possible
- C: Acceptable but with clear missed opportunities
- D: Poor execution on entry, exit, or both
- F: Clear mistake — emotional, undisciplined, or thesis-free

For the monthly summary:
1. Win rate and expectancy analysis
2. Best and worst trades with specific lessons
3. Behavioral patterns (positive and negative)
4. Comparison to prior months (improving/declining/stable)
5. Three specific, actionable recommendations for next month

IMPORTANT: Be direct and specific. "You sold AAPL too early" is better than
"consider holding longer." Reference actual trades by symbol and date.
```

**Cumulative pattern recognition prompt (added after 3+ months):**

```
You now have [N] months of trading history. Look for patterns that only emerge
over multiple months:

1. Do they consistently cut winners short? (avg winner holding period vs avg loser)
2. Do they overtrade after losses? (trade frequency spike after losing months)
3. Do earnings plays work? (win rate on earnings-adjacent trades)
4. Sector rotation success: do they time sector moves well?
5. Sizing patterns: do they size up on losers (averaging down) vs winners?
6. Day-of-week patterns: better/worse on certain days?
7. Market regime adaptability: do they adjust strategy in volatile vs calm markets?
8. Recovery patterns: how do they respond to a bad trade? Next trade quality?

Report ONLY patterns you actually observe with evidence. Don't speculate.
```

### API Route

```
POST /api/trade-review/generate
  Body: { accountId, periodStart, periodEnd }
  Response: SSE stream (same pattern as calendar briefing)

GET /api/trade-review?accountId=&year=
  Response: { reviews: TradeReview[] }

GET /api/trade-review/[id]
  Response: { review: TradeReview, roundTrips: RoundTrip[] }
```

### UI

**Location:** New section in the Research tab (or a sub-route `/dashboard/research/trade-review`)

**Monthly Review Card:**
```
┌─────────────────────────────────────────────────────┐
│ February 2026 — IBKR Trading Review                 │
│                                                     │
│ 23 trades · 61% win rate · +$4,230 net P&L          │
│ Avg hold: 4.2 days · Profit factor: 1.8x            │
│                                                     │
│ Best: NVDA +$1,200 (A) · Worst: TSLA -$800 (D)     │
│                                                     │
│ [View Full Review →]                                 │
├─────────────────────────────────────────────────────┤
│ KEY FEEDBACK:                                        │
│ • Strong entry timing on momentum trades (NVDA, AMD) │
│ • Held TSLA through earnings despite no thesis — F   │
│ • Win rate improving: 54% → 58% → 61% over 3 months │
│ • Still cutting winners early: avg winner +2.1% vs   │
│   avg loser -3.4% — need 60%+ win rate to compensate │
└─────────────────────────────────────────────────────┘
```

**Trade Grade Table (inside full review):**
```
Symbol  Entry     Exit      Days  P&L      Return  Grade
NVDA    02/03     02/07     4     +$1,200  +3.2%   A
AMD     02/10     02/14     4     +$800    +2.8%   B
AAPL    02/12     02/13     1     +$150    +0.4%   C
TSLA    02/18     02/22     4     -$800    -2.1%   D
META    02/20     02/21     1     -$200    -0.5%   C
...
```

**Cumulative Patterns Panel (after 3+ months):**
```
┌─────────────────────────────────────────────────────┐
│ TRADING PATTERNS (6 months analyzed)                 │
│                                                     │
│ ✅ Strengths:                                        │
│ • Momentum entries are consistently well-timed       │
│ • Quick to cut losers (avg loss hold: 2.1 days)     │
│ • Win rate trending up: 48% → 54% → 58% → 61%      │
│                                                     │
│ ⚠️ Weaknesses:                                      │
│ • Cuts winners too early (avg win: +2.1% vs possible │
│   +4.8% if held to original target)                  │
│ • Earnings plays: 2-8 record (20% win rate)          │
│ • Overtrades after losses: +40% more trades in weeks │
│   following a -5% drawdown                           │
│                                                     │
│ 📈 Improvement Trend:                                │
│ • Sizing discipline improved significantly in M4-M6  │
│ • No more averaging down on losers (was a M1-M2 issue│
│ • Exit quality still the biggest lever for improvement│
└─────────────────────────────────────────────────────┘
```

### Integration with Existing Features

1. **Import pipeline hook:** After a successful IBKR activity import that contains new closed trades, show a "Generate Trade Review" button in the import results summary.

2. **Chat integration:** Add a `query_trade_reviews` tool to the chat so the user can ask "How did my earnings plays do this year?" or "What patterns have you noticed in my trading?"

3. **Calendar integration:** After generating a review, create a note (type: `trade_thesis`) with the monthly summary, linked to the review period.

4. **Security Detail:** On the Security Detail page, show the AI's assessment of trades in that security (from `trade_roundtrips.grade` + feedback).

### Implementation Order

1. **Migration 016** — `trade_reviews` + `trade_roundtrips` tables
2. **`lib/compute/trade-roundtrips.ts`** — Compute round-trips from tax lot sales
3. **`lib/trade-review/generate.ts`** — Prompt builder + Claude API call + response parser
4. **`app/api/trade-review/route.ts`** — SSE streaming endpoint
5. **Research tab UI** — Review cards, full review view, cumulative patterns
6. **Import hook** — "Generate Review" button after IBKR statement import
7. **Chat tool** — `query_trade_reviews` for conversational access
8. **Cumulative patterns** — After 3+ months, add cross-month analysis to prompt

### Cost Estimate

Each monthly review will use Claude Opus with adaptive thinking:
- Input: ~3,000 tokens (prompt) + ~500 tokens per trade (20 trades = 10,000) + prior month summaries (~2,000) = ~15,000 input tokens
- Output: ~3,000-5,000 tokens (detailed review)
- Approximate cost: $0.30-0.50 per monthly review (with prompt caching for system prompt)
- Cumulative pattern analysis (quarterly): ~$1.00 per run

### Open Questions

1. **Market context source:** Should we use FRED data, Vital Knowledge, or both for market context in the prompt? FRED is authoritative for rates/data, VK is better for narrative context.

2. **Real-time vs batch:** Should the review generate automatically after import, or should the user explicitly trigger it? Recommendation: explicit trigger (button), since the user may want to wait until they've imported everything for the month.

3. **Editing reviews:** Should the user be able to annotate the AI's review with their own notes? E.g., "The AI said this was emotional, but actually I had a stop-loss thesis." This would improve future reviews.

4. **Grade calibration:** The AI's grading may be inconsistent across months. Should we provide a calibration rubric with concrete P&L thresholds, or let the AI grade holistically based on execution quality?

5. **Privacy:** Trade data stays local (SQLite). The prompts are sent to Anthropic's API with no data retention. Same privacy model as the existing chat feature.
