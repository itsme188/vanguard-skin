# B8 — Cloud Recap Parity (Worker earnings-recap fallback)

**Date:** 2026-07-07
**Status:** Approved (user, this session)
**Closes:** audit item B8 in `docs/plans/2026-07-04-earnings-season-audit.md` — the last open P1 code item from the earnings-season audit.

## Problem

The Worker earnings-recap fallback (`workers/cron/src/fallback-earnings.ts`) is broken in both directions:

1. **Dead exactly when traveling.** Recap candidacy requires `enriched_at` on the calendar event row *in the 2am R2 snapshot*. A same-day AMC print is enriched hours after the snapshot was written, so when the Mac is asleep (the fallback's stated purpose) no recap candidate ever exists. Meanwhile the Worker's own Phase 9b cloud-enrich **already captures** the same-day actual + consensus + Yahoo reaction into `cloud-enriched-{eventId}` KV payloads — the recap scan just never reads them.
2. **Unsafe when it fires** (for pre-2am-enriched events): the scoreboard's Actual column renders `actual_value ?? consensus_value` (consensus dressed as actuals — the failure `921d552` eliminated on the Mac), the Consensus column reads only `consensus_estimate` (Mac reads `consensus_value ?? consensus_estimate`), there is no `isPlausibleEarnings` guard, and there is no actual-required gate — a dashes-only recap still sends and writes a `cloud-sent-earnings-recap-{id}` marker (30h TTL) that suppresses the Mac's rich recap.

Two prerequisite defects surfaced during design:

- **Cloud-enrich is single-shot per event** (`if (existing) continue`, `calendar-enrich.ts:281`). A tick that beats Finnhub's actual posting writes a null-actual payload and never retries — the exact sibling of the Mac bug migration 062 fixed (retry-until-complete). Without a Worker-side mirror, "read the KV payload" only works when Finnhub was fast.
- **The Worker enrich gate makes AMC reactions impossible.** `shouldRunCalendarEnrich` stops at 17:59 ET. Reaction capture needs a bar within 10 min of T+120 (`BAR_TOLERANCE_MS` in `reaction-matcher.ts`), i.e. a tick at ≥ release+110min. For a 16:15 AMC release that is 18:05 — past the gate. Every cloud AMC reaction to date was structurally unreachable.

## Decisions (locked with user)

- **Scope:** both halves — safety gates AND liveness plumbing (KV-payload join + cloud-enrich retry). B13 (per-run send cap / subrequest budget) explicitly **out of scope**; remains open in the audit.
- **Liveness mechanism:** Approach 1 — the recap candidate scan reads `cloud-enriched-{eventId}` payloads. Rejected: enrich-triggered sends (creates a second send path outside the sweep/fallback convention); fresher snapshots (Mac writes them; Mac is asleep).
- **Implausible-actual rule (stricter than Mac):** blank the implausible cells + ⚠ line (Mac scoreboard parity), but send only if the email still carries **at least one real data point** — a plausible actual or a reaction. Implausible actual + no reaction → skip **without** writing the cloud-sent marker, leaving the Mac recap (with its `POST /api/earnings/actuals` manual-override path) free to fire on wake. Rationale: the cloud recap has no AI prose, so a fully-blanked email is content-free; "better no email than a wrong one" (`921d552` principle).

## Design

### 1. Data flow (Mac asleep, AMC print at 16:15 ET)

1. Cloud-enrich ticks every 15 min (gate now 09:30–18:59 ET). Finnhub actual fetched as soon as it posts; Yahoo reaction attempted only ≥ T+115. Retries each tick until the payload is **complete**.
2. Completeness (one definition, Mac `enrichment-runner.ts` mirror): `actual != null && !deferred && (reaction != null || now − releaseInstant ≥ 150min)`.
3. Earnings-fallback ticks (existing 05:00–20:00 gate). Recap candidacy = existing snapshot-`enriched_at` road **OR** complete KV payload road. Recap window `[completionTime, +4h]` where completionTime = snapshot `enriched_at` or the complete payload's `fetchedAt` (retry overwrites refresh `fetchedAt`, so the final write timestamps completion).
4. Compose merges payload fields over snapshot columns; gates apply; send; write `cloud-sent` marker.
5. Mac wake: existing `reconcile-cloud-enrich` drains the payload into `calendar_events` (ADD-only, unchanged); the sweep sees the cloud-sent marker → `sent-by-cloud` audit row. No Mac-side plumbing changes.

### 2. `workers/cron/src/calendar-enrich.ts`

- `shouldRunCalendarEnrich` upper bound `17:59` → `18:59` ET. Comment must carry the math: reaction capture needs a tick at ≥ release+110min (T+120 bar target, 10-min tolerance); the AMC cohort releases 16:00–16:30, so the latest floor is 18:20 (16:30 release) and an 18:59 bound gives every AMC name at least two tick opportunities (e.g. 16:30 → 18:30 + 18:45).
- Per-event candidate window: earnings rows 12h (mirrors Mac `MAX_AGE_MS_EARNINGS`), macro rows stay 2h. Earnings predicate mirrors the Mac: `event_type === "earnings" || source_key.startsWith("finnhub:")`.
- New exported `isPayloadComplete(payload, releaseInstant, nowMs): boolean` — the single completeness definition, imported by `fallback-earnings.ts`.
- Retry-until-complete, **earnings rows only**: parse the existing payload; skip only when complete. Macro rows keep skip-if-existing (single-shot) exactly — their immediate partial capture is by design.
- Re-fetch only what's missing: existing payload has an actual → skip the Finnhub call and attempt reaction only (subrequest saving). Reaction attempts gated to ≥ T+115 for earnings rows (`REACTION_READY_MS` mirror); macro rows are never gated.
- Overwrite COALESCEs: `actual: fresh ?? existing.actual`, `consensus: fresh ?? existing.consensus`, `reaction: fresh ?? existing.reaction` — a captured actual can never be erased by a later Finnhub blip. `fetchedAt` refreshes on every overwrite.
- `MAX_CANDIDATES_PER_TICK = 10` unchanged. Print-push hook unchanged (fires on first actual capture; deduped on `print-push-{eventId}`; retry ticks cannot re-push).

### 3. `workers/cron/src/fallback-earnings.ts` — recap candidacy + gates

- The candidate scan becomes async where needed (KV reads). KV probes are bounded: only held/watchlist earnings events with no snapshot `enriched_at`, no recap audit/marker, whose `releaseInstant` falls within the last **16h** (12h enrich window + 4h recap window). Typically 0–5 KV reads per tick.
- A KV-road candidate carries its payload to the composer.
- **Gates, in order, both roads:**
  1. **Actual-required:** effective actual = snapshot `actual_value` ?? payload `actual`. Null → not a candidate. Never sends, never writes a marker.
  2. **No consensus-as-actual:** `consensus_value` is removed from the Actual column's fallback chain entirely.
  3. **Consensus precedence:** `consensus_value ?? payload.consensus ?? consensus_estimate` (Mac `renderHeadlineTable` parity).
  4. **Plausibility:** parse consensus + actual (Finnhub-shape) → `isPlausibleEarnings` mirror. Implausible → blank the actual cells + italic `⚠ Reported actuals were flagged as implausible vs consensus` line (Mac parity), then the real-data-point rule: send only if plausible-actual OR reaction present; else skip, markerless, with a `details` reason.
- Reaction renders from `reaction_snapshot ?? payload.reaction`. Preview path untouched.

### 4. Plausibility mirror (parity convention)

- Move `isPlausibleEarnings` from `lib/digest/send-earnings-email.ts` to a new **zero-import** pure file `lib/earnings/plausibility.ts`. `send-earnings-email.ts` re-exports it so existing import sites (`read-through-pairs`, `EarningsHub`, tests) are untouched.
- Worker mirror `workers/cron/src/plausibility.ts`, byte-parity below the header comment, pinned by a parity test in `workers/cron/test/` — same convention as `print-push-message` / `presence-position` / `editions`. The B19 sign-flip rule can never drift between sides.

### 5. Error handling

- KV read/parse failures degrade to "not ready": skip that candidate, no marker, `console.warn` — never fail the run or block other candidates.
- Every skip lands in `EarningsFallbackResult.details` with a machine-readable reason (`no-actual`, `payload-incomplete`, `implausible-no-data-point`, `kv-error`, …) so a quiet season day is distinguishable from a broken path.
- Send failures keep the existing `failed`/`lastError` bubbling (Worker sibling-fallback convention).

### 6. Testing

- **Worker (vitest):**
  - calendar-enrich: earnings retry-until-complete (incomplete payload → re-attempt; complete → skip); macro single-shot preserved; T+115 reaction gate (no Yahoo call before); 12h vs 2h windows; COALESCE-on-overwrite (actual survives a null re-fetch); gate boundary (18:59 runs, 19:00 doesn't).
  - fallback-earnings: complete payload → recap candidate with `fetchedAt` window anchor; incomplete → not a candidate; no actual anywhere → never a candidate, no marker; consensus-as-actual eliminated (scoreboard Actual never renders `consensus_value`); consensus precedence chain; implausible + reaction → sends with blanked cells + ⚠; implausible + no reaction → markerless skip; KV error → markerless skip, run continues.
  - plausibility parity test (file-bytes pin + behavior pins incl. B19 sign-flip).
- **Mac:** extraction is behavior-neutral; full suite (`npx vitest run`) must stay green.
- **Post-deploy:** `wrangler deploy`; verify `CLOUD_ENRICH_ENABLED` resolves `"true"` via a dry-run `/internal/trigger`; live-watch the first Mac-asleep AMC print of the season.

## Known limitations (accepted)

- The cloud path only sees events present in the 2am snapshot — a same-day manually-added event is invisible to both cloud-enrich and the recap scan until the next snapshot.
- B13 (clustered-AMC subrequest blowout) remains open; the retry logic's fetch-only-what's-missing behavior reduces but does not bound per-tick cost.
- Cloud recaps stay lean (no AI prose) by design.
