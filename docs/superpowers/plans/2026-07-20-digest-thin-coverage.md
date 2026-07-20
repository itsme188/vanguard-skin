# Digest Thin-Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calendar-listing-only held names collapse from forced `##` sections into one compact roster line; essay-only held names surface via a 📄 deep-dives pointer line — Mac composer + Worker evening mirror.

**Architecture:** A new pure module `lib/digest/thin-coverage.ts` partitions listing-only held buckets OUT of synthesis input (so neither the model nor `enforceHeldSections` ever sees them) and renders deterministic lines inserted before `## Also covered`. `insertCrossFilePointers` gains an `unfiled` return for essays it couldn't file. The Worker's `fallback-evening.ts` gets a local mirror of the partition + roster (its bucket shape differs; essay line is Mac-only).

**Tech Stack:** TypeScript, Vitest (in-memory SQLite for the Mac wiring test, existing mock harness for the Worker test).

**Spec:** `docs/superpowers/specs/2026-07-20-digest-thin-coverage-design.md`

## Global Constraints

- `LISTING_BREADTH_MIN = 8` — identical value both sides, parity-pinned.
- Null/unparseable `mentioned_symbols` → NOT a listing article (never waive on parse failure).
- Held-membership tests are issuerSiblings-aware on both sides.
- Empty roster AND empty unfiled → output byte-identical to today.
- Macro bucket never partitioned: Mac `"(no symbol)"`, Worker `"(macro/other)"`.
- Commit messages: write to a temp file, `git commit -F <file>` (never inline `-m`). Append the standard Co-Authored-By + Claude-Session trailer used by this session's earlier commits.
- Run `npx vitest run <file>` from the repo root for Mac tests; from `workers/cron/` for Worker tests.

---

### Task 1: Pure module `lib/digest/thin-coverage.ts`

**Files:**
- Modify: `lib/digest/group-by-company.ts:76` (export `parseSymbolList`)
- Create: `lib/digest/thin-coverage.ts`
- Test: `tests/digest/thin-coverage.test.ts`

**Interfaces:**
- Consumes: `CompanyBucket`, `parseSymbolList` from `@/lib/digest/group-by-company`; `issuerSiblings` from `@/lib/securities/issuer-family`.
- Produces (used by Tasks 2–4):
  - `LISTING_BREADTH_MIN: number` (= 8)
  - `isListingArticle(a: { mentioned_symbols: string | null }): boolean`
  - `partitionListingOnlyHeldBuckets(buckets: CompanyBucket[], heldSymbols: string[]): { active: CompanyBucket[]; rosterSymbols: string[] }`
  - `renderThinCoverageLines(rosterSymbols: string[], unfiledEssays: Array<{ symbols: string[]; source_name: string; subject: string }>): string` — `""` when both inputs empty
  - `insertBeforeAlsoCovered(markdown: string, block: string): string`

- [ ] **Step 1: Export `parseSymbolList`**

In `lib/digest/group-by-company.ts`, change the declaration at line ~76 from `function parseSymbolList(` to `export function parseSymbolList(`. No other changes.

- [ ] **Step 2: Write the failing tests**

