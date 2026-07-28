# Sector-Tag Verification & Bloomberg-Taxonomy Repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Bloomberg-taxonomy sector corruption at the writers, repair every stock's `securities.sector` via a web_search-verified Claude sweep with an option cascade, and surface future drift on Data Health.

**Architecture:** Migration 071 adds `sector_source`/`sector_verified_at` provenance columns. `normalizeSector` demotes four structurally non-GICS Bloomberg buckets to null (COALESCE write sites make null a safe no-op). A new `lib/securities/verify-sector-tags.ts` library (DI, testable) + thin CLI script performs the verified sweep and stamps rows. Data Health gains an unverified-disagreement panel.

**Tech Stack:** TypeScript, better-sqlite3 (in-memory for tests), Vitest, Anthropic SDK raw client + `web_search_20250305`.

**Spec:** `docs/superpowers/specs/2026-07-28-sector-tag-verification-design.md`

## Global Constraints

- Model ids ALWAYS via `resolveFeatureModel(key)` — never a hardcoded model string.
- LLM JSON arrays parse via `lib/ai/extract-json.ts::extractJsonArray`; sector values gate through `GICS_SECTORS.includes` — invalid/`"Unknown"` verdicts are reported, never written.
- Security-type comparisons case-insensitive (`LOWER(security_type)`); a lint hook rejects case-sensitive compares.
- Tests: in-memory SQLite via `runMigrations`, AI mocked (`vi.mock("@/lib/ai/generate")` / injected fetchers) — never a live API call, never the prod DB.
- Scripts: `async function main()` wrapper (tsx rejects top-level await), dry-run by default, idempotent.
- Timestamps compared with `datetime()` on both sides when mixed formats possible.
- Run `npx vitest run` before each commit; commit messages via `git commit -F <tempfile>`.

---

### Task 1: Migration 071 + provenance stamps at the three sector write sites

**Files:**
- Create: `lib/db/migrations/071_sector_verification.sql`
- Modify: `lib/tws/contracts.ts` (~139-150, the `updateSecurity` statement + its `.run()`)
- Modify: `lib/compute/classify-factors.ts` (~247-252, the sector/industry UPDATE)
- Modify: `lib/import/engine.ts` (~618-625, the `updateSectorIndustry` call — find its prepared statement definition earlier in the file and edit both)
- Test: `tests/db/sector-verification-migration.test.ts` (create), `tests/compute/classify-factors.test.ts` (extend)

**Interfaces:**
- Produces: `securities.sector_source TEXT NULL`, `securities.sector_verified_at TEXT NULL` — later tasks read/write these. Stamp values: `'tws_bloomberg'`, `'ai_classify'`, `'csv_import'` (Task 3 adds `'gics_verified'`).
- Stamps must ONLY land when a non-null sector lands (CASE-guarded), and these sites NEVER touch `sector_verified_at`.

- [ ] **Step 1: Write the failing migration test**

