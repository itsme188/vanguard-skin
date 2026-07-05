# Defense / Hedging Tab (R3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 5th Analysis sub-view (`?view=defense`) that classifies every position into hedged pairs / proxy protection / amplifiers / standalone bets, computes book- and sector-level protection coverage, and scores every hedge for close-first/close-last decisions.

**Architecture:** One new pure compute engine `lib/compute/hedging.ts` (house pattern: `db` + `accountIds?`, `:memory:`-testable) consuming existing single-sources (`computePortfolioGreeks`, `latestHoldingsPredicate`, `explodeHoldingBySector`, `issuerSiblings`, `security_betas`, FX). Thin `GET /api/analysis/defense` route. `DefenseView` async **server** component (PerformanceView pattern) with a `"use client"` tables child for sorting. AI prose reuses `analysis_narratives` with a new `defense` surface.

**Tech Stack:** TypeScript 5, better-sqlite3, Next.js 16 App Router, Vitest, Tailwind 4. **No new dependencies, no migrations.**

**Spec:** `docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md` — read it before starting any task.

## Global Constraints

- Every DB function takes `db: Database.Database` as first param (DI for `:memory:` tests).
- Security-type comparisons ALWAYS case-insensitive (`.toLowerCase()`); a lint hook rejects violations.
- Always `COALESCE(s.multiplier, 1)` in SQL; FX factor `COALESCE(fx.usd_per_unit, 1)` / `getUsdPerUnit` on every dollar.
- Multi-account scope = `accountIds[]` end-to-end; NEVER collapse to `accountIds[0]`.
- Never compare underlyings symbol-string-equal — canonicalize via `issuerSiblings()`.
- UI: portfolio-derived numbers through `<Money>`/`<Pct>` (`@/lib/privacy/components`); chips via `<Chip>`; sortable headers via `<SortableHeader>` + `useSortParam`; empty states via `<EmptySection>` (never silent `return null`).
- Run `npx vitest run` (full suite, ~2985 tests) before the final commit of each task; do not commit on red.
- Commit messages: conventional prefixes (`feat:`, `test:`, `docs:`); include the standard Co-Authored-By footer.

---

### Task 1: Engine types + Tier-1 classification (pure)

**Files:**
- Create: `lib/compute/hedging.ts`
- Create: `tests/compute/hedging.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions over plain objects).
- Produces (later tasks rely on these exact names):
  - `interface DefenseInstrument` (below)
  - `classifyBook(groups: Map<string, UnderlyingGroup>): ClassifyResult`
  - `interface UnderlyingPair`, `interface ProxyCandidate`, `interface StandaloneBet`
  - `HEDGE_BADGE_THRESHOLDS` const (Task 4 uses it; define here so all constants live at the top of the module)

- [ ] **Step 1: Write the failing tests**

Create `tests/compute/hedging.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  classifyBook,
  type DefenseInstrument,
  type UnderlyingGroup,
} from "@/lib/compute/hedging";

function inst(over: Partial<DefenseInstrument>): DefenseInstrument {
  return {
    securityId: 1,
    symbol: "TEST",
    underlying: "TEST",
    isOption: false,
    optionType: null,
    quantity: 100,
    exposure: 10000,
    marketValue: 10000,
    underlyingIsEtf: false,
    sector: "Technology",
    geography: "US",
    greeksAvailable: true,
    ...over,
  };
}

function group(underlying: string, isEtf: boolean, instruments: DefenseInstrument[]): [string, UnderlyingGroup] {
  return [underlying, { underlying, underlyingIsEtf: isEtf, instruments }];
}