Create `tests/digest/thin-coverage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  LISTING_BREADTH_MIN,
  isListingArticle,
  partitionListingOnlyHeldBuckets,
  renderThinCoverageLines,
  insertBeforeAlsoCovered,
} from "@/lib/digest/thin-coverage";
import type { CompanyBucket, ArticleLike } from "@/lib/digest/group-by-company";

function art(symbols: string[] | null, over: Partial<ArticleLike> = {}): ArticleLike {
  return {
    id: 1,
    source_name: "Vital Knowledge",
    subject: "Week ahead",
    summary: "Earnings calendar for the week.",
    sentiment: null,
    mentioned_symbols: symbols ? JSON.stringify(symbols) : null,
    portfolio_relevance: null,
    key_themes: null,
    source_url: "https://example.com/wk",
    website_url: null,
    ...over,
  };
}

const NINE = ["MSFT", "HD", "GS", "JPM", "XOM", "RBRK", "NSC", "TXN", "VZ"];

function bucket(symbol: string, articles: ArticleLike[]): CompanyBucket {
  return { symbol, companyName: null, articles };
}

describe("isListingArticle", () => {
  it("true at breadth >= LISTING_BREADTH_MIN, false below", () => {
    expect(LISTING_BREADTH_MIN).toBe(8);
    expect(isListingArticle(art(NINE))).toBe(true);
    expect(isListingArticle(art(NINE.slice(0, 8)))).toBe(true);
    expect(isListingArticle(art(NINE.slice(0, 7)))).toBe(false);
    expect(isListingArticle(art(["GS", "MS"]))).toBe(false);
  });

  it("null / unparseable mentioned_symbols is NOT a listing (safe default)", () => {
    expect(isListingArticle(art(null))).toBe(false);
    expect(isListingArticle({ mentioned_symbols: "not json" })).toBe(false);
  });
});

describe("partitionListingOnlyHeldBuckets", () => {
  it("held bucket where every article is a listing moves to the roster", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("GS", [art(NINE)]), bucket("AAPL", [art(["AAPL"])])],
      ["GS", "AAPL"],
    );
    expect(rosterSymbols).toEqual(["GS"]);
    expect(active.map((b) => b.symbol)).toEqual(["AAPL"]);
  });

  it("a single real article keeps the bucket active (mixed bucket)", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("GS", [art(NINE), art(["GS", "MS"])])],
      ["GS"],
    );
    expect(rosterSymbols).toEqual([]);
    expect(active.map((b) => b.symbol)).toEqual(["GS"]);
  });

  it("non-held listing-only buckets stay active", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("TXN", [art(NINE)])],
      ["GS"],
    );
    expect(rosterSymbols).toEqual([]);
    expect(active.map((b) => b.symbol)).toEqual(["TXN"]);
  });

  it("is issuer-family aware (GOOGL bucket, GOOG held)", () => {
    const { rosterSymbols } = partitionListingOnlyHeldBuckets(
      [bucket("GOOGL", [art(NINE)])],
      ["GOOG"],
    );
    expect(rosterSymbols).toEqual(["GOOGL"]);
  });

  it("never partitions the macro bucket and sorts the roster alphabetically", () => {
    const { active, rosterSymbols } = partitionListingOnlyHeldBuckets(
      [
        bucket("(no symbol)", [art(null)]),
        bucket("JPM", [art(NINE)]),
        bucket("GS", [art(NINE)]),
      ],
      ["JPM", "GS", "(NO SYMBOL)"],
    );
    expect(active.map((b) => b.symbol)).toEqual(["(no symbol)"]);
    expect(rosterSymbols).toEqual(["GS", "JPM"]);
  });
});

describe("renderThinCoverageLines", () => {
  it("renders both lines, deep-dives first", () => {
    const out = renderThinCoverageLines(
      ["GS", "JPM"],
      [{ symbols: ["NFLX"], source_name: "Stratechery", subject: "Netflix and the Anthology Era" }],
    );
    expect(out).toBe(
      '📄 Deep dives: NFLX (Stratechery — "Netflix and the Anthology Era") — see Research Desk below\n\n' +
        "On this week's calendar: GS · JPM",
    );
  });

  it("omits an empty line; empty-empty renders empty string", () => {
    expect(renderThinCoverageLines([], [])).toBe("");
    expect(renderThinCoverageLines(["GS"], [])).toBe("On this week's calendar: GS");
    expect(
      renderThinCoverageLines([], [{ symbols: ["NFLX"], source_name: "S", subject: "T" }]),
    ).toBe('📄 Deep dives: NFLX (S — "T") — see Research Desk below');
  });

  it("joins multiple essays with ; and multi-symbol essays with /", () => {
    const out = renderThinCoverageLines(
      [],
      [
        { symbols: ["GOOG", "GOOGL"], source_name: "A", subject: "Alpha" },
        { symbols: ["NFLX"], source_name: "B", subject: "Beta" },
      ],
    );
    expect(out).toBe(
      '📄 Deep dives: GOOG/GOOGL (A — "Alpha"); NFLX (B — "Beta") — see Research Desk below',
    );
  });
});

describe("insertBeforeAlsoCovered", () => {
  it("inserts the block immediately before ## Also covered", () => {
    const md = "## The Session\n\nX.\n\n## Also covered\n\nY.";
    const out = insertBeforeAlsoCovered(md, "BLOCK");
    expect(out.indexOf("BLOCK")).toBeLessThan(out.indexOf("## Also covered"));
    expect(out).toContain("BLOCK\n\n## Also covered");
  });

  it("appends at the end when ## Also covered is absent", () => {
    expect(insertBeforeAlsoCovered("## The Session\n\nX.\n", "BLOCK")).toBe(
      "## The Session\n\nX.\n\nBLOCK",
    );
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/digest/thin-coverage.test.ts`
Expected: FAIL — cannot resolve `@/lib/digest/thin-coverage`.

