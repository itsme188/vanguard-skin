# Bogey-sheet expected move takes priority — design

**Date:** 2026-08-03
**Status:** Approved by user (Approach A — pure resolver at the consumers — including Worker parity in this build)
**Origin:** Earnings feedback backlog #5 (user review 2026-08-02): TMT Breakout's weekly sheets carry an expected earnings move per name; the pipeline ignored it and AAPL's 7/30 preview shipped a `±1.5% (IV approx)` implied move into a −7% print. Analyst-sheet expected move should outrank the market-derived numbers: **sheet > straddle > iv_approx, always source-labeled.**

## Design

### Storage — migration 073

`ALTER TABLE earnings_bogeys ADD COLUMN expected_move_pct REAL;` — nullable, absolute percent (±N%, stored as N). Lives on the bogey row because it is per-source analyst data with provenance (`source_label`), exactly like whisper numbers. `earnings_intel` stays purely market-derived — no schema change there.

### Inlets — all three bogey paths learn the field

- `lib/earnings/extract-bogeys.ts` (PDF/screenshot upload): extraction schema + prompt gain `expected_move_pct` ("the expected/implied earnings move the sheet states for this name, as an absolute percent — null when the sheet doesn't give one"). Defensive coercion strips `±`, `%`, and tolerates "6" / "6%" / "±6.0%".
- `lib/earnings/extract-newsletter-bogeys.ts`: same field in its extraction JSON + prompt.
- `BogeysEditModal` manual entry + `POST /api/earnings/bogeys`: numeric input, optional.
- All insert/upsert sites write the column; readers (`getBogeysForEvent`-family) return it.

### Resolver — single pure source, Worker-mirrored

`lib/earnings/expected-move.ts` — **zero-import by design** (byte-parity Worker mirror `workers/cron/src/expected-move.ts` below the header, parity-pinned like plausibility/print-push):

```ts
resolveExpectedMove(args: {
  bogeys: Array<{ expectedMovePct: number | null; sourceLabel: string | null; uploadedAt: string | null }>;
  impliedMovePct: number | null;
  impliedMethod: "straddle" | "iv_approx" | null;
}): { pct: number; method: "sheet" | "straddle" | "iv_approx"; sourceLabel: string | null } | null
```

Sheet-first: the newest bogey (by `uploadedAt`, nulls last) carrying a finite positive `expectedMovePct` wins with `method: "sheet"` and its `sourceLabel`; otherwise fall through to the intel value; null when neither exists.

### Consumers — three choke points, renderers gain one label case

- **Mac composer** (`lib/digest/send-earnings-email.ts::loadIntelView`): `EarningsIntelView.impliedMethod` widens to include `"sheet"` + gains `sheetSourceLabel`; the view is built through the resolver (bogeys are already in `PreviewContext`). Scoreboard/prompt render `±6.0% (TMT sheet)` for sheet, unchanged strings for straddle/iv_approx. The recap's inside/outside-priced-in verdict compares against the resolved number — the sheet value is the anchor the user actually trusted at preview time, and bogeys don't drift post-print.
- **Cockpit** (`decorateCockpitIntel` + `EarningsCockpit.tsx`): intel decoration runs through the resolver (bogeys fetched per event alongside intel); UI renders `impl ±6.0% (sheet)` — the existing `~` prefix stays iv_approx-only.
- **Worker fallback** (`workers/cron/src/fallback-earnings.ts::resolveIntelCtx` / `fmtImplied`): snapshot already ships `earningsBogeys` (v5) + `earningsIntel` (v9); apply the mirrored resolver, same labels. Snapshot bogey rows must carry `expected_move_pct` (snapshot script column passthrough — additive, older snapshots degrade to market-derived).

### Non-goals

- No change to how straddle/iv_approx are computed or cached.
- No backfill of historical sheets (the field populates on the next upload).
- No push/notification changes.

## Testing

- Resolver unit tests (sheet wins, newest sheet wins, fallthrough to straddle then iv_approx, null cases, non-finite/zero guarded) + Worker byte-parity pin.
- Extraction coercion tests ("±6.0%" → 6.0); modal/API accepts + persists the field.
- Composer test: preview renders the sheet label; recap verdict uses the resolved pct.
- Worker test: `fmtImplied` renders sheet label from snapshot rows; degrade when column absent.
- Full Mac + Worker suites green.
