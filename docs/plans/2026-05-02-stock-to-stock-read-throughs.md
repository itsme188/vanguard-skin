# Stock-to-stock read-throughs — design doc

> **Drafted:** 2026-05-02 (scoping deliverable, prior to build)
> **Status:** foundation shipped (migration 044 + seed script); composer integration deferred to next session
> **TODO entry:** `docs/plans/TODO.md` § "New features" → "Stock-to-stock read-throughs"
> **Trigger phrase from user:** "When proto labs reports earnings on friday, change the Xometry earnings preview"

## 1. Why

When stock A reports, the print frequently changes the *thesis* on stock B before B reports. The user already does this mentally — the request is to surface it inside the workflow that already exists (the upcoming-earnings preview email).

Concrete cases the user gave:

- **Directed pairs** (1 reporter → 1 target):
  - **PRTO → XMTR** — both run on-demand digital manufacturing platforms. PRTO's beat/miss + guide is a leading read on XMTR's quarter.
  - **HUN → LIN** — both ride the same global industrial-demand pulse (auto, construction, electronics).
- **Cluster** (any member's report updates every other member):
  - **Ad-platform cluster**: {GOOGL, META, APP, RDDT, …}. When any one prints, the others' previews should reflect the read on ad-pricing trends and brand vs. performance mix.

The user's stated trigger model: **beat-vs-consensus delta + price reaction**. Both signals already live in `calendar_events` after enrichment — `actual_value`, `consensus_estimate`, `reaction_snapshot`. No new data sources needed.

## 2. What's in this design

This is **scoping**, not the full build. What ships now:

- **Migration 044** — `read_through_pairs` table.
- **Seed script** — 2 directed pairs + 12 ad-cluster fan-out rows.
- **This design doc** — composer integration spec for the next session.

What ships **next session** (deliberately deferred, see §6):

- **Composer integration** in `lib/digest/send-earnings-email.ts::renderPreviewPrompt`.
- **Calendar fetch expansion** so non-held reporter symbols (PRTO, RDDT, etc.) make it into `calendar_events` via the Finnhub sweep.
- **Reaction-snapshot enrichment fix** — the bug surfaced in the `Bugs/Quality` TODO entry. Read-throughs depend on the reaction signal being present; the composer integration will silently render empty until that's fixed.

## 3. Schema

```sql
CREATE TABLE read_through_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_symbol TEXT NOT NULL,
  target_symbol TEXT NOT NULL,
  hypothesis TEXT,            -- free text — fed verbatim to Sonnet prompt
  group_label TEXT,           -- 'ad-platform-2026' for cluster fan-out, NULL for one-offs
  weight REAL DEFAULT 1.0,    -- 0..1; sort key when multiple reporters fire in window
  created_at TEXT,
  UNIQUE(reporter_symbol, target_symbol),
  CHECK (reporter_symbol != target_symbol)
);
```

**Why directed pairs (and not a `clusters` table)**: a single small table covers both flavors. Clusters of N members fan out to N×(N−1) directed rows; with N=4 that's 12 rows, fully manageable. Re-evaluate if any cluster grows past ~6 members.

**Why no `held_only` flag on the target**: the seed script is hand-curated by the user, who already knows what they care about. Filtering by held/watchlist at composer time is cheaper and adapts as positions change.

## 4. Composer integration spec (next-session build)

In `lib/digest/send-earnings-email.ts::renderPreviewPrompt(event, context)`:

1. **Lookup**: `db.prepare("SELECT reporter_symbol, hypothesis, weight FROM read_through_pairs WHERE target_symbol = ? ORDER BY weight DESC").all(event.symbol)`.
   Apply `issuerSiblings(event.symbol)` to also match dual-class targets.
2. **Filter to recent reporters**: for each pair, find a `calendar_events` row where `symbol = reporter_symbol` AND `event_date BETWEEN date(event.event_date, '-14 days') AND date(event.event_date, '+0 days')` AND `actual_value IS NOT NULL` AND `reaction_snapshot IS NOT NULL`.
3. **Inject** an `## Read-throughs from this earnings season` block into the prompt with one bullet per matched pair:
   ```
   - **<REPORTER>** reported <event_date>. Beat consensus by X% on EPS, Y% on rev. Stock @ T+2h: ±Z%. SPY @ T+2h: ±W%.
     Hypothesis: <hypothesis from read_through_pairs>.
   ```
4. Sonnet writes the implication paragraph in its preview prose. The pair's `hypothesis` field gives Sonnet enough framing to write something specific, not generic.

**Order in the prompt**: after the existing user-notes block (which renders FIRST per the existing conversation framing rule), before the analyst recs / press releases / transcripts blocks. Read-throughs are *context for this preview*, not a thesis statement.

**Edge cases**:
- No matching reporters in window → omit the block entirely (don't render an empty "## Read-throughs" header).
- Multiple reporters from the same cluster → list all, sort by weight desc.
- Reporter has `actual_value` but `reaction_snapshot` IS NULL → skip this reporter (the "## The reaction" data is what makes the read-through informative). Document in the design that this is the dependency on the enrichment-gap fix.

## 5. Calendar fetch expansion

Currently `lib/calendar/finnhub.ts` only fetches earnings for **held** stocks (via `getHeldStockSymbols()`). For read-throughs to work, we also need calendar entries for **reporter symbols that are not held** — e.g., PRTO, RDDT.

**Recommended next-session change**: add a helper

```ts
function getReadThroughReporterSymbols(db): string[] {
  return db.prepare(`SELECT DISTINCT reporter_symbol FROM read_through_pairs`).all().map(r => r.reporter_symbol);
}
```

then merge with `getHeldStockSymbols()` before the Finnhub sweep. Cost: one extra `/calendar/earnings` call per non-held reporter symbol, paced at 550ms (matches existing rate-limit budget).

After the sweep populates the calendar, the existing enrichment runner (`lib/calendar/enrichment-runner.ts`) will fetch actuals and reaction snapshots for those rows automatically — no further changes needed.

## 6. Why composer integration is deferred

During exploration on 2026-05-02 we confirmed that LIN (May 1) and HUN (Apr 30) recap emails went out with `reaction_snapshot = NULL` — the field that the composer integration depends on for rendering "Stock @ T+2h: ±Z%". Without addressing the enrichment gap, the integration would ship and silently render no read-through bullets, masking its own behavior.

The build order for the next session is therefore:

1. **First**: investigate + fix the `reaction_snapshot` enrichment gap (TODO: "Earnings recap data gap" under Bugs / Quality).
2. **Second**: add `getReadThroughReporterSymbols()` to the Finnhub sweep so PRTO / XMTR / RDDT actually appear in the calendar.
3. **Third**: ship the composer integration described in §4.
4. **Fourth (optional, lower value)**: a Today sidebar block "Read-throughs from this week's prints" and an "Implied reads" panel on the Security Detail page for the *reporter* (showing their downstream targets).

## 7. Performance attribution (future)

Once enough read-through-augmented previews have been sent and outcomes observed, the existing levels-attribution pattern (`/dashboard/levels/performance`) can be extended to score read-through pairs by predictive accuracy:

- Did the read-through bullet's directional implication match the target's actual reaction?
- Sample size requirement: the same `<3 samples → null` rule already used elsewhere.
- New page or new section on the existing levels-performance page — open question for the future.

This is **not** in scope until ~30 read-throughs have shipped. Captured here so the schema (especially `weight`) supports the eventual signal.

## 8. Verification

For this session's deliverable:
- `sqlite3 data/vanguard.db ".schema read_through_pairs"` returns the new table.
- `npx tsx scripts/seed-read-through-pairs.ts --dry-run` previews 14 pairs (2 directed + 12 cluster).
- `npx tsx scripts/seed-read-through-pairs.ts` inserts on a fresh DB; re-run is a no-op (idempotent).
- This design doc exists and is referenced from the TODO entry.

For the next-session integration build:
- A dry-run of preview generation for an upcoming target (e.g. APP on 2026-05-06, after GOOGL/META have reported) renders the new block in the Sonnet prompt.
- Manual click-through: read the rendered preview email and confirm the read-through prose feels specific rather than generic.

## 9. Open questions parked

- **PINS / SNAP / TTD** in the ad cluster — user said "etc". Not seeded; revisit after first cycle. If the user adds them, fan-out grows from 12 → 30 → 56 directed pairs (still fine).
- **Rev/EPS-only vs full-segment read-throughs** — for PRTO/XMTR specifically, segment-level read-throughs (e.g., PRTO's 3D-printing volume → XMTR's 3D-printing line) would be more precise but require segment data we don't always have. Defer until segment_breakdown_json on `earnings_bogeys` accumulates.
- **Reverse direction** — should XMTR's print also update PRTO's preview? User listed PRTO → XMTR only. Add the reverse if the user wants symmetry; currently asymmetric per their literal note.