describe("classifyBook — Tier 1 pairs", () => {
  it("classifies long stock + puts as hedged_long with capped coverage", () => {
    const r = classifyBook(new Map([group("MSFT", false, [
      inst({ securityId: 1, symbol: "MSFT", exposure: 20000 }),
      inst({ securityId: 2, symbol: "MSFT  270115P00400000", isOption: true, optionType: "PUT", quantity: 2, exposure: -8000, marketValue: 3000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "MSFT")!;
    expect(pair.classification).toBe("hedged_long");
    expect(pair.coreExposure).toBe(20000);
    expect(pair.offsetCredited).toBe(8000);
    expect(pair.coveragePct).toBeCloseTo(0.4);
    expect(pair.netExposure).toBe(12000);
  });

  it("classifies short stock + long call as hedged_short", () => {
    const r = classifyBook(new Map([group("PAYC", false, [
      inst({ securityId: 1, symbol: "PAYC", quantity: -80, exposure: -12000, marketValue: -12000 }),
      inst({ securityId: 2, symbol: "PAYC  260116C00200000", isOption: true, optionType: "CALL", quantity: 1, exposure: 4000, marketValue: 1500 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "PAYC")!;
    expect(pair.classification).toBe("hedged_short");
    expect(pair.offsetCredited).toBe(4000);
    expect(pair.coveragePct).toBeCloseTo(4000 / 12000);
  });

  it("flags same-sign options on a long core as amplifiers, not hedges", () => {
    const r = classifyBook(new Map([group("INTC", false, [
      inst({ securityId: 1, symbol: "INTC", exposure: 5000 }),
      inst({ securityId: 2, symbol: "INTC  260320C00030000", isOption: true, optionType: "CALL", quantity: 20, exposure: 15000, marketValue: 6000 }),
      inst({ securityId: 3, symbol: "INTC  260320P00045000", isOption: true, optionType: "PUT", quantity: 4, exposure: -3000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "INTC")!;
    expect(pair.classification).toBe("hedged_long"); // opposing puts exist
    expect(pair.amplifierExposure).toBe(15000);
    expect(pair.hasAmplifiers).toBe(true);
    expect(pair.netExposure).toBe(17000);
  });

  it("caps offset credit at |core| and spills ETF excess to proxy candidates", () => {
    const r = classifyBook(new Map([group("XLE", true, [
      inst({ securityId: 1, symbol: "XLE", exposure: 10000 }),
      inst({ securityId: 2, symbol: "XLE   260116P00080000", isOption: true, optionType: "PUT", quantity: 10, exposure: -16000, marketValue: 5000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "XLE")!;
    expect(pair.offsetCredited).toBe(10000);        // capped
    expect(pair.coveragePct).toBeCloseTo(1.0);
    const spill = r.proxyCandidates.find((c) => c.underlying === "XLE")!;
    expect(spill.protectiveNotional).toBe(6000);    // the excess
    expect(spill.source).toBe("tier1_spill");
  });

  it("routes a short ETF plus same-sign puts entirely to proxy candidates (MAGS case)", () => {
    const r = classifyBook(new Map([group("MAGS", true, [
      inst({ securityId: 1, symbol: "MAGS", quantity: -300, exposure: -15000, marketValue: -15000 }),
      inst({ securityId: 2, symbol: "MAGS  260116P00050000", isOption: true, optionType: "PUT", quantity: 10, exposure: -9000, marketValue: 4000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "MAGS")).toBeUndefined();
    const c = r.proxyCandidates.find((c) => c.underlying === "MAGS")!;
    expect(c.protectiveNotional).toBe(24000);       // short shares + puts
    expect(c.source).toBe("etf_negative_stack");
  });

  it("routes ETF puts with no core to proxy candidates", () => {
    const r = classifyBook(new Map([group("MTUM", true, [
      inst({ securityId: 2, symbol: "MTUM  260116P00200000", isOption: true, optionType: "PUT", quantity: 3, exposure: -12000, marketValue: 3500 }),
    ])]));
    expect(r.proxyCandidates.find((c) => c.underlying === "MTUM")!.protectiveNotional).toBe(12000);
  });

  it("classifies single-name puts on non-held stock AND naked single-name shorts as standalone bets", () => {
    const r = classifyBook(new Map([
      group("RGTI", false, [
        inst({ securityId: 2, symbol: "RGTI  260116P00010000", isOption: true, optionType: "PUT", quantity: 20, exposure: -5000, marketValue: 2500 }),
      ]),
      group("AMD", false, [
        inst({ securityId: 3, symbol: "AMD", quantity: -20, exposure: -3000, marketValue: -3000 }),
      ]),
    ]));
    expect(r.standaloneBets).toHaveLength(2);
    expect(r.pairs.find((p) => p.underlying === "AMD")).toBeUndefined();
    expect(r.proxyCandidates).toHaveLength(0);
  });

  it("classifies naked long calls as speculative pairs (risk, never protection)", () => {
    const r = classifyBook(new Map([group("FROG", false, [
      inst({ securityId: 2, symbol: "FROG  260116C00040000", isOption: true, optionType: "CALL", quantity: 4, exposure: 7000, marketValue: 2000 }),
    ])]));
    const pair = r.pairs.find((p) => p.underlying === "FROG")!;
    expect(pair.classification).toBe("speculative");
    expect(pair.netExposure).toBe(7000);
  });

  it("classifies plain long stock with no options as unhedged", () => {
    const r = classifyBook(new Map([group("XOM", false, [
      inst({ securityId: 1, symbol: "XOM", exposure: 11000 }),
    ])]));
    expect(r.pairs.find((p) => p.underlying === "XOM")!.classification).toBe("unhedged");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compute/hedging.test.ts`
Expected: FAIL — `Cannot find module '@/lib/compute/hedging'` (or missing exports).

- [ ] **Step 3: Implement types + classifyBook**

Create `lib/compute/hedging.ts`:

```typescript
/**
 * Defense/Hedging engine — classifies the book into hedged pairs (Tier 1),
 * proxy protection (Tier 2), amplifiers, and standalone bets, then scores
 * every hedge. Spec: docs/superpowers/specs/2026-07-05-defense-hedging-tab-design.md
 *
 * All classification runs on SIGNED delta-notional exposure (stocks at MV,
 * options at Δ·S·mult·qty). Sign rules generalize: any negative-exposure
 * instrument on an ETF with no long core is portfolio protection; on a
 * non-held single name it is a directional bet.
 */

// ─── Badge thresholds (Task 4 consumes; single tunable home) ────────
export const HEDGE_BADGE_THRESHOLDS = {
  EXPIRING_DAYS: 30,
  DECAYED_OTM_PCT: 0.2,
  DECAYED_RUNWAY_DAYS: 45,
  EXPENSIVE_MONTHLY_BLEED_PCT: 0.03,
  DEEP_ITM_ABS_DELTA: 0.8,
} as const;

export interface DefenseInstrument {
  securityId: number;
  symbol: string;
  /** issuerSiblings-canonical underlying (self for stock/ETF). */
  underlying: string;
  isOption: boolean;
  optionType: "CALL" | "PUT" | null;
  quantity: number; // signed
  /** Signed delta-notional USD. */
  exposure: number;
  /** Signed USD market value. */
  marketValue: number;
  underlyingIsEtf: boolean;
  sector: string | null;
  geography: string | null;
  greeksAvailable: boolean;
  // Option detail for scoring (Task 4); absent on shares.
  strike?: number;
  expiration?: string;
  daysToExpiry?: number;
  /** Daily theta in dollars for the whole position (negative = decay). */
  thetaPerDay?: number | null;
  delta?: number | null;
  underlyingPrice?: number;
}

export interface UnderlyingGroup {
  underlying: string;
  underlyingIsEtf: boolean;
  instruments: DefenseInstrument[];
}

export type PairClassification =
  | "hedged_long"
  | "hedged_short"
  | "amplified"
  | "unhedged"
  | "speculative";

export interface UnderlyingPair {
  underlying: string;
  classification: PairClassification;
  coreExposure: number;
  /** Σ opposing-option exposure magnitude, uncapped. */
  offsetExposure: number;
  /** min(offsetExposure, |core|) — what actually counts as hedged. */
  offsetCredited: number;
  amplifierExposure: number;
  hasAmplifiers: boolean;
  netExposure: number;
  /** offsetCredited / |core|; null when core === 0. */
  coveragePct: number | null;
  sector: string | null;
  instruments: DefenseInstrument[];
}

export interface ProxyCandidate {
  underlying: string;
  protectiveNotional: number; // positive magnitude
  source: "no_core_etf" | "etf_negative_stack" | "tier1_spill";
  instruments: DefenseInstrument[];
}

export interface StandaloneBet {
  underlying: string;
  exposure: number; // signed (negative)
  kind: "single_name_put" | "naked_short";
  instruments: DefenseInstrument[];
}

export interface ClassifyResult {
  pairs: UnderlyingPair[];
  proxyCandidates: ProxyCandidate[];
  standaloneBets: StandaloneBet[];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function classifyBook(groups: Map<string, UnderlyingGroup>): ClassifyResult {
  const pairs: UnderlyingPair[] = [];
  const proxyCandidates: ProxyCandidate[] = [];
  const standaloneBets: StandaloneBet[] = [];

  for (const g of groups.values()) {
    const core = sum(g.instruments.filter((i) => !i.isOption).map((i) => i.exposure));
    const options = g.instruments.filter((i) => i.isOption);
    const netExposure = sum(g.instruments.map((i) => i.exposure));
    const sector = g.instruments.find((i) => i.sector)?.sector ?? null;

    if (core > 0) {
      const opposing = options.filter((o) => o.exposure < 0);
      const amplifying = options.filter((o) => o.exposure > 0);
      const offsetExposure = Math.abs(sum(opposing.map((o) => o.exposure)));
      const offsetCredited = Math.min(offsetExposure, core);
      const excess = offsetExposure - offsetCredited;
      if (excess > 0 && g.underlyingIsEtf) {
        proxyCandidates.push({
          underlying: g.underlying,
          protectiveNotional: excess,
          source: "tier1_spill",
          instruments: opposing,
        });
      }
      pairs.push({
        underlying: g.underlying,
        classification:
          opposing.length > 0 ? "hedged_long" : amplifying.length > 0 ? "amplified" : "unhedged",
        coreExposure: core,
        offsetExposure,
        offsetCredited,
        amplifierExposure: sum(amplifying.map((o) => o.exposure)),
        hasAmplifiers: amplifying.length > 0,
        netExposure,
        coveragePct: offsetCredited / core,
        sector,
        instruments: g.instruments,
      });
      continue;
    }

    if (core < 0) {
      const opposing = options.filter((o) => o.exposure > 0); // calls hedging the short
      const sameSign = options.filter((o) => o.exposure < 0);
      if (g.underlyingIsEtf) {
        // Negative ETF stack = portfolio protection: core remainder after
        // opposing calls offset, plus all same-sign puts (MAGS case).
        const offsetExposure = sum(opposing.map((o) => o.exposure));
        const coreRemainder = Math.max(0, Math.abs(core) - offsetExposure);
        const notional = coreRemainder + Math.abs(sum(sameSign.map((o) => o.exposure)));
        if (notional > 0) {
          proxyCandidates.push({
            underlying: g.underlying,
            protectiveNotional: notional,
            source: "etf_negative_stack",
            instruments: g.instruments,
          });
        }
        continue;
      }
      if (opposing.length > 0) {
        const offsetExposure = sum(opposing.map((o) => o.exposure));
        const offsetCredited = Math.min(offsetExposure, Math.abs(core));
        pairs.push({
          underlying: g.underlying,
          classification: "hedged_short",
          coreExposure: core,
          offsetExposure,
          offsetCredited,
          amplifierExposure: sum(sameSign.map((o) => o.exposure)),
          hasAmplifiers: sameSign.length > 0,
          netExposure,
          coveragePct: offsetCredited / Math.abs(core),
          sector,
          instruments: g.instruments,
        });
      } else {
        standaloneBets.push({
          underlying: g.underlying,
          exposure: netExposure,
          kind: "naked_short",
          instruments: g.instruments,
        });
      }
      continue;
    }

    // core === 0 — options only.
    const protective = options.filter((o) => o.exposure < 0);
    const bullish = options.filter((o) => o.exposure > 0);
    if (protective.length > 0) {
      if (g.underlyingIsEtf) {
        proxyCandidates.push({
          underlying: g.underlying,
          protectiveNotional: Math.abs(sum(protective.map((o) => o.exposure))),
          source: "no_core_etf",
          instruments: protective,
        });
      } else {
        standaloneBets.push({
          underlying: g.underlying,
          exposure: sum(protective.map((o) => o.exposure)),
          kind: "single_name_put",
          instruments: protective,
        });
      }
    }
    if (bullish.length > 0) {
      pairs.push({
        underlying: g.underlying,
        classification: "speculative",
        coreExposure: 0,
        offsetExposure: 0,
        offsetCredited: 0,
        amplifierExposure: sum(bullish.map((o) => o.exposure)),
        hasAmplifiers: true,
        netExposure: sum(bullish.map((o) => o.exposure)),
        coveragePct: null,
        sector,
        instruments: bullish,
      });
    }
  }

  return { pairs, proxyCandidates, standaloneBets };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/compute/hedging.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/hedging.ts tests/compute/hedging.test.ts
git commit -m "feat(hedging): Tier-1 classification engine — pairs, proxy candidates, standalone bets"
```

---

### Task 2: Gap-guarded beta resolver

**Files:**
- Modify: `lib/compute/hedging.ts` (append)
- Modify: `tests/compute/hedging.test.ts` (append)

**Interfaces:**
- Consumes: `security_betas` table (`security_id`, `beta`, `lookback_days`, `computed_at`), `prices` + `benchmark_prices` tables.
- Produces:
  - `computeGapGuardedBeta(series: Array<{date: string; close: number}>, bench: Array<{date: string; close: number}>): number | null` (pure)
  - `resolveProxyBeta(db, symbol): { beta: number; source: "cached" | "computed" | "assumed" }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/hedging.test.ts`:

```typescript
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeGapGuardedBeta, resolveProxyBeta } from "@/lib/compute/hedging";

function dailySeries(start: string, closes: number[]): Array<{ date: string; close: number }> {
  const out: Array<{ date: string; close: number }> = [];
  const d = new Date(start + "T00:00:00Z");
  for (const close of closes) {
    out.push({ date: d.toISOString().slice(0, 10), close });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("computeGapGuardedBeta", () => {
  it("computes ~2.0 beta for a 2x levered series", () => {
    const bench = dailySeries("2026-06-01", [100, 101, 99.9, 101.5, 100.8, 102, 101.2, 103, 102.1, 104]);
    const sec = dailySeries("2026-06-01", bench.map((b, i) => 100 * Math.pow(b.close / 100, 2)));
    const beta = computeGapGuardedBeta(sec, bench.slice());
    expect(beta).not.toBeNull();
    expect(beta!).toBeGreaterThan(1.6);
    expect(beta!).toBeLessThan(2.4);
  });

  it("drops return pairs spanning a >7 calendar-day gap", () => {
    // Two dense clusters separated by a 9-month hole; the cross-gap pair
    // would inject a giant fake return (the NFLX β=-14.31 failure mode).
    const a = dailySeries("2025-06-01", [100, 101, 100.5, 101.2, 100.9, 101.8]);
    const b = dailySeries("2026-03-27", [50, 50.4, 50.1, 50.8, 50.5, 51]).map((r) => ({ ...r }));
    const bench = [...dailySeries("2025-06-01", [400, 402, 401, 403, 402, 404]), ...dailySeries("2026-03-27", [500, 502, 501, 504, 502, 505])];
    const beta = computeGapGuardedBeta([...a, ...b], bench);
    expect(beta).not.toBeNull();
    expect(Math.abs(beta!)).toBeLessThan(5); // sane despite the -50% "day"
  });

  it("returns null with fewer than 6 usable return pairs", () => {
    expect(computeGapGuardedBeta(dailySeries("2026-06-01", [100, 101, 102]), dailySeries("2026-06-01", [400, 401, 402]))).toBeNull();
  });
});

describe("resolveProxyBeta", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("prefers the cached security_betas row", () => {
    db.prepare(`INSERT INTO securities (symbol, name, security_type, source_key) VALUES ('MTUM','MTUM','ETF','t:MTUM')`).run();
    const sid = (db.prepare(`SELECT id FROM securities WHERE symbol='MTUM'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, 1.42, datetime('now'))`).run(sid);
    expect(resolveProxyBeta(db, "MTUM")).toEqual({ beta: 1.42, source: "cached" });
  });

  it("falls back to assumed 1.0 when nothing is available", () => {
    expect(resolveProxyBeta(db, "ZZZQ")).toEqual({ beta: 1.0, source: "assumed" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/compute/hedging.test.ts`
Expected: FAIL — `computeGapGuardedBeta` not exported.

- [ ] **Step 3: Implement**

Append to `lib/compute/hedging.ts`:

```typescript
import type Database from "better-sqlite3";

const MAX_RETURN_PAIR_GAP_DAYS = 7; // prices-table hole guard (see CLAUDE.md)
const MIN_BETA_RETURN_PAIRS = 6;

function calendarDaysBetween(a: string, b: string): number {
  return Math.abs(new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000;
}

/** Log-return pairs aligned by date, dropping pairs spanning > MAX_RETURN_PAIR_GAP_DAYS. */
function gapGuardedReturns(series: Array<{ date: string; close: number }>): Map<string, number> {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const out = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.close <= 0 || cur.close <= 0) continue;
    if (calendarDaysBetween(prev.date, cur.date) > MAX_RETURN_PAIR_GAP_DAYS) continue;
    out.set(cur.date, Math.log(cur.close / prev.close));
  }
  return out;
}

export function computeGapGuardedBeta(
  series: Array<{ date: string; close: number }>,
  bench: Array<{ date: string; close: number }>
): number | null {
  const secR = gapGuardedReturns(series);
  const benchR = gapGuardedReturns(bench);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [date, r] of secR) {
    const br = benchR.get(date);
    if (br !== undefined) {
      ys.push(r);
      xs.push(br);
    }
  }
  if (xs.length < MIN_BETA_RETURN_PAIRS) return null;
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  if (varx === 0) return null;
  return cov / varx;
}

export interface ResolvedBeta {
  beta: number;
  source: "cached" | "computed" | "assumed";
}

/**
 * β for a proxy-hedge underlying: security_betas cache → gap-guarded compute
 * from cached closes (prices + benchmark_prices vs SPY) → assumed 1.0.
 */
export function resolveProxyBeta(db: Database.Database, symbol: string): ResolvedBeta {
  const cached = db
    .prepare(
      `SELECT sb.beta FROM security_betas sb
       JOIN securities s ON s.id = sb.security_id
       WHERE s.symbol = ? ORDER BY sb.computed_at DESC LIMIT 1`
    )
    .get(symbol) as { beta: number } | undefined;
  if (cached) return { beta: cached.beta, source: "cached" };

  const closesFor = (sym: string): Array<{ date: string; close: number }> =>
    db
      .prepare(
        `SELECT date, close_price AS close FROM prices p JOIN securities s ON s.id = p.security_id WHERE s.symbol = ?
         UNION ALL
         SELECT date, close_price AS close FROM benchmark_prices WHERE symbol = ?
         ORDER BY date`
      )
      .all(sym, sym) as Array<{ date: string; close: number }>;

  const sec = closesFor(symbol);
  const spy = closesFor("SPY");
  const computed = computeGapGuardedBeta(sec, spy);
  if (computed !== null) return { beta: computed, source: "computed" };
  return { beta: 1.0, source: "assumed" };
}
```

Move the existing `import type Database` to the top of the file with the other imports (single import block).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/compute/hedging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/hedging.ts tests/compute/hedging.test.ts
git commit -m "feat(hedging): gap-guarded proxy beta resolver (cached -> computed -> assumed 1.0)"
```

---

### Task 3: Tier-2 proxy attribution (pure)

**Files:**
- Modify: `lib/compute/hedging.ts` (append)
- Modify: `tests/compute/hedging.test.ts` (append)

**Interfaces:**
- Consumes: `ProxyCandidate` (Task 1), `ResolvedBeta` (Task 2), `explodeHoldingBySector`-style weights map.
- Produces:
  - `interface ProxyHedge { underlying, protectiveNotional, route: "sector" | "geography" | "beta", creditedTo: Array<{bucket: string; credited: number}>, betaSource?: "cached" | "computed" | "assumed", instruments }`
  - `interface SectorCoverage { sector: string; longExposure: number; protected: number; coveragePct: number | null }`
  - `attributeProxies(candidates, ctx: AttributionContext): { proxies: ProxyHedge[]; sectorCoverage: SectorCoverage[] }`
  - `interface AttributionContext { sectorWeights: Map<string, Array<{sector: string; weight_pct: number}>>; etfGeography: Map<string, string>; longExposureBySector: Map<string, number>; longExposureByGeography: Map<string, number>; tier1CreditedBySector: Map<string, number>; totalLongExposure: number; resolveBeta: (symbol: string) => ResolvedBeta }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/hedging.test.ts`:

```typescript
import { attributeProxies, type AttributionContext, type ProxyCandidate } from "@/lib/compute/hedging";

function ctx(over: Partial<AttributionContext> = {}): AttributionContext {
  return {
    sectorWeights: new Map(),
    etfGeography: new Map(),
    longExposureBySector: new Map([["Technology", 100000], ["Financials", 40000]]),
    longExposureByGeography: new Map([["Europe", 20000]]),
    tier1CreditedBySector: new Map(),
    totalLongExposure: 200000,
    resolveBeta: () => ({ beta: 1.0, source: "assumed" as const }),
    ...over,
  };
}

function cand(underlying: string, notional: number): ProxyCandidate {
  return { underlying, protectiveNotional: notional, source: "no_core_etf", instruments: [] };
}

describe("attributeProxies — Tier 2 cascade", () => {
  it("routes via cached sector weights and builds sector coverage", () => {
    const r = attributeProxies([cand("IGV", 10000)], ctx({
      sectorWeights: new Map([["IGV", [{ sector: "Technology", weight_pct: 90 }, { sector: "Communication Services", weight_pct: 10 }]]]),
    }));
    expect(r.proxies[0].route).toBe("sector");
    expect(r.proxies[0].creditedTo).toEqual([
      { bucket: "Technology", credited: 9000 },
      { bucket: "Communication Services", credited: 1000 },
    ]);
    const tech = r.sectorCoverage.find((s) => s.sector === "Technology")!;
    expect(tech.longExposure).toBe(100000);
    expect(tech.protected).toBe(9000);
    expect(tech.coveragePct).toBeCloseTo(0.09);
  });

  it("routes country ETFs via geography when no sector weights", () => {
    const r = attributeProxies([cand("EWG", 5000)], ctx({
      etfGeography: new Map([["EWG", "Europe"]]),
    }));
    expect(r.proxies[0].route).toBe("geography");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "Europe", credited: 5000 }]);
  });

  it("falls back to beta-weighted broad-book credit and carries the beta source", () => {
    const r = attributeProxies([cand("MTUM", 10000)], ctx({
      resolveBeta: () => ({ beta: 1.2, source: "cached" as const }),
    }));
    expect(r.proxies[0].route).toBe("beta");
    expect(r.proxies[0].creditedTo).toEqual([{ bucket: "book", credited: 12000 }]);
    expect(r.proxies[0].betaSource).toBe("cached");
  });

  it("includes tier-1 credits in sector coverage", () => {
    const r = attributeProxies([], ctx({
      tier1CreditedBySector: new Map([["Financials", 8000]]),
    }));
    const fin = r.sectorCoverage.find((s) => s.sector === "Financials")!;
    expect(fin.protected).toBe(8000);
    expect(fin.coveragePct).toBeCloseTo(0.2);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/compute/hedging.test.ts` → `attributeProxies` not exported.

- [ ] **Step 3: Implement**

Append to `lib/compute/hedging.ts`:

```typescript
export interface ProxyHedge {
  underlying: string;
  protectiveNotional: number;
  route: "sector" | "geography" | "beta";
  creditedTo: Array<{ bucket: string; credited: number }>;
  betaSource?: ResolvedBeta["source"];
  instruments: DefenseInstrument[];
}

export interface SectorCoverage {
  sector: string;
  longExposure: number;
  protected: number;
  coveragePct: number | null;
}

export interface AttributionContext {
  /** getEtfSectorWeights(db) shape: symbol → [{sector, weight_pct}] */
  sectorWeights: Map<string, Array<{ sector: string; weight_pct: number }>>;
  /** ETF symbol → geography (from securities.geography of the ETF row). */
  etfGeography: Map<string, string>;
  longExposureBySector: Map<string, number>;
  longExposureByGeography: Map<string, number>;
  /** Tier-1 offsetCredited bucketed by the pair's sector (for the bars). */
  tier1CreditedBySector: Map<string, number>;
  totalLongExposure: number;
  resolveBeta: (symbol: string) => ResolvedBeta;
}

export function attributeProxies(
  candidates: ProxyCandidate[],
  ctx: AttributionContext
): { proxies: ProxyHedge[]; sectorCoverage: SectorCoverage[] } {
  const proxies: ProxyHedge[] = [];
  const protectedBySector = new Map<string, number>(ctx.tier1CreditedBySector);

  for (const c of candidates) {
    const weights = ctx.sectorWeights.get(c.underlying);
    if (weights && weights.length > 0) {
      const creditedTo = weights.map((w) => ({
        bucket: w.sector,
        credited: c.protectiveNotional * (w.weight_pct / 100),
      }));
      for (const ct of creditedTo) {
        protectedBySector.set(ct.bucket, (protectedBySector.get(ct.bucket) ?? 0) + ct.credited);
      }
      proxies.push({ underlying: c.underlying, protectiveNotional: c.protectiveNotional, route: "sector", creditedTo, instruments: c.instruments });
      continue;
    }
    const geo = ctx.etfGeography.get(c.underlying);
    if (geo && ctx.longExposureByGeography.has(geo)) {
      proxies.push({
        underlying: c.underlying,
        protectiveNotional: c.protectiveNotional,
        route: "geography",
        creditedTo: [{ bucket: geo, credited: c.protectiveNotional }],
        instruments: c.instruments,
      });
      continue;
    }
    const { beta, source } = ctx.resolveBeta(c.underlying);
    proxies.push({
      underlying: c.underlying,
      protectiveNotional: c.protectiveNotional,
      route: "beta",
      creditedTo: [{ bucket: "book", credited: c.protectiveNotional * beta }],
      betaSource: source,
      instruments: c.instruments,
    });
  }

  const sectorCoverage: SectorCoverage[] = [...ctx.longExposureBySector.entries()]
    .map(([sector, longExposure]) => {
      const prot = protectedBySector.get(sector) ?? 0;
      return {
        sector,
        longExposure,
        protected: prot,
        coveragePct: longExposure > 0 ? prot / longExposure : null,
      };
    })
    .sort((a, b) => b.longExposure - a.longExposure);

  return { proxies, sectorCoverage };
}
```

- [ ] **Step 4: Run to verify PASS** — `npx vitest run tests/compute/hedging.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/compute/hedging.ts tests/compute/hedging.test.ts
git commit -m "feat(hedging): Tier-2 proxy attribution — sector weights -> geography -> beta cascade"
```

---

### Task 4: Per-hedge scoring

**Files:**
- Modify: `lib/compute/hedging.ts` (append)
- Modify: `tests/compute/hedging.test.ts` (append)

**Interfaces:**
- Consumes: `DefenseInstrument`, `HEDGE_BADGE_THRESHOLDS` (Task 1).
- Produces:
  - `type HedgeBadge = "expiring" | "decayed" | "expensive" | "deep_itm"`
  - `interface HedgeScore { securityId, symbol, underlying, protects: string, protectedNotional, monthlyBleedPct: number | null, thetaPerDay: number | null, runwayDays: number | null, moneynessPct: number | null, efficiency: number | null, badges: HedgeBadge[] }`
  - `scoreHedges(instruments: Array<{ instrument: DefenseInstrument; protects: string; protectedNotional: number }>): HedgeScore[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/compute/hedging.test.ts`:

```typescript
import { scoreHedges } from "@/lib/compute/hedging";

function hedgeInput(over: Partial<DefenseInstrument>, protects = "MSFT", protectedNotional = 10000) {
  return {
    instrument: inst({
      isOption: true,
      optionType: "PUT" as const,
      exposure: -protectedNotional,
      strike: 400,
      underlyingPrice: 500,
      daysToExpiry: 180,
      thetaPerDay: -10,
      delta: -0.3,
      greeksAvailable: true,
      ...over,
    }),
    protects,
    protectedNotional,
  };
}

describe("scoreHedges", () => {
  it("computes bleed, runway, moneyness, efficiency", () => {
    const [s] = scoreHedges([hedgeInput({})]);
    expect(s.monthlyBleedPct).toBeCloseTo((10 * 30) / 10000); // 3%/mo
    expect(s.runwayDays).toBe(180);
    expect(s.moneynessPct).toBeCloseTo((400 - 500) / 500); // -20% = 20% OTM put
    expect(s.efficiency).toBeCloseTo(10000 / 300);
  });

  it("badges: expiring under 30d", () => {
    expect(scoreHedges([hedgeInput({ daysToExpiry: 20 })])[0].badges).toContain("expiring");
  });

  it("badges: decayed when >20% OTM and runway <45d", () => {
    const [s] = scoreHedges([hedgeInput({ daysToExpiry: 40, strike: 350, underlyingPrice: 500 })]);
    expect(s.badges).toContain("decayed");
  });

  it("badges: expensive above 3%/mo bleed; deep_itm at |delta| >= 0.8", () => {
    expect(scoreHedges([hedgeInput({ thetaPerDay: -15 })])[0].badges).toContain("expensive");
    expect(scoreHedges([hedgeInput({ delta: -0.85 })])[0].badges).toContain("deep_itm");
  });

  it("excludes fake numbers when Greeks unavailable (share-short proxies score with null carry)", () => {
    const [s] = scoreHedges([hedgeInput({ isOption: false, optionType: null, thetaPerDay: undefined, daysToExpiry: undefined, strike: undefined, delta: undefined, greeksAvailable: false })]);
    expect(s.monthlyBleedPct).toBeNull();
    expect(s.efficiency).toBeNull();
    expect(s.runwayDays).toBeNull();
    expect(s.badges).toEqual([]);
  });

  it("sorts by efficiency ascending with nulls last (close-first candidates on top)", () => {
    const scores = scoreHedges([
      hedgeInput({ thetaPerDay: -30, securityId: 1 }),  // eff ≈ 11.1
      hedgeInput({ thetaPerDay: -5, securityId: 2 }),   // eff ≈ 66.7
      hedgeInput({ isOption: false, optionType: null, thetaPerDay: undefined, greeksAvailable: false, securityId: 3 }),
    ]);
    expect(scores.map((s) => s.securityId)).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `scoreHedges` not exported.

- [ ] **Step 3: Implement**

Append to `lib/compute/hedging.ts`:

```typescript
export type HedgeBadge = "expiring" | "decayed" | "expensive" | "deep_itm";

export interface HedgeScore {
  securityId: number;
  symbol: string;
  underlying: string;
  /** What it protects: a name, "sector: Technology (90%) + …", or "book". */
  protects: string;
  protectedNotional: number;
  thetaPerDay: number | null;
  monthlyBleedPct: number | null;
  runwayDays: number | null;
  /** (strike − spot) / spot; negative = OTM for puts. */
  moneynessPct: number | null;
  /** Dollars protected per dollar of monthly decay; null when no carry data. */
  efficiency: number | null;
  badges: HedgeBadge[];
}

export function scoreHedges(
  inputs: Array<{ instrument: DefenseInstrument; protects: string; protectedNotional: number }>
): HedgeScore[] {
  const T = HEDGE_BADGE_THRESHOLDS;
  const scores = inputs.map(({ instrument: i, protects, protectedNotional }) => {
    const hasGreeks = i.greeksAvailable && i.isOption;
    const thetaPerDay = hasGreeks && typeof i.thetaPerDay === "number" ? i.thetaPerDay : null;
    const monthlyBleed = thetaPerDay !== null && protectedNotional > 0 ? Math.abs(thetaPerDay) * 30 : null;
    const monthlyBleedPct = monthlyBleed !== null ? monthlyBleed / protectedNotional : null;
    const runwayDays = i.isOption && typeof i.daysToExpiry === "number" ? i.daysToExpiry : null;
    const moneynessPct =
      i.isOption && typeof i.strike === "number" && typeof i.underlyingPrice === "number" && i.underlyingPrice > 0
        ? (i.strike - i.underlyingPrice) / i.underlyingPrice
        : null;
    const efficiency = monthlyBleed !== null && monthlyBleed > 0 ? protectedNotional / monthlyBleed : null;

    const badges: HedgeBadge[] = [];
    if (runwayDays !== null && runwayDays < T.EXPIRING_DAYS) badges.push("expiring");
    const otmPct = i.optionType === "PUT" ? (moneynessPct !== null ? -moneynessPct : null) : moneynessPct;
    if (otmPct !== null && runwayDays !== null && otmPct > T.DECAYED_OTM_PCT && runwayDays < T.DECAYED_RUNWAY_DAYS) badges.push("decayed");
    if (monthlyBleedPct !== null && monthlyBleedPct > T.EXPENSIVE_MONTHLY_BLEED_PCT) badges.push("expensive");
    if (typeof i.delta === "number" && Math.abs(i.delta) >= T.DEEP_ITM_ABS_DELTA) badges.push("deep_itm");

    return {
      securityId: i.securityId,
      symbol: i.symbol,
      underlying: i.underlying,
      protects,
      protectedNotional,
      thetaPerDay,
      monthlyBleedPct,
      runwayDays,
      moneynessPct,
      efficiency,
      badges,
    };
  });

  return scores.sort((a, b) => {
    if (a.efficiency === null && b.efficiency === null) return 0;
    if (a.efficiency === null) return 1;
    if (b.efficiency === null) return -1;
    return a.efficiency - b.efficiency;
  });
}
```

- [ ] **Step 4: Run to verify PASS**, then run the FULL hedging file once more: `npx vitest run tests/compute/hedging.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lib/compute/hedging.ts tests/compute/hedging.test.ts
git commit -m "feat(hedging): per-hedge scoring — bleed, runway, efficiency, badge thresholds"
```

---

### Task 5: `computeDefenseAnalysis` orchestrator

**Files:**
- Modify: `lib/compute/hedging.ts` (append)
- Create: `tests/compute/hedging-orchestrator.test.ts`

**Interfaces:**
- Consumes: `computePortfolioGreeks(db, { accountId })` → `PortfolioGreeks` (positions carry `securityId, underlying, optionType, strike, quantity, multiplier, underlyingPrice, daysToExpiry, greeks: { delta, theta } | null`); `latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true, accountFilter })`; `adjustedMarketValueSQL`; `getUsdPerUnit`; `getEtfSectorWeights(db)`; `issuerSiblings(symbol)`; `resolveProxyBeta` (Task 2); `classifyBook` (Task 1); `attributeProxies` (Task 3); `scoreHedges` (Task 4).
- Produces (API + UI rely on this exact shape):

```typescript
export interface RankedExposure {
  underlying: string;
  netExposure: number;
  pctOfBook: number | null;          // |net| / totalLongExposure
  tier1CoveragePct: number | null;
  sectorProxyCoveragePct: number | null; // the sector's coverage, context column
  classification: PairClassification;
  hasAmplifiers: boolean;
  sector: string | null;
  securityId: number | null;         // for SymbolLink; null if underlying row absent
}
export interface DefenseDiagnostic { kind: "assumed_beta" | "no_sector_weights" | "greeks_fallback" | "unknown_underlying"; symbol: string; detail: string; }
export interface DefenseSummary {
  longExposure: number; shortExposure: number; protectiveNotional: number;
  protectionRatio: number | null; netExposure: number; grossExposure: number; hedgeCount: number;
}
export interface DefenseAnalysis {
  summary: DefenseSummary;
  pairs: UnderlyingPair[];
  proxies: ProxyHedge[];
  sectorCoverage: SectorCoverage[];
  standaloneBets: StandaloneBet[];
  rankedExposures: RankedExposure[];
  hedgeScores: HedgeScore[];
  diagnostics: DefenseDiagnostic[];
}
export function computeDefenseAnalysis(db: Database.Database, accountIds?: number[]): DefenseAnalysis
```

**Implementation notes (exact):**

1. **SQL pull** — one query, holdings universe identical to `getPortfolioExposureSummary` but per-(account, security) WITH shorts and maturity/expiry filters:

```sql
WITH latest_holdings AS (
  SELECT h.* FROM holdings h
  WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true, accountFilter })}
),
latest_prices AS (
  SELECT p.security_id, p.close_price
  FROM prices p
  INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
  ON p.security_id = lp.security_id AND p.date = lp.max_date
)
SELECT
  s.id AS security_id, s.symbol, s.security_type, s.option_type, s.underlying_symbol,
  s.sector, s.geography, s.currency, h.quantity,
  CASE
    WHEN lp.close_price IS NOT NULL
      THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
    WHEN h.cost_basis IS NOT NULL AND h.cost_basis != 0
      THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
    ELSE 0
  END AS mv
FROM latest_holdings h
JOIN securities s ON s.id = h.security_id
LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
LEFT JOIN fx_rates fx ON fx.currency = s.currency
WHERE (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
  AND (s.expiration_date IS NULL OR s.expiration_date >= date('now', '-1 day'))
  AND LOWER(s.security_type) IN ('stock', 'etf', 'common stock', 'option', 'mutual fund')
```

`accountFilter` = `` `AND h.account_id IN (${accountIds.map(() => "?").join(",")})` `` when `accountIds?.length`, else `""`. Sum `quantity`/`mv` across accounts per security_id after the query (JS reduce into a Map).

2. **Greeks** — loop `accountIds ?? [undefined]`, call `computePortfolioGreeks(db, accountId ? { accountId } : undefined)`; build `Map<securityId, { exposure, thetaPerDay, delta, daysToExpiry, strike, underlyingPrice, greeksAvailable }>` where `exposure += pos.greeks.delta * pos.underlyingPrice * pos.multiplier * pos.quantity` and `thetaPerDay += pos.greeks.theta * pos.multiplier * pos.quantity` summed across accounts; positions with `greeks === null` get `greeksAvailable: false` and use `optionExposureFallback(option_type, mv)` (import from `@/lib/compute/exposure`). Collect a `greeks_fallback` diagnostic per such position. Forward `computePortfolioGreeks(...).diagnostics` reasons into the detail string.

3. **Underlying canonicalization** — `underlyingOf(row)`: options → `row.underlying_symbol ?? symbol prefix before first space`; shares → `row.symbol`. Canonical key = `issuerSiblings(u).slice().sort()[0]` (import `issuerSiblings` from `@/lib/securities/issuer-family`).

4. **`underlyingIsEtf`** — one query: `SELECT symbol, security_type, geography FROM securities WHERE symbol IN (…distinct underlyings…)`; `isEtf = LOWER(type) IN ('etf','mutual fund')`. Missing row → `false` + `unknown_underlying` diagnostic. The same query fills `etfGeography` (Map of ETF symbol → geography, only when non-empty).

5. **Attribution context** — `longExposureBySector`: for every instrument with `exposure > 0`: non-options through `explodeHoldingBySector(symbol, security_type, exposure, getEtfSectorWeights(db), sector)`; options bucket to the UNDERLYING's sector (from the step-4 query; fallback own `sector`, else "Unknown"). `longExposureByGeography`: same loop keyed on `geography ?? "Unknown"` (no explode — geography has no look-through). `tier1CreditedBySector`: after `classifyBook`, for each pair with `offsetCredited > 0` add to its `sector ?? "Unknown"`. `resolveBeta = (sym) => resolveProxyBeta(db, sym)` — wrap to push an `assumed_beta` diagnostic when `source === "assumed"`, and a `no_sector_weights` diagnostic when a candidate ETF had no weights AND no geography (i.e. landed on the beta route).

6. **Hedge score inputs** — Tier-1 pairs: each opposing option instrument, `protects = underlying`, `protectedNotional = |instrument.exposure|` scaled by the pair's credit ratio (`offsetCredited / offsetExposure`, 1 when offset uncapped). Proxies: each instrument, `protects` = route description (`"sector: Technology 90% / Comm. Svcs 10%"`, `"geography: Europe"`, `"book (β=1.2)"`), `protectedNotional = |instrument.exposure|` (β-scaling only in `creditedTo`, not the instrument row).

7. **Summary** — `longExposure` = Σ positive per-security exposure; `shortExposure` = Σ negative; `protectiveNotional` = Σ pairs' `offsetCredited` + Σ proxies' Σ`creditedTo.credited`; `protectionRatio = longExposure > 0 ? protectiveNotional / longExposure : null`; `netExposure`/`grossExposure` per-security net then Σ / Σ|·| (same convention as `getPortfolioExposureSummary`); `hedgeCount = hedgeScores.length`.

8. **rankedExposures** — from pairs + standalone bets, sorted `|netExposure|` desc; `sectorProxyCoveragePct` = the sector's `coveragePct` from `sectorCoverage`; `securityId` = the security id of the core instrument (or the sole option's underlying security row if present, else null).

- [ ] **Step 1: Write the failing test** — create `tests/compute/hedging-orchestrator.test.ts` with the contract-test seed helpers (copy the `seedAccount`/`seedSecurity`/`seedHolding`/`seedPrice` pattern from `tests/contracts/api-component-contracts.test.ts`, adding `underlying_symbol`/`option_type`/`strike_price`/`expiration_date`/`multiplier` params to `seedSecurity` for options). Seed: account A with 100 sh MSFT @ $500 + 2 MSFT puts (strike 400, expiry +180d, multiplier 100, option price $10) + 3 MTUM puts (no MTUM shares; strike 200, spot via seeded MTUM price $220); account B with −80 sh PAYC. Assert: `summary.protectionRatio` non-null and > 0; MSFT pair `hedged_long`; MTUM in `proxies` (route `beta`, `betaSource: "assumed"` → diagnostic present); PAYC in `standaloneBets` as `naked_short`; scoping to `[accountA]` excludes PAYC from both `standaloneBets` AND `summary.shortExposure`; FX: re-seed MSFT with `currency='KRW'` + `fx_rates` row 0.0007 and assert exposure scales by 0.0007 (compare two runs).

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run tests/compute/hedging-orchestrator.test.ts`

- [ ] **Step 3: Implement `computeDefenseAnalysis`** per the 8 notes above, in `lib/compute/hedging.ts`.

- [ ] **Step 4: Run to verify PASS**, then `npx vitest run tests/compute` (whole compute dir green).

- [ ] **Step 5: Commit**

```bash
git add lib/compute/hedging.ts tests/compute/hedging-orchestrator.test.ts
git commit -m "feat(hedging): computeDefenseAnalysis orchestrator — SQL universe, greeks wiring, summary, diagnostics"
```

---

### Task 6: API route + contract test

**Files:**
- Create: `app/api/analysis/defense/route.ts`
- Modify: `tests/contracts/api-component-contracts.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `computeDefenseAnalysis` (Task 5), `resolveScope` from `@/lib/queries/accounts`.
- Produces: `GET /api/analysis/defense?scope=vanguard|ibkr|roth|all` → `DefenseAnalysis` JSON.

- [ ] **Step 1: Write the failing contract test**

Append to `tests/contracts/api-component-contracts.test.ts`:

```typescript
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

describe("DefenseView contract", () => {
  it("returns the shape the component reads", () => {
    const result = computeDefenseAnalysis(db);
    expect(result).toHaveProperty("summary");
    expect(result.summary).toHaveProperty("protectionRatio");
    expect(result).toHaveProperty("pairs");
    expect(result).toHaveProperty("proxies");
    expect(result).toHaveProperty("sectorCoverage");
    expect(result).toHaveProperty("standaloneBets");
    expect(result).toHaveProperty("rankedExposures");
    expect(result).toHaveProperty("hedgeScores");
    expect(result).toHaveProperty("diagnostics");
  });
});
```

- [ ] **Step 2: Run to verify it fails or passes** — `npx vitest run tests/contracts/api-component-contracts.test.ts`. (If Task 5 shipped correctly this passes immediately — that is fine; it pins the contract.)

- [ ] **Step 3: Implement the route**

Create `app/api/analysis/defense/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const scope = req.nextUrl.searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    return NextResponse.json(computeDefenseAnalysis(db, accountIds));
  } catch (err) {
    console.error("[api/analysis/defense]", err);
    return NextResponse.json({ error: "Failed to compute defense analysis" }, { status: 500 });
  }
}
```

(Check `lib/db.ts` for the actual exported getter name — sibling routes like `app/api/compute/options-greeks/route.ts` show the exact import; mirror it.)

- [ ] **Step 4: Verify route compiles** — `npx tsc --noEmit` (route-only change; no dev-server needed yet). Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/analysis/defense/route.ts tests/contracts/api-component-contracts.test.ts
git commit -m "feat(hedging): GET /api/analysis/defense route + contract test"
```

---

### Task 7: Narrative surface `defense`

**Files:**
- Modify: `lib/compute/analysis-narratives.ts` (3 touches: `NARRATIVE_SURFACES`, `SURFACE_PROMPTS`, `buildContextForSurface`)
- Modify: `app/dashboard/components/analysis/NarrativeBlock.tsx` (widen `surfaceKey` union)
- Modify/Create test: mirror the existing analysis-narratives test file (find it via `ls tests/compute | grep -i narrat`; if none exists, create `tests/compute/analysis-narratives-defense.test.ts`)

**Interfaces:**
- Consumes: `computeDefenseAnalysis` (Task 5).
- Produces: `"defense"` accepted by `GET/POST /api/analysis/narrative` (route validates against `NARRATIVE_SURFACES` — no route change needed).

- [ ] **Step 1: Write the failing test** (mock AI per house rule — never let a test's pass/fail depend on `.env.local`):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: vi.fn().mockResolvedValue({ text: "Your book is 18% protected." }),
}));

import { NARRATIVE_SURFACES, generateNarrative } from "@/lib/compute/analysis-narratives";

describe("defense narrative surface", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("is a registered surface", () => {
    expect(NARRATIVE_SURFACES).toContain("defense");
  });

  it("generates and caches a defense narrative", async () => {
    const r = await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29" });
    expect(r.narrativeMd).toContain("protected");
    const again = await generateNarrative(db, { scope: "all", surfaceKey: "defense", weekOf: "2026-06-29" });
    expect(again.fromCache).toBe(true);
  });
});
```

**Before finalizing the mock:** open `lib/compute/analysis-narratives.ts` and check which AI wrapper it actually imports (`generateTextForFeature` vs `generateObjectForFeature` vs `getModelForFeature`) and mirror the existing narrative tests' mock shape exactly — the mock above is the expected shape, adjust to reality.

- [ ] **Step 2: Run to verify FAIL** (surface not registered).

- [ ] **Step 3: Implement** — in `lib/compute/analysis-narratives.ts`:

```typescript
// 1) NARRATIVE_SURFACES: append "defense"
export const NARRATIVE_SURFACES = [
  "factor-analysis",
  "risk-metrics",
  "position-risk",
  "factor-heatmap",
  "defense",
] as const;

// 2) SURFACE_PROMPTS:
"defense":
  "You are reviewing the portfolio's defensive posture. In 3-4 sentences: state how much of the long book is protected and through what (same-name hedges vs index/sector puts), name the largest UNPROTECTED exposures, and flag any hedge that looks expensive or nearly decayed (use the badges). Plain prose, no headers, no advice to buy anything new.",

// 3) buildContextForSurface — add branch:
if (surface === "defense") {
  const result = computeDefenseAnalysis(db, accountIds);
  if (result.summary.hedgeCount === 0 && result.summary.shortExposure === 0) return emptyMessage;
  return JSON.stringify(
    {
      summary: result.summary,
      sectorCoverage: result.sectorCoverage,
      topExposures: result.rankedExposures.slice(0, 10),
      hedgeScores: result.hedgeScores.slice(0, 15),
      diagnostics: result.diagnostics,
    },
    null,
    2
  );
}
```

Import `computeDefenseAnalysis` at top. In `NarrativeBlock.tsx` widen the union:

```typescript
surfaceKey: "factor-analysis" | "risk-metrics" | "position-risk" | "factor-heatmap" | "defense";
```

- [ ] **Step 4: Run to verify PASS** — the new test file plus any existing narrative tests: `npx vitest run tests/compute --silent | tail -5`

- [ ] **Step 5: Commit**

```bash
git add lib/compute/analysis-narratives.ts app/dashboard/components/analysis/NarrativeBlock.tsx tests/compute/analysis-narratives-defense.test.ts
git commit -m "feat(hedging): defense narrative surface — prompt, context builder, NarrativeBlock union"
```

---

### Task 8: View plumbing — `defense` sub-view registration

**Files:**
- Modify: `lib/analysis/view-param.ts`
- Modify: `app/dashboard/components/AnalysisViewToggle.tsx`
- Modify: `app/dashboard/components/nav-tabs.ts`
- Modify: the existing view-param test file (find via `grep -rl resolveAnalysisView tests/`)

**Interfaces:**
- Produces: `AnalysisSubView` includes `"defense"`; `resolveAnalysisView({ view: "defense" })` → `{ view: "defense", mode: "classification" }`.

- [ ] **Step 1: Write the failing test** — append to the existing view-param test file:

```typescript
it("resolves the defense sub-view", () => {
  expect(resolveAnalysisView({ view: "defense" })).toEqual({ view: "defense", mode: "classification" });
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement** — `lib/analysis/view-param.ts`: add `| "defense"` to `AnalysisSubView`; add `case "defense": return { view: "defense", mode: "classification" };` to the switch. `AnalysisViewToggle.tsx`: append `{ key: "defense", label: "Defense", query: "view=defense" }` to `VIEWS`. `nav-tabs.ts` Analysis subviews: append `{ name: "Defense", href: "/dashboard/analysis?view=defense", matchParam: { key: "view", value: "defense" } }`.

- [ ] **Step 4: Run to verify PASS** — the view-param test file + `npx tsc --noEmit` (the page's switch on `resolved.view` may now be non-exhaustive — if `tsc` flags `app/dashboard/analysis/page.tsx`, add a temporary `case "defense": return null` placeholder THERE ONLY IF NEEDED; Task 9 replaces it).

- [ ] **Step 5: Commit**

```bash
git add lib/analysis/view-param.ts app/dashboard/components/AnalysisViewToggle.tsx app/dashboard/components/nav-tabs.ts tests/
git commit -m "feat(hedging): register defense as 5th Analysis sub-view (view-param, toggle, nav)"
```

---

### Task 9: DefenseView UI + interpretation lines + page mount

**Files:**
- Create: `app/dashboard/components/DefenseView.tsx` (async server component)
- Create: `app/dashboard/components/DefenseTables.tsx` (`"use client"` — sortable tables)
- Modify: `lib/analysis/interpret.ts` (add `interpretProtectionRatio`)
- Modify: `app/dashboard/analysis/page.tsx` (mount branch)
- Modify: the existing interpret test file (find via `grep -rl interpretSharpe tests/`)

**Interfaces:**
- Consumes: `computeDefenseAnalysis` (server-side, direct call — PerformanceView pattern, NO client fetch), `resolveScope`, `<Money>`/`<Pct>` from `@/lib/privacy/components`, `<Chip>`, `<EmptySection>`, `<NarrativeBlock surfaceKey="defense">`, `SortableHeader`/`useSortParam`, `toneClass` + new `interpretProtectionRatio`.
- Produces: `<DefenseView scope={scope} />` mounted from `page.tsx` when `resolved.view === "defense"`.

- [ ] **Step 1: Write the failing interpret test** — append to the interpret test file:

```typescript
describe("interpretProtectionRatio", () => {
  it("null ratio → neutral no-data text", () => {
    const r = interpretProtectionRatio(null);
    expect(r.tone).toBe("neutral");
  });
  it("under 5% reads as essentially unhedged", () => {
    expect(interpretProtectionRatio(0.03).text).toMatch(/unhedged|unprotected/i);
  });
  it("5-35% reads as partial protection, neutral-to-good tone", () => {
    const r = interpretProtectionRatio(0.18);
    expect(r.text).toMatch(/18%/);
  });
  it("over 60% flags heavy hedging cost drag", () => {
    expect(interpretProtectionRatio(0.65).text).toMatch(/drag|cost/i);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then implement in `lib/analysis/interpret.ts`:

```typescript
export function interpretProtectionRatio(ratio: number | null): Interpretation {
  if (ratio === null) return { text: "No long exposure to protect in this scope.", tone: "neutral" };
  const pct = Math.round(ratio * 100);
  if (ratio < 0.05)
    return { text: `Only ${pct}% of the long book carries any hedge delta — effectively unhedged; a broad decline lands at full weight.`, tone: "bad" };
  if (ratio <= 0.35)
    return { text: `${pct}% of the long book is covered by hedge delta — partial protection; the uncovered majority still drives drawdowns.`, tone: "neutral" };
  if (ratio <= 0.6)
    return { text: `${pct}% of the long book is hedged — substantial cushion in a selloff at a meaningful carry cost.`, tone: "good" };
  return { text: `${pct}% hedge coverage — the book is defensively positioned, but the theta cost drag will bite in flat or rising markets.`, tone: "neutral" };
}
```

Run interpret tests → PASS.

- [ ] **Step 3: Build `DefenseTables.tsx`** (`"use client"`): receives `{ rankedExposures, hedgeScores, standaloneBets }` as props (serializable — plain JSON from the server component). Two tables + one list:
  - **Most-exposed table** — `useSortParam("defense", "netExposure", "desc")`; columns: Name (`SymbolLink` when `securityId` non-null, plain text otherwise), Net exposure (`<Money>`), % of book (`<Pct>`), Tier-1 cover (`<Pct>` or "—"), Sector proxy cover (`<Pct>` or "—"), flags (`<Chip tone="warn" size="xs">levered</Chip>` when `hasAmplifiers`; `<Chip tone="info" size="xs">spec</Chip>` when classification `speculative`).
  - **Hedge book table** — `useSortParam("hedgeBook", "efficiency", "asc")`; columns: Instrument, Protects, Protected $ (`<Money>`), Bleed/mo (`<Pct>` or "—"), Runway (days or "—"), Efficiency (1dp or "—"), Badges (`<Chip>`: `expiring`→warn, `decayed`→down, `expensive`→warn, `deep_itm`→info). Sort with `compareValues`, null-last.
  - **Standalone bets** — simple rows: name, kind label ("bearish bet" / "naked short"), exposure `<Money>`.
- [ ] **Step 4: Build `DefenseView.tsx`** (async server component, PerformanceView pattern):

```typescript
import { getDb } from "@/lib/db";  // mirror PerformanceView's exact db import
import { resolveScope } from "@/lib/queries/accounts";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { interpretProtectionRatio, toneClass } from "@/lib/analysis/interpret";
import { Money, Pct } from "@/lib/privacy/components";
import { EmptySection } from "./EmptySection";
import { NarrativeBlock } from "./analysis/NarrativeBlock";
import { DefenseTables } from "./DefenseTables";

interface DefenseViewProps { scope?: string; }

export async function DefenseView({ scope = "all" }: DefenseViewProps) {
  const db = getDb();
  const analysis = computeDefenseAnalysis(db, resolveScope(db, scope));
  const { summary } = analysis;

  if (summary.hedgeCount === 0 && summary.shortExposure === 0 && analysis.standaloneBets.length === 0) {
    return (
      <EmptySection
        title="Defense"
        reason="No options or short positions in this scope — there is nothing to analyze."
        hint="Hedges (long puts, protective calls on shorts) and index-put protection will appear here once opened."
      />
    );
  }
  // Headline strip: 4 metric cards (protection ratio via <Pct>, net/gross via <Money>,
  // hedge count plain) + interpretProtectionRatio line under the ratio card, colored
  // by toneClass. Then sector-coverage bars (pure divs, width % = coveragePct, longExposure
  // label via <Money>), then <DefenseTables …/>, then diagnostics collapsible
  // (OptionsGreeksCard pattern: <details> with count in <summary>), then
  // <NarrativeBlock scope={scope} surfaceKey="defense" />.
}
```

Write the full JSX following the layout comment; match AnalysisView's card classes (`bg-panel border border-edge rounded-lg p-4` idiom — copy the exact classes from a sibling card in `AnalysisView.tsx` for visual consistency).

- [ ] **Step 5: Mount in `app/dashboard/analysis/page.tsx`** — add the branch beside the PerformanceView mount (remove any Task-8 placeholder):

```typescript
if (resolved.view === "defense") {
  return <DefenseView scope={params.scope} />;
}
```

(Match the page's actual branching style — it may be a switch or JSX conditional; mirror the PerformanceView mount exactly, including any wrapping layout/toggle elements around sibling views.)

- [ ] **Step 6: Verify** — `npx tsc --noEmit` clean; `npx vitest run` FULL suite green.

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/components/DefenseView.tsx app/dashboard/components/DefenseTables.tsx lib/analysis/interpret.ts app/dashboard/analysis/page.tsx tests/
git commit -m "feat(hedging): DefenseView — headline strip, sector bars, sortable tables, narrative, empty states"
```

---

### Task 10: Full-suite + live E2E gate + docs

**Files:**
- Modify: `CLAUDE.md` (two one-line additions)
- No code changes expected (fix regressions if found).

- [ ] **Step 1: Full suite** — `npx vitest run`. Expected: all green (~2985 + new). Fix anything red before proceeding.

- [ ] **Step 2: Snapshot the live DB for E2E** (never point the worktree dev server at the live WAL):

```bash
sqlite3 -readonly /Users/Yitzi/code/vanguard-skin/data/vanguard.db "VACUUM INTO '/Users/Yitzi/code/vanguard-skin-defense-worktree/data/vanguard.db'"
```

(`data/` is gitignored; create the dir if absent. If the target file exists from a prior run, delete it first — VACUUM INTO refuses to overwrite.)

- [ ] **Step 3: Boot dev server on a free port** (3000 may be held by the parallel session / Electron):

```bash
PORT=3001 npm run dev
```

- [ ] **Step 4: Browser E2E via agent-browser** (house rule: test as a real user) — verify on `http://localhost:3001/dashboard/analysis?view=defense`:
  1. Desktop (1440px): headline strip renders real numbers; MSFT/INTC appear as hedged pairs; MTUM/EWG/IGV appear in the hedge book with route labels; MAGS shows as proxy protection; AMD/RGTI in standalone bets; sort clicks re-order the tables and update URL params; privacy toggle masks every $ and % in the tables; scope selector → `?scope=roth` renders the EmptySection (Roth holds no options); no console errors.
  2. Mobile (390×844): single column, pills navigate to Defense, tables degrade readably.
  3. Narrative block: renders "Loading narrative…" then either prose or nothing (needs ANTHROPIC_API_KEY in env to actually generate — absence must NOT break the page).

- [ ] **Step 5: Docs** — in `CLAUDE.md`: add `- GET /api/analysis/defense?scope=` line to the API Pattern section (one sentence: defense/hedging analysis — Tier-1 pairs + Tier-2 proxy attribution + hedge scoring, engine at `lib/compute/hedging.ts`); update the Analysis tab line ("4 sub-views" → "5 sub-views … | Defense").

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: register Defense sub-view + /api/analysis/defense in CLAUDE.md"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** Tier-1 (Task 1), Tier-2 cascade (Tasks 2-3), scoring + badges (Task 4), orchestrator/FX/scope/diagnostics (Task 5), API (6), narrative (7), view plumbing (8), UI incl. interpret lines + empty states (9), E2E + docs (10). Spec's "sector bars include Tier-1 credits" → `tier1CreditedBySector` in Task 3/5. Beta/geo credits deliberately NOT in sector bars (spec: no fake per-sector spreading of broad-book protection).
- **Type consistency:** `DefenseInstrument`/`UnderlyingGroup`/`ClassifyResult` (T1) → consumed by T3/T4/T5 under identical names; `ResolvedBeta` (T2) → T3 ctx; `DefenseAnalysis` (T5) → T6 route, T7 context, T9 props.
- **Known judgment calls implementers must NOT re-litigate:** offset cap + ETF-only spill; negative ETF stacks are protection (never amplifiers); single-name non-held puts and naked shorts are standalone bets; β-scaling lives in `creditedTo`, not instrument rows.