- [ ] **Step 4: Implement `lib/digest/thin-coverage.ts`**

```typescript
/**
 * thin-coverage.ts — deterministic handling for held names whose digest
 * coverage is too thin for a real `##` section (spec:
 * docs/superpowers/specs/2026-07-20-digest-thin-coverage-design.md).
 *
 * Two kinds of thin coverage, two compact lines:
 *   - Calendar-listing-only buckets (every article is a >=8-symbol roundup)
 *     are partitioned OUT of synthesis input before the model runs — the
 *     model can't write a section for them, and enforceHeldSections (which
 *     iterates the input buckets) naturally stops stubbing them. They render
 *     as one "On this week's calendar: …" roster line instead.
 *   - Essays that insertCrossFilePointers could not file (no matching
 *     `## SYM` section) render as one "📄 Deep dives: …" pointer line.
 *
 * Worker mirror: workers/cron/src/fallback-evening.ts carries a local
 * adaptation of the partition + roster (different bucket shape, no essay
 * split there). LISTING_BREADTH_MIN is parity-pinned by
 * workers/cron/test/editions.test.ts.
 */
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { parseSymbolList, type CompanyBucket } from "@/lib/digest/group-by-company";

export const LISTING_BREADTH_MIN = 8;

const NO_SYMBOL_BUCKET = "(no symbol)";

/**
 * An article mentioning >= LISTING_BREADTH_MIN symbols is a roundup/listing
 * for EVERY symbol it mentions. Null/unparseable mentioned_symbols parse to
 * [] — never a listing, so a parse failure can't silently waive a section.
 */
export function isListingArticle(a: { mentioned_symbols: string | null }): boolean {
  return parseSymbolList(a.mentioned_symbols).length >= LISTING_BREADTH_MIN;
}

/**
 * Split held listing-only buckets out of the synthesis input. A bucket moves
 * to the roster iff it is held (issuerSiblings-aware), non-macro, non-empty,
 * and EVERY article in it is a listing article.
 */
export function partitionListingOnlyHeldBuckets(
  buckets: CompanyBucket[],
  heldSymbols: string[],
): { active: CompanyBucket[]; rosterSymbols: string[] } {
  const heldSet = new Set(heldSymbols.map((s) => s.toUpperCase()));
  const active: CompanyBucket[] = [];
  const rosterSymbols: string[] = [];
  for (const bucket of buckets) {
    const isHeld =
      bucket.symbol !== NO_SYMBOL_BUCKET &&
      issuerSiblings(bucket.symbol).some((s) => heldSet.has(s.toUpperCase()));
    const allListing = bucket.articles.length > 0 && bucket.articles.every(isListingArticle);
    if (isHeld && allListing) rosterSymbols.push(bucket.symbol);
    else active.push(bucket);
  }
  rosterSymbols.sort();
  return { active, rosterSymbols };
}