```ts
// tests/db/sector-verification-migration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 071 sector verification columns", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("adds nullable sector_source and sector_verified_at to securities", () => {
    const cols = db
      .prepare("SELECT name, [notnull] FROM pragma_table_info('securities')")
      .all() as { name: string; notnull: number }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("sector_source")?.notnull).toBe(0);
    expect(byName.get("sector_verified_at")?.notnull).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`npx vitest run tests/db/sector-verification-migration.test.ts` → columns undefined)

- [ ] **Step 3: Create the migration**

```sql
-- 071: sector verification stamps (2026-07-28).
-- Provenance for securities.sector ('tws_bloomberg' | 'ai_classify' |
-- 'csv_import' | 'gics_verified') + the web-search-verified sweep timestamp.
-- Data Health flags sector<->fund_category disagreements ONLY where
-- sector_verified_at IS NULL, so verified-legit divergences (GOOG/META)
-- stay suppressed. Spec: docs/superpowers/specs/2026-07-28-sector-tag-verification-design.md
ALTER TABLE securities ADD COLUMN sector_source TEXT;
ALTER TABLE securities ADD COLUMN sector_verified_at TEXT;
```

- [ ] **Step 4: Run migration test — expect PASS**

- [ ] **Step 5: Extend the classify-factors test to pin the `ai_classify` stamp.** In `tests/compute/classify-factors.test.ts`, find the existing test that drives `classifyFactors` through the mocked `generateTextForFeature` and asserts sector writes; add assertions on the same securities row:

```ts
const row = db
  .prepare("SELECT sector_source, sector_verified_at FROM securities WHERE symbol = ?")
  .get(/* symbol used by the existing sector-write assertion */) as {
  sector_source: string | null;
  sector_verified_at: string | null;
};
expect(row.sector_source).toBe("ai_classify");
expect(row.sector_verified_at).toBeNull(); // the sweep alone owns this column
```

Run — expect FAIL (`sector_source` null).

- [ ] **Step 6: Add the stamps.** Pattern for all three sites — the stamp is CASE-guarded on the SAME bound sector value so a null write leaves provenance untouched:

`lib/tws/contracts.ts` (`updateSecurity`):

```sql
UPDATE securities
SET sector = COALESCE(?, sector),
    sector_source = CASE WHEN ? IS NOT NULL THEN 'tws_bloomberg' ELSE sector_source END,
    industry = COALESCE(NULLIF(industry,''), ?),
    ...