/**
 * Render the two compact lines (deep-dives first, then the calendar roster).
 * Either line is omitted when its input is empty; both empty -> "".
 */
export function renderThinCoverageLines(
  rosterSymbols: string[],
  unfiledEssays: Array<{ symbols: string[]; source_name: string; subject: string }>,
): string {
  const lines: string[] = [];
  if (unfiledEssays.length > 0) {
    const entries = unfiledEssays.map(
      (e) => `${[...e.symbols].sort().join("/")} (${e.source_name} — "${e.subject}")`,
    );
    lines.push(`📄 Deep dives: ${entries.join("; ")} — see Research Desk below`);
  }
  if (rosterSymbols.length > 0) {
    lines.push(`On this week's calendar: ${[...rosterSymbols].sort().join(" · ")}`);
  }
  return lines.join("\n\n");
}

/**
 * Insert `block` immediately before the `## Also covered` closing section,
 * or append at the end when that section is absent. Single source for the
 * placement behavior shared by enforceHeldSections and the thin-coverage
 * lines.
 */
export function insertBeforeAlsoCovered(markdown: string, block: string): string {
  const alsoMatch = markdown.match(/^## Also covered\s*$/m);
  if (alsoMatch && alsoMatch.index !== undefined) {
    return markdown.slice(0, alsoMatch.index) + block + "\n\n" + markdown.slice(alsoMatch.index);
  }
  return `${markdown.trimEnd()}\n\n${block}`;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/digest/thin-coverage.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add lib/digest/thin-coverage.ts lib/digest/group-by-company.ts tests/digest/thin-coverage.test.ts
# message via temp file + trailer:
# feat(digest): thin-coverage pure module (listing partition + compact lines)
```

---

### Task 2: Mac refactors — enforcement helper + `insertCrossFilePointers` unfiled return

**Files:**
- Modify: `lib/digest/synthesize.ts:227-241` (enforceHeldSections tail)
- Modify: `lib/digest/research-desk.ts:77-108` (insertCrossFilePointers)
- Modify: `lib/digest/daily-digest.ts:522` (caller — mechanical destructure only; full wiring is Task 3)
- Test: `tests/digest/research-desk.test.ts` (update call sites + 2 new tests), `tests/digest/synthesize.test.ts` (no edits — must stay green)

**Interfaces:**
- Consumes: `insertBeforeAlsoCovered` from Task 1.
- Produces: `insertCrossFilePointers(aiMarkdown, essays, heldAndWatchlist): { markdown: string; unfiled: Array<{ source_name: string; subject: string; symbols: string[] }> }` — Task 3 consumes `unfiled`.

- [ ] **Step 1: Refactor `enforceHeldSections` onto the shared helper**

In `lib/digest/synthesize.ts`, add to the imports:

```typescript
import { insertBeforeAlsoCovered } from "@/lib/digest/thin-coverage";
```

Replace the tail of `enforceHeldSections` (from `const stubBlock = stubs.join("\n\n");` through the closing `return` — currently the inline `alsoMatch` logic) with:

```typescript
  const stubBlock = stubs.join("\n\n");
  return insertBeforeAlsoCovered(markdown, stubBlock);
```

- [ ] **Step 2: Run the pinned synthesize tests — behavior must be unchanged**

Run: `npx vitest run tests/digest/synthesize.test.ts`
Expected: PASS with zero edits to that file.

- [ ] **Step 3: Write the failing tests for the unfiled return**

In `tests/digest/research-desk.test.ts`, existing `insertCrossFilePointers` assertions change from using the return value as a string to `.markdown` (mechanical: `const out = insertCrossFilePointers(...)` → assert on `out.markdown`). Add:

```typescript
it("returns unfiled essays when no matching ## section exists", () => {
  const md = "## The Session\n\nX.\n\n## Also covered\n\nY.";
  const essay = {
    source_name: "Stratechery",
    subject: "Netflix and the Anthology Era",
    summary: null,
    mentioned_symbols: JSON.stringify(["NFLX"]),
    key_themes: null,
    source_url: null,
    website_url: null,
  };
  const { markdown, unfiled } = insertCrossFilePointers(md, [essay], ["NFLX"]);
  expect(markdown).toBe(md); // nothing filed, markdown untouched
  expect(unfiled).toEqual([
    { source_name: "Stratechery", subject: "Netflix and the Anthology Era", symbols: ["NFLX"] },
  ]);
});

it("a filed essay is NOT in unfiled; an irrelevant essay is neither filed nor unfiled", () => {
  const md = "## NFLX (Netflix)\n\nCovered.\n\n## Also covered\n\nY.";
  const filed = {
    source_name: "Stratechery", subject: "T1", summary: null,
    mentioned_symbols: JSON.stringify(["NFLX"]), key_themes: null,
    source_url: null, website_url: null,
  };
  const irrelevant = {
    source_name: "Odd Lots", subject: "T2", summary: null,
    mentioned_symbols: JSON.stringify(["ZZZZ"]), key_themes: null,
    source_url: null, website_url: null,
  };
  const { markdown, unfiled } = insertCrossFilePointers(md, [filed, irrelevant], ["NFLX"]);
  expect(markdown).toContain("Deep dive today");
  expect(unfiled).toEqual([]);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run tests/digest/research-desk.test.ts`
Expected: FAIL — return value is a string, `.markdown` undefined / new tests fail.

- [ ] **Step 5: Implement the signature change**

In `lib/digest/research-desk.ts`, replace `insertCrossFilePointers` with:

```typescript
export interface CrossFileResult {
  markdown: string;
  /** Essays covering a held/watchlist symbol that had NO matching ## section. */
  unfiled: Array<{ source_name: string; subject: string; symbols: string[] }>;
}

export function insertCrossFilePointers(
  aiMarkdown: string,
  essays: EssayLike[],
  heldAndWatchlist: string[],
): CrossFileResult {
  const unfiled: CrossFileResult["unfiled"] = [];
  if (essays.length === 0 || heldAndWatchlist.length === 0) {
    return { markdown: aiMarkdown, unfiled };
  }

  const relevant = new Set(
    heldAndWatchlist.flatMap((s) => issuerSiblings(s)).map((s) => s.toUpperCase()),
  );

  let lines = aiMarkdown.split("\n");
  for (const essay of essays) {
    const symbols = parseJsonArray(essay.mentioned_symbols)
      .map((s) => s.toUpperCase())
      .filter((s) => relevant.has(s));
    if (symbols.length === 0) continue; // not held/watchlist-relevant: neither filed nor unfiled

    const fileUnder = new Set(symbols.flatMap((s) => issuerSiblings(s)).map((s) => s.toUpperCase()));

    const idx = lines.findIndex((line) => {
      const m = line.match(/^##\s+([A-Z][A-Z0-9.\-]*)\b/);
      return m !== null && fileUnder.has(m[1].toUpperCase());
    });
    if (idx === -1) {
      unfiled.push({ source_name: essay.source_name, subject: essay.subject, symbols });
      continue;
    }

    const pointer = `📄 *Deep dive today: **${essay.source_name}** — "${essay.subject}" (see Research Desk below)*`;
    lines = [...lines.slice(0, idx + 1), pointer, ...lines.slice(idx + 1)];
  }
  return { markdown: lines.join("\n"), unfiled };
}
```

Then in `lib/digest/daily-digest.ts` line ~522, mechanically adapt the caller (full wiring is Task 3):

```typescript
      synth = insertCrossFilePointers(synth, essays, [...heldSymbols, ...watchlist]).markdown;
```

- [ ] **Step 6: Run to verify pass + no other callers broke**

Run: `npx vitest run tests/digest/research-desk.test.ts tests/digest/adaptive-layout.test.ts tests/digest/structured-composer.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add lib/digest/synthesize.ts lib/digest/research-desk.ts lib/digest/daily-digest.ts tests/digest/research-desk.test.ts
# refactor(digest): shared Also-covered insertion + unfiled-essay return
```

---

### Task 3: Mac composer wiring

**Files:**
- Modify: `lib/digest/daily-digest.ts` (~lines 498–527: the synthesis branch of `generateDigestSinceAdaptive`)
- Test: `tests/digest/adaptive-layout.test.ts` (1 new test)

**Interfaces:**
- Consumes: `partitionListingOnlyHeldBuckets`, `renderThinCoverageLines`, `insertBeforeAlsoCovered` (Task 1); `insertCrossFilePointers` returning `{ markdown, unfiled }` (Task 2).
- Produces: final Mac composer behavior — no new exports.

- [ ] **Step 1: Write the failing wiring test**

Add to `tests/digest/adaptive-layout.test.ts` (reuse the file's existing `seedArticles` pattern; seed helpers below are local to the new test if not already present in the file):

```typescript
it("listing-only held bucket → roster line, no synthesis bucket, no stub", async () => {
  // Hold GS: seed account + security + holding (getHeldSymbols reads holdings⋈securities).
  const acctId = (() => {
    db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run("Vanguard Taxable");
    return (db.prepare("SELECT id FROM accounts WHERE name = ?").get("Vanguard Taxable") as { id: number }).id;
  })();
  const secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('GS', 'Goldman Sachs', 'stock', 'equity', 1)")
    .run().lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, '2026-07-20', 'test:gs')",
  ).run(acctId, secId);

  // 5 real AAPL articles (clears SYNTHESIS_MIN_ARTICLES) + 1 nine-symbol listing article naming GS.
  seedArticles(5);
  const srcId = (db.prepare("SELECT id FROM research_sources LIMIT 1").get() as { id: number }).id;
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at, mentioned_symbols)
     VALUES (?, 'Week ahead calendar', 's@example.com', datetime('now'), 'Body', 'The week''s reporters.', 'neutral', datetime('now'), ?)`,
  ).run(srcId, JSON.stringify(["MSFT", "HD", "GS", "JPM", "XOM", "RBRK", "NSC", "TXN", "VZ"]));

  (synthesize as ReturnType<typeof vi.fn>).mockResolvedValue(
    "## Overnight & Setup\n\nMacro.\n\n## AAPL (Apple)\n\nCovered.\n\n## Also covered\n\nThin.",
  );

  const out = await generateDigestSinceAdaptive(db, "2020-01-01");

  // Roster line present, placed before ## Also covered.
  expect(out).toContain("On this week's calendar: GS");
  expect(out!.indexOf("On this week's calendar: GS")).toBeLessThan(out!.indexOf("## Also covered"));
  // No GS section or stub was manufactured.
  expect(out).not.toMatch(/^## GS\b/m);
  // The listing-only GS bucket never reached the model.
  const input = (synthesize as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(input.buckets.map((b: { symbol: string }) => b.symbol)).not.toContain("GS");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/digest/adaptive-layout.test.ts`
Expected: FAIL — roster line absent, GS bucket still in synthesize input.

- [ ] **Step 3: Wire the composer**

In `lib/digest/daily-digest.ts`, add imports:

```typescript
import {
  partitionListingOnlyHeldBuckets,
  renderThinCoverageLines,
  insertBeforeAlsoCovered,
} from "@/lib/digest/thin-coverage";
```

Replace the synthesis branch (from `const rawBuckets = bucketByCompany(commentary);` through the `synth = insertCrossFilePointers(...)` line) with:

```typescript
    const rawBuckets = bucketByCompany(commentary);
    const enriched = enrichBucketCompanyNames(db, rawBuckets);
    const { active: buckets, rosterSymbols } = partitionListingOnlyHeldBuckets(
      enriched,
      heldSymbols,
    );

    try {
      let synth = await synthesize({
        buckets,
        heldSymbols,
        watchlist,
        anomalies,
        sessionHeading: edition === "evening" ? "The Session" : "Overnight & Setup",
      });
      const crossFiled = insertCrossFilePointers(synth, essays, [...heldSymbols, ...watchlist]);
      synth = crossFiled.markdown;
      const thinLines = renderThinCoverageLines(rosterSymbols, crossFiled.unfiled);
      if (thinLines) synth = insertBeforeAlsoCovered(synth, thinLines);
```

(The rest of the branch — `lines.push(synth)` onward — is unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/digest/adaptive-layout.test.ts tests/digest/thin-coverage.test.ts tests/digest/synthesize.test.ts && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add lib/digest/daily-digest.ts tests/digest/adaptive-layout.test.ts
# feat(digest): calendar roster + deep-dives lines in the adaptive composer
```

---

### Task 4: Worker mirror + parity pin + full suites

**Files:**
- Modify: `workers/cron/src/fallback-evening.ts` (partition + roster around `synthesizeViaAI`; refactor its `enforceHeldSections` tail onto a local `insertBeforeAlsoCovered`)
- Test: `workers/cron/test/fallback-evening.test.ts` (1 wiring test), `workers/cron/test/editions.test.ts` (parity pin)

**Interfaces:**
- Consumes: Worker-local `RecentArticleMeta`, `issuerSiblings` (from `./fallback-earnings`), `parseJsonArray` (already in fallback-evening.ts).
- Produces: exported `partitionListingOnlyHeldBuckets` (Worker shape) for the test; `LISTING_BREADTH_MIN` constant (parity-pinned).

- [ ] **Step 1: Write the failing tests**

In `workers/cron/test/fallback-evening.test.ts` (inside the `enforceHeldSections` describe or a new one):

```typescript
it("listing-only held bucket is waived into the roster line, not stubbed", async () => {
  const env = makeEnv();
  const snapshot = makeV3Snapshot({ articleCount: 7 });
  const arts = snapshot.recentArticlesMeta as Array<Record<string, unknown>>;
  // Article 0 becomes a nine-symbol listing naming held AAPL.
  arts[0].mentioned_symbols = JSON.stringify([
    "AAPL", "MSFT", "HD", "GS", "JPM", "XOM", "RBRK", "NSC", "TXN",
  ]);
  (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshot);
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
  (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({
    text:
      "## The Session\n\n" +
      "Broad rotation continued across sectors today with breadth improving " +
      "into the close and multiple newsletters flagging positioning shifts " +
      "ahead of the week's heavy earnings calendar across held names.\n\n" +
      "## Also covered\n\nThin mentions.",
    finishReason: "stop",
  });

  const result = await runFallbackEvening(env, {});
  expect(result.kind).toBe("success");
  const sent = JSON.stringify((sendEmail as ReturnType<typeof vi.fn>).mock.calls[0]);
  expect(sent).toContain("On this week's calendar: AAPL");
  expect(sent).not.toContain("auto-surfaced"); // no enforcement stub for AAPL
});
```

In `workers/cron/test/editions.test.ts`, add (following that file's existing fs-read parity style):

```typescript
it("LISTING_BREADTH_MIN parity (thin-coverage Worker mirror)", () => {
  const mac = readFileSync(resolve(__dirname, "../../../lib/digest/thin-coverage.ts"), "utf8");
  const worker = readFileSync(resolve(__dirname, "../src/fallback-evening.ts"), "utf8");
  const grab = (s: string) => s.match(/LISTING_BREADTH_MIN = (\d+)/)?.[1];
  expect(grab(mac)).toBe("8");
  expect(grab(worker)).toBe(grab(mac));
});
```

(If the file lacks `readFileSync`/`resolve` imports, add `import { readFileSync } from "node:fs"; import { resolve } from "node:path";` — match whatever the existing parity tests in that file already import.)

- [ ] **Step 2: Run to verify failure**

Run (from `workers/cron/`): `npx vitest run test/fallback-evening.test.ts test/editions.test.ts`
Expected: FAIL — roster line absent (stub present instead); parity grab undefined for Worker.

- [ ] **Step 3: Implement the Worker mirror**

In `workers/cron/src/fallback-evening.ts`:

(a) Below the `bucketByCompany` function, add:

```typescript
// ── Thin-coverage mirror ─────────────────────────────────────────────────────
// Worker adaptation of lib/digest/thin-coverage.ts (2026-07-20): held buckets
// whose every article is a >=8-symbol listing are waived out of synthesis into
// one roster line. Different bucket shape (Record<symbol, RecentArticleMeta[]>)
// — semantic mirror, not byte-parity. Keep LISTING_BREADTH_MIN in sync with
// the Mac module (parity-pinned by test/editions.test.ts).
const LISTING_BREADTH_MIN = 8;
const NO_SYMBOL_BUCKET = "(macro/other)";

function isListingArticle(a: { mentioned_symbols: string | null }): boolean {
  return parseJsonArray(a.mentioned_symbols).length >= LISTING_BREADTH_MIN;
}

export function partitionListingOnlyHeldBuckets(
  buckets: Record<string, RecentArticleMeta[]>,
  heldSymbols: string[],
): { active: Record<string, RecentArticleMeta[]>; rosterSymbols: string[] } {
  const heldSet = new Set(heldSymbols.map((s) => s.toUpperCase()));
  const active: Record<string, RecentArticleMeta[]> = {};
  const rosterSymbols: string[] = [];
  for (const [symbol, articles] of Object.entries(buckets)) {
    const isHeld =
      symbol !== NO_SYMBOL_BUCKET &&
      issuerSiblings(symbol).some((s) => heldSet.has(s.toUpperCase()));
    const allListing = articles.length > 0 && articles.every(isListingArticle);
    if (isHeld && allListing) rosterSymbols.push(symbol);
    else active[symbol] = articles;
  }
  rosterSymbols.sort();
  return { active, rosterSymbols };
}

function insertBeforeAlsoCoveredWorker(markdown: string, block: string): string {
  const alsoMatch = markdown.match(/^## Also covered\s*$/m);
  if (alsoMatch && alsoMatch.index !== undefined) {
    return markdown.slice(0, alsoMatch.index) + block + "\n\n" + markdown.slice(alsoMatch.index);
  }
  return `${markdown.trimEnd()}\n\n${block}`;
}
```

(b) In `enforceHeldSections`, replace its inline `alsoMatch` tail with:

```typescript
  const stubBlock = stubs.join("\n\n");
  return insertBeforeAlsoCoveredWorker(markdown, stubBlock);
```

(c) In `synthesizeViaAI`, replace the first two lines and the final return:

```typescript
  const allBuckets = bucketByCompany(articles);
  const { active: buckets, rosterSymbols } = partitionListingOnlyHeldBuckets(
    allBuckets,
    snap.heldSymbols ?? [],
  );
  const prompt = buildSynthesisPrompt(buckets, snap);
```

and the success return becomes:

```typescript
    let out = enforceHeldSections(stripped, buckets, snap.heldSymbols ?? []);
    if (rosterSymbols.length > 0) {
      out = insertBeforeAlsoCoveredWorker(
        out,
        `On this week's calendar: ${rosterSymbols.join(" · ")}`,
      );
    }
    return out;
```

- [ ] **Step 4: Run to verify pass**

Run (from `workers/cron/`): `npx vitest run && npx tsc --noEmit`
Expected: all Worker tests PASS, tsc clean.

- [ ] **Step 5: Full Mac suite + build check**

Run (repo root): `npx vitest run` → expect all PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add workers/cron/src/fallback-evening.ts workers/cron/test/fallback-evening.test.ts workers/cron/test/editions.test.ts
# feat(worker): calendar-roster waiver mirror in evening fallback synthesis
```

---

## Post-plan (session close, not a task for subagents)

Deploy `workers/cron` (token in `.env.local`), update the CLAUDE.md digest bullet + TODO close-outs, and note the E2E watch: tomorrow's 8:45 digest should show the roster line replacing the calendar stub sections.