```

and the call becomes `updateSecurity.run(sector, sector, industry, exchange, conId, longName, longName, sec.id)`.

`lib/compute/classify-factors.ts` — hoist the normalized value, bind twice:

```ts
const gics = normalizeSector(result.sector ?? null);
db.prepare(
  "UPDATE securities SET sector = COALESCE(?, sector), sector_source = CASE WHEN ? IS NOT NULL THEN 'ai_classify' ELSE sector_source END, industry = COALESCE(NULLIF(industry,''), ?) WHERE id = ?"
).run(gics, gics, result.industry ?? result.sector ?? null, secId);
```

`lib/import/engine.ts` (`updateSectorIndustry` statement, stamp `'csv_import'`) — same shape; hoist `normalizeSector(f.sector ?? null)` to a const bound twice.

- [ ] **Step 7: Run the touched test files, then the full suite** (`npx vitest run`) — expect PASS. Also check `tests/securities/sector-write-normalization.test.ts` — if it asserts exact SQL or write behavior of these sites, update its expectations to include the stamp.

- [ ] **Step 8: Commit** (`feat(securities): migration 071 sector provenance stamps at all three write sites`)

---

### Task 2: `normalizeSector` demotions + AI classifier prompt fixes

**Files:**
- Modify: `lib/securities/normalize-sector.ts`
- Modify: `lib/compute/classify-factors.ts` (few-shot VRT ~line 39; prompt text near "Also provide sector (GICS level 1)" ~line 60)
- Modify: `lib/compute/classify-securities.ts` (the `classifyUnresolvedWithClaude` prompt template — add the same guidance sentence)
- Test: `tests/securities/normalize-sector.test.ts` (extend/update)

**Interfaces:**
- Consumes: nothing new.
- Produces: `normalizeSector` returns `null` for the seven demoted alias keys; every other input's behavior is UNCHANGED. Both AI classify prompts carry the GICS-not-Bloomberg guidance sentence.

- [ ] **Step 1: Write the failing pins**

```ts
// append to tests/securities/normalize-sector.test.ts
describe("demoted Bloomberg buckets (structurally non-GICS — never re-alias)", () => {
  it.each([
    "Communications",
    "Consumer, Non-cyclical",
    "Consumer Non-cyclical",
    "Consumer non cyclical",
    "Consumer, Cyclical",
    "Consumer Cyclical",
    "Financial",
  ])("returns null for %s", (raw) => {
    expect(normalizeSector(raw)).toBeNull();
  });

  it("keeps the safe aliases", () => {
    expect(normalizeSector("Basic Materials")).toBe("Materials");
    expect(normalizeSector("Health Care")).toBe("Healthcare");
    expect(normalizeSector("Industrial")).toBe("Industrials");
    expect(normalizeSector("Information Technology")).toBe("Technology");
    expect(normalizeSector("Financials")).toBe("Financials");
    expect(normalizeSector("Communication Services")).toBe("Communication Services");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (demoted keys still map). Existing tests asserting the old mappings (e.g. `Communications → Communication Services`) will need their expectations FLIPPED to null — update them in this step, they are now wrong by design.

- [ ] **Step 3: Demote the aliases.** Remove these keys from `ALIASES`: `"communications"`, `"consumer, cyclical"`, `"consumer cyclical"`, `"consumer, non-cyclical"`, `"consumer non-cyclical"`, `"consumer non cyclical"`, `"financial"`. Add above `ALIASES`:

```ts
/**
 * DEMOTED Bloomberg buckets — deliberately ABSENT from ALIASES (2026-07-28).
 * Bloomberg's taxonomy predates GICS's 2016 Real Estate split and 2018
 * Communication Services reshuffle, so these buckets each span several GICS
 * sectors and CANNOT be 1:1-mapped. Live-verified damage before demotion:
 *   "Communications"           → AMZN (Cons Disc), HOOD (Financials),
 *                                UBER (Industrials), SHOP/APP (Technology);
 *                                only GOOG/META genuinely Comm Services.
 *   "Consumer, Non-cyclical"   → UNH/OSCR/VRTX/ESTA/DHR (all Healthcare);
 *                                only names like KO genuinely Staples.
 *   "Consumer, Cyclical"       → IMAX (Comm Services); NKE/HD fine.
 *   "Financial"                → LAND/KRC (REITs → Real Estate); GS/BAC fine.
 * They return null so the COALESCE write sites leave sector blank for the
 * context-aware Claude classify tail. Do NOT "restore" them as a cleanup.
 * ("Industrial" singular is KEPT: every live row checked out; Bloomberg's
 * Industrial bucket only marginally leaks toward GICS Materials.)
 */
```

- [ ] **Step 4: Run normalize-sector tests — expect PASS.**

- [ ] **Step 5: Fix the AI writers.** In `classify-factors.ts`: change the VRT few-shot example's `sector: "Technology"` to `sector: "Industrials"` (GICS: Vertiv is Industrials — the industry string "Data Centers" stays, which is exactly the lesson). Add to BOTH prompts (`classify-factors.ts` near the "Also provide sector (GICS level 1)" instruction, and the `classifyUnresolvedWithClaude` prompt in `classify-securities.ts`):

```
Sector must be GICS-11, not Bloomberg: internet retail → Consumer Discretionary; interactive media/search/social → Communication Services; REITs → Real Estate; managed care/biotech/pharma → Healthcare; payment networks → Financials.
```

- [ ] **Step 6: Full suite** (`npx vitest run`) — fix any test asserting the old VRT example or old alias behavior. Expect PASS.

- [ ] **Step 7: Commit** (`fix(securities): demote 4 non-GICS Bloomberg buckets; GICS guidance in classify prompts`)

---

### Task 3: Verification sweep library + feature key + CLI

**Files:**
- Create: `lib/securities/verify-sector-tags.ts`
- Create: `scripts/verify-sector-tags.ts`
- Modify: `lib/ai/feature-keys.ts` (add `"sectorVerification"` to the union, near `securityClassification`)
- Modify: `lib/ai/models.ts` (add `sectorVerification: "anthropic/$frontier",` to `FEATURE_MODELS`)
- Test: `tests/securities/verify-sector-tags.test.ts`

**Interfaces:**
- Consumes: migration 071 columns (Task 1); `GICS_SECTORS`/`normalizeSector` (existing); `extractJsonArray` (existing); `issuerSiblings` from `@/lib/securities/issuer-family`; `isGarbageSymbol` from `@/lib/import/validate`; `getRawAnthropicClient` + `resolveFeatureModel` (existing).
- Produces (Task 5 runs these; tests consume them):

```ts
export interface SweepCandidate {
  id: number; symbol: string; name: string | null; industry: string | null;
  fund_category: string | null; sector: string | null;
}
export interface SectorVerdict { symbol: string; sector: string; rationale: string; }
export interface SweepRowResult {
  symbol: string; oldSector: string | null; newSector: string | null;
  changed: boolean; written: boolean; rationale: string;
}
export interface SweepResult {
  rows: SweepRowResult[]; unresolved: { symbol: string; reason: string }[];
  optionRowsUpdated: number; applied: boolean;
}
export function getSweepCandidates(db, opts?: { all?: boolean; symbols?: string[] }): SweepCandidate[];
export function parseVerdicts(text: string): SectorVerdict[];
export function applyVerdicts(db, candidates: SweepCandidate[], verdicts: SectorVerdict[], opts: { apply: boolean }): { rows: SweepRowResult[]; unresolved: { symbol: string; reason: string }[] };
export function cascadeOptionSectors(db, opts: { apply: boolean }): number;
export async function runSectorVerification(db, opts: { apply: boolean; all?: boolean; symbols?: string[]; fetchVerdicts?: (batch: SweepCandidate[]) => Promise<string> }): Promise<SweepResult>;
```

- [ ] **Step 1: Write the failing tests** — in-memory DB via `runMigrations`, seed a minimal `securities` table set, injected `fetchVerdicts`:

```ts
// tests/securities/verify-sector-tags.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getSweepCandidates, parseVerdicts, applyVerdicts,
  cascadeOptionSectors, runSectorVerification,
} from "@/lib/securities/verify-sector-tags";

function seed(db: Database.Database) {
  const ins = db.prepare(
    `INSERT INTO securities (symbol, name, security_type, sector, fund_category, industry, underlying_symbol, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run("AMZN", "Amazon", "Stock", "Communication Services", "US Sector Equity (Consumer Discretionary)", "Internet", null, "t:amzn");
  ins.run("GOOG", "Alphabet", "Stock", "Communication Services", "US Sector Equity (Technology)", "Internet", null, "t:goog");
  ins.run("KO", "Coca-Cola", "Stock", "Consumer Staples", "US Sector Equity (Consumer Staples)", "Beverages", null, "t:ko");
  ins.run("SMH", "VanEck Semi ETF", "ETF", "Technology", null, "ETF / Semiconductors", null, "t:smh");
  ins.run("GOOGL 260117C00200000", "GOOGL call", "Option", "Communication Services", null, null, "GOOGL", "t:opt1");
  ins.run("KO 260117C00070000", "KO call", "Option", "Consumer Staples", null, null, "KO", "t:opt2");
}

describe("verify-sector-tags sweep", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db); seed(db); });

  it("candidates = stocks only, garbage excluded, verified skipped by default", () => {
    db.prepare("INSERT INTO securities (symbol, security_type, source_key) VALUES ('2026-01-01 10:00:00', 'Stock', 't:garbage')").run();
    db.prepare("UPDATE securities SET sector_verified_at = datetime('now') WHERE symbol = 'KO'").run();
    const syms = getSweepCandidates(db).map((c) => c.symbol);
    expect(syms).toContain("AMZN");
    expect(syms).toContain("GOOG");
    expect(syms).not.toContain("KO");        // already verified
    expect(syms).not.toContain("SMH");       // ETF out of scope
    expect(syms).not.toContain("2026-01-01 10:00:00"); // garbage
    expect(getSweepCandidates(db, { all: true }).map((c) => c.symbol)).toContain("KO");
    expect(getSweepCandidates(db, { symbols: ["amzn"] }).map((c) => c.symbol)).toEqual(["AMZN"]);
  });

  it("parseVerdicts survives prose preamble + code fences", () => {
    const text = 'Here are my findings:\n```json\n[{"symbol":"AMZN","sector":"Consumer Discretionary","rationale":"GICS: internet retail"}]\n```';
    expect(parseVerdicts(text)).toEqual([
      { symbol: "AMZN", sector: "Consumer Discretionary", rationale: "GICS: internet retail" },
    ]);
  });

  it("applyVerdicts writes + stamps changed AND unchanged rows; Unknown/invalid never write", () => {
    const candidates = getSweepCandidates(db);
    const verdicts = [
      { symbol: "AMZN", sector: "Consumer Discretionary", rationale: "internet retail" },
      { symbol: "GOOG", sector: "Communication Services", rationale: "interactive media" },
    ];
    const { rows, unresolved } = applyVerdicts(db, candidates, verdicts, { apply: true });
    const amzn = db.prepare("SELECT sector, sector_source, sector_verified_at FROM securities WHERE symbol='AMZN'").get() as any;
    expect(amzn.sector).toBe("Consumer Discretionary");
    expect(amzn.sector_source).toBe("gics_verified");
    expect(amzn.sector_verified_at).not.toBeNull();
    const goog = db.prepare("SELECT sector, sector_verified_at FROM securities WHERE symbol='GOOG'").get() as any;
    expect(goog.sector).toBe("Communication Services"); // unchanged…
    expect(goog.sector_verified_at).not.toBeNull();     // …but still stamped
    expect(rows.find((r) => r.symbol === "AMZN")?.changed).toBe(true);
    expect(rows.find((r) => r.symbol === "GOOG")?.changed).toBe(false);
    // a candidate with no verdict lands in unresolved
    expect(unresolved.map((u) => u.symbol)).toContain("KO");
  });

  it("applyVerdicts dry-run reports but does not write", () => {
    const candidates = getSweepCandidates(db);
    applyVerdicts(db, candidates, [{ symbol: "AMZN", sector: "Consumer Discretionary", rationale: "x" }], { apply: false });
    const amzn = db.prepare("SELECT sector, sector_verified_at FROM securities WHERE symbol='AMZN'").get() as any;
    expect(amzn.sector).toBe("Communication Services");
    expect(amzn.sector_verified_at).toBeNull();
  });

  it("Unknown and non-GICS verdicts are unresolved, never written", () => {
    const candidates = getSweepCandidates(db);
    const { unresolved } = applyVerdicts(db, candidates, [
      { symbol: "AMZN", sector: "Unknown", rationale: "unsure" },
      { symbol: "GOOG", sector: "Cyber", rationale: "hallucinated" },
    ], { apply: true });
    expect(unresolved.map((u) => u.symbol)).toEqual(expect.arrayContaining(["AMZN", "GOOG"]));
    const amzn = db.prepare("SELECT sector_verified_at FROM securities WHERE symbol='AMZN'").get() as any;
    expect(amzn.sector_verified_at).toBeNull();
  });

  it("cascadeOptionSectors copies verified stock sectors onto options, issuerSiblings-aware", () => {
    db.prepare("UPDATE securities SET sector='Consumer Discretionary', sector_source='gics_verified', sector_verified_at=datetime('now') WHERE symbol='AMZN'").run();
    db.prepare("UPDATE securities SET sector_source='gics_verified', sector_verified_at=datetime('now') WHERE symbol IN ('GOOG','KO')").run();
    // GOOGL option's underlying "GOOGL" doesn't exist as a row — must resolve to GOOG via issuerSiblings
    const n = cascadeOptionSectors(db, { apply: true });
    expect(n).toBeGreaterThanOrEqual(1);
    const opt = db.prepare("SELECT sector, sector_verified_at FROM securities WHERE symbol='GOOGL 260117C00200000'").get() as any;
    expect(opt.sector).toBe("Communication Services");
    expect(opt.sector_verified_at).toBeNull(); // options are derived rows — never stamped
  });

  it("runSectorVerification wires it together with an injected fetcher", async () => {
    const result = await runSectorVerification(db, {
      apply: true,
      fetchVerdicts: async (batch) =>
        JSON.stringify(batch.map((c) => ({
          symbol: c.symbol,
          sector: c.symbol === "AMZN" ? "Consumer Discretionary" : c.sector ?? "Unknown",
          rationale: "test",
        }))),
    });
    expect(result.applied).toBe(true);
    expect(result.rows.find((r) => r.symbol === "AMZN")?.newSector).toBe("Consumer Discretionary");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

- [ ] **Step 3: Implement `lib/securities/verify-sector-tags.ts`.** Key behaviors (full file, one responsibility per function):

```ts
/**
 * Web-search-verified GICS sector sweep — the repair + standing resolution
 * tool for Bloomberg-taxonomy sector corruption. Dry-run by default; every
 * verified row (changed OR confirmed) is stamped sector_source='gics_verified'
 * + sector_verified_at, which is what the Data Health drift panel suppresses
 * on. Options are derived rows: sector copied from the verified underlying
 * (issuerSiblings-aware), never stamped.
 * Spec: docs/superpowers/specs/2026-07-28-sector-tag-verification-design.md
 */
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { GICS_SECTORS } from "@/lib/securities/normalize-sector";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { isGarbageSymbol } from "@/lib/import/validate";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";

export const SWEEP_BATCH_SIZE = 10;
```

- `getSweepCandidates(db, opts)`: `SELECT id, symbol, name, industry, fund_category, sector FROM securities WHERE LOWER(security_type) IN ('stock','common stock')` + (default) `AND sector_verified_at IS NULL` (omit when `opts.all`); JS-filter `!isGarbageSymbol(symbol)`; `opts.symbols` (case-insensitive exact match) filters last and overrides the verified-skip (a re-verify of a named symbol is the point of the arg).
- `parseVerdicts(text)`: `extractJsonArray(text)` → `JSON.parse` → keep entries with string `symbol`/`sector` (`rationale` defaults `""`). Throw on non-array — the caller reports the batch as failed, never silently.
- `applyVerdicts(db, candidates, verdicts, {apply})`: map verdicts by uppercase symbol; per candidate: no verdict → unresolved `"no verdict returned"`; verdict sector not in `GICS_SECTORS` (this excludes `"Unknown"`) → unresolved with the verdict sector as reason; else build `SweepRowResult` and when `apply`, run `UPDATE securities SET sector = ?, sector_source = 'gics_verified', sector_verified_at = datetime('now') WHERE id = ?` — **even when unchanged** (the stamp IS the deliverable).
- `cascadeOptionSectors(db, {apply})`: read option rows (`LOWER(security_type)='option' AND underlying_symbol IS NOT NULL`); build a map of verified stocks (`sector_verified_at IS NOT NULL`) keyed by uppercase symbol; resolve each option's underlying via `issuerSiblings(underlying).map(s => s.toUpperCase())` membership; where the resolved stock's sector differs from the option's, `UPDATE securities SET sector = ? WHERE id = ?` (NO stamp, NO sector_source), gated on `apply`. Return the count of rows that were (or would be) updated.
- `defaultFetchVerdicts(batch)`: mirror `lib/etf/sector-weights.ts::fetchEtfSectorWeights` — `resolveFeatureModel("sectorVerification")`, throw if provider ≠ anthropic, `getRawAnthropicClient("sectorVerification")`, one `messages.create` per batch with `tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]`, `max_tokens: 4096`, and this prompt (batch rows rendered one per line as `SYMBOL | name | industry: X | fund_category: Y | current sector: Z`):

```
You are verifying GICS sector classifications. For EACH security below, determine its current official GICS-11 sector. Use web_search to verify any name you are not completely certain of — especially recent GICS reclassifications, small caps, and foreign listings. The candidate context lines are hints, not truth: the "current sector" may be wrong (that is why you are verifying).

GICS-11 sectors (exact spellings): Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate.

Return ONLY a JSON array: [{"symbol": "...", "sector": "<GICS-11 or Unknown>", "rationale": "<one line>"}]. Use "Unknown" when you cannot determine the sector confidently — never guess.
```

  Join all text blocks (server tools emit preamble text blocks — take them all, `parseVerdicts` isolates the array).
- `runSectorVerification(db, opts)`: candidates → chunk by `SWEEP_BATCH_SIZE` → `fetchVerdicts ?? defaultFetchVerdicts` per batch (a thrown batch adds all its candidates to unresolved with the error message and continues) → `applyVerdicts` per batch (accumulate) → `cascadeOptionSectors` once at the end, passing the same `{apply}` through (on a dry-run nothing was stamped, so the verified-stock set is empty and the count is naturally 0 — no special-casing) → `SweepResult`.

- [ ] **Step 4: Register the feature key.** `lib/ai/feature-keys.ts`: add `| "sectorVerification"` beside `securityClassification`. `lib/ai/models.ts`: add `sectorVerification: "anthropic/$frontier",` in `FEATURE_MODELS` (frontier: one-time sweep, accuracy over cost).

- [ ] **Step 5: Run the new test file — expect PASS. Then full suite** (a `FEATURE_MODELS` keys test may pin the key list — update it).

- [ ] **Step 6: CLI wrapper `scripts/verify-sector-tags.ts`** — mirror the arg/db/main conventions of `scripts/backfill-fund-categories.ts` (async `main()`, prod DB via the same import that script uses):

```ts
/**
 * Web-search-verified GICS sector sweep (dry-run by default).
 *   npx tsx scripts/verify-sector-tags.ts               # dry-run, unverified rows
 *   npx tsx scripts/verify-sector-tags.ts --apply       # write + stamp
 *   npx tsx scripts/verify-sector-tags.ts --all         # include already-verified rows
 *   npx tsx scripts/verify-sector-tags.ts --apply UNH AMZN   # re-verify named symbols
 */
```

Parse `--apply` / `--all` / positional symbols; call `runSectorVerification`; print a table `SYMBOL  old → new  (rationale)` for changed rows, a `confirmed: N` count, every unresolved row with its reason, `optionRowsUpdated`, and this companion checklist verbatim at the end of an `--apply` run:

```
Next steps:
  1. npx tsx scripts/reprocess-sector-etf-gaps.ts        (re-map reaction-snapshot gaps)
  2. Force-regen macro themes: POST /api/analysis/macro-themes {scope} per scope
  3. Analysis narratives self-refresh weekly — no action
  4. Browser-check Defense tab + Analysis allocation + a repaired name's Security Detail
```

- [ ] **Step 7: `npx tsc --noEmit` (or `npx next build` if that's the session norm) + full suite — expect clean/PASS.**

- [ ] **Step 8: Commit** (`feat(securities): web_search-verified sector sweep library + CLI (feature key sectorVerification)`)

---

### Task 4: Data Health "Sector disagreements" panel

**Files:**
- Modify: `lib/queries/data-health.ts` (add `SectorDisagreement` + `getSectorDisagreements`)
- Modify: `app/dashboard/data-health/page.tsx` (new section, mirroring the existing "Unmapped sector ETFs" section)
- Test: `tests/queries/data-health-sector-disagreements.test.ts`

**Interfaces:**
- Consumes: migration 071 columns; `normalizeSector`.
- Produces:

```ts
export interface SectorDisagreement {
  symbol: string;
  sector: string | null;
  fund_category: string;
  industry: string | null;
  impliedSector: string;   // normalizeSector(X) from "US Sector Equity (X)"
}
export function getSectorDisagreements(db: Database.Database): SectorDisagreement[];
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/queries/data-health-sector-disagreements.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSectorDisagreements } from "@/lib/queries/data-health";

describe("getSectorDisagreements", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    const ins = db.prepare(
      "INSERT INTO securities (symbol, security_type, sector, fund_category, industry, source_key) VALUES (?, 'Stock', ?, ?, ?, ?)"
    );
    ins.run("VRTX", "Consumer Staples", "US Sector Equity (Health Care)", "Biotechnology", "t:vrtx"); // unverified disagreement → flags
    ins.run("GOOG", "Communication Services", "US Sector Equity (Technology)", "Internet", "t:goog"); // will be verified below → suppressed
    ins.run("NVDA", "Technology", "US Sector Equity (Semiconductors)", "Semiconductors", "t:nvda");   // X not a GICS sector → never flags
    ins.run("KO", "Consumer Staples", "US Sector Equity (Consumer Staples)", "Beverages", "t:ko");    // agrees → no flag
    ins.run("TSM", "Technology", "International Equity", "Semiconductors", "t:tsm");                  // shape mismatch → no flag
    db.prepare("UPDATE securities SET sector_verified_at = datetime('now'), sector_source='gics_verified' WHERE symbol='GOOG'").run();
  });

  it("flags only unverified sector-shape disagreements", () => {
    const rows = getSectorDisagreements(db);
    expect(rows.map((r) => r.symbol)).toEqual(["VRTX"]);
    expect(rows[0].impliedSector).toBe("Healthcare");
  });

  it("a null sector with a sector-shaped fund_category flags too", () => {
    db.prepare("UPDATE securities SET sector = NULL WHERE symbol='KO'").run();
    expect(getSectorDisagreements(db).map((r) => r.symbol)).toEqual(
      expect.arrayContaining(["KO", "VRTX"])
    );
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (function not exported).

- [ ] **Step 3: Implement** in `lib/queries/data-health.ts`:

```ts
const SECTOR_SHAPE = /^US Sector Equity \((.+)\)$/;

export function getSectorDisagreements(db: Database.Database): SectorDisagreement[] {
  const rows = db
    .prepare(
      `SELECT symbol, sector, fund_category, industry
       FROM securities
       WHERE LOWER(security_type) IN ('stock','common stock')
         AND fund_category LIKE 'US Sector Equity (%'
         AND sector_verified_at IS NULL
       ORDER BY symbol`
    )
    .all() as { symbol: string; sector: string | null; fund_category: string; industry: string | null }[];
  const out: SectorDisagreement[] = [];
  for (const r of rows) {
    const m = SECTOR_SHAPE.exec(r.fund_category);
    if (!m) continue;
    const implied = normalizeSector(m[1]);
    if (!implied) continue;             // "Semiconductors" etc — finer than GICS, not a disagreement
    if (r.sector === implied) continue; // agrees
    out.push({ ...r, impliedSector: implied });
  }
  return out;
}
```

(`normalizeSector` import already exists in the module or add it.)

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Page section.** In `app/dashboard/data-health/page.tsx`, call `getSectorDisagreements(db)` alongside `getSectorEtfGaps` and add a sibling `<section>` (same classes as "Unmapped sector ETFs") titled **"Sector disagreements"**, explainer: *"Stocks whose GICS sector tag disagrees with their fund category and have not been verified. Resolve with `npx tsx scripts/verify-sector-tags.ts --apply SYMBOL…` — verification stamps the row and suppresses legitimate divergences (e.g. GOOG: GICS Communication Services vs a Technology fund category)."* Table columns: Symbol (mono) | Sector ("—" when null) | Implied (fund category) | Industry. Empty state: *"No unverified sector disagreements."*

- [ ] **Step 6: Full suite + `npx tsc --noEmit` — expect PASS/clean.**

- [ ] **Step 7: Commit** (`feat(data-health): unverified sector-disagreement panel`)

---

### Task 5: Live sweep + companions + E2E  *(MAIN SESSION — interactive, live API + user review; NOT a subagent task)*

- [ ] Dry-run: `npx tsx scripts/verify-sector-tags.ts` — review the full old→new table. Expected repairs from the spec's fixture table: UNH/OSCR/VRTX/ESTA/DHR → Healthcare; AMZN → Consumer Discretionary; HOOD → Financials; UBER → Industrials; SHOP/APP → Technology; IMAX → Communication Services; LAND/KRC → Real Estate; VRT → Industrials; GOOG/META/KO/NKE/HD/GS/BAC confirmed unchanged. Investigate any verdict that contradicts these before applying.
- [ ] Apply: `npx tsx scripts/verify-sector-tags.ts --apply`; spot-check 3 rows in the DB (sector, sector_source, sector_verified_at) + option cascade rows.
- [ ] Companions: `npx tsx scripts/reprocess-sector-etf-gaps.ts`; force-regen macro themes per scope.
- [ ] Browser E2E (agent-browser): Defense tab Tier-2 attribution, Analysis allocation breakdown (Healthcare weight should jump, Comm Services shrink), UNH + AMZN Security Detail, Data Health panel empty.
- [ ] TODO.md: close the sector-corruption entry with commit hashes; note the chat re-grade is a user follow-up.
