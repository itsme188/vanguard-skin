# Digest Redesign (Edition-Aware Structured Composer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the morning/evening digest emails into edition-aware, story-organized layouts (The Session / Your Names / Research Desk / Also covered + late-arrival rescue), and fix the stale `last_digest_sent_at` pointer when the cloud fallback sends.

**Architecture:** A new deterministic layer (`lib/digest/editions.ts` + `late-arrivals.ts` + `research-desk.ts`) classifies each article by source kind (commentary vs essay) and publication edition (VK Dawn/Mid-Day/Recap, TMTB Morning/EOD wraps) before anything reaches the AI. The existing single Sonnet synthesis call (`dailyDigestSynthesis`) handles only the commentary stream, with edition labels + a supersedence rule in the prompt; essays render in code. Worker fallbacks mirror the structure with a byte-parity editions copy.

**Tech Stack:** TypeScript, better-sqlite3 (DI, `:memory:` tests), Vitest, AI SDK v6 (`generateText` mocked in tests per `memory/feedback_ai_test_mocking.md`), Cloudflare Workers (workers/cron).

**Spec:** `docs/superpowers/specs/2026-06-09-digest-redesign-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| Create `lib/digest/editions.ts` | `SOURCE_KINDS` registry + `classifyEdition()` regex table + `editionLabel()` — pure, no DB |
| Create `lib/digest/late-arrivals.ts` | `splitLateArrivals()` + `renderLateArrivalsBlock()` — pure |
| Create `lib/digest/research-desk.ts` | `splitEssays()` + `renderResearchDesk()` + `insertCrossFilePointers()` — pure |
| Modify `lib/digest/synthesize.ts` | Edition tags in bucket rendering; system prompt gains EDITION COLLAPSING + OUTPUT SECTION ORDER; `sessionHeading` input |
| Modify `lib/digest/daily-digest.ts` | `generateDigestSinceAdaptive` becomes the structured composer (cap 40, edition flavor, section assembly) |
| Modify `lib/digest/send-digest.ts`, `lib/digest/send-evening.ts` | Pass `edition: "morning" / "evening"` |
| Modify `workers/cron/src/dedup.ts` | `getMarkerStatus` returns `sentAt` (KV value is already an ISO timestamp) |
| Modify `lib/cron/marker-check.ts` | `MarkerCheckResult.sentAt` |
| Modify `app/api/cron/digest/route.ts`, `app/api/cron/evening/route.ts` | Advance `last_digest_sent_at` on cloud-skip (forward-only) |
| Create `workers/cron/src/editions.ts` | Byte-parity copy of `lib/digest/editions.ts` |
| Modify `workers/cron/src/fallback-digest.ts` | Commentary/Research Desk section split (deterministic, no new Claude call) |
| Modify `workers/cron/src/fallback-evening.ts` | Edition labels + section contract in `buildSynthesisPrompt` |
| Modify `app/api/digest/preview/route.ts`, `app/dashboard/components/DigestEmailViewer.tsx` | `structuredHtml` + third toggle |
| Tests | `tests/digest/editions.test.ts`, `tests/digest/late-arrivals.test.ts`, `tests/digest/research-desk.test.ts`, `tests/digest/structured-composer.test.ts`, `tests/api/cron-marker-advance.test.ts`, `workers/cron/test/editions.test.ts`; updates to `tests/digest/synthesize.test.ts`, `tests/digest/adaptive-layout.test.ts`, `workers/cron/test/dedup.test.ts`, `workers/cron/test/fallback-digest.test.ts`, `workers/cron/test/fallback-evening.test.ts` |

Conventions that bind every task: all DB functions take `db` (DI); never commit with failing tests; run `npx vitest run <file>` per task and the full suite at the end.

---

### Task 1: Edition classifier + source-kind registry

**Files:**
- Create: `lib/digest/editions.ts`
- Test: `tests/digest/editions.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/digest/editions.test.ts
import { describe, it, expect } from "vitest";
import {
  SOURCE_KINDS,
  sourceKind,
  classifyEdition,
  editionLabel,
} from "@/lib/digest/editions";

// Real subject lines sampled from research_articles, 2026-05-10 → 2026-06-09.
describe("classifyEdition — Vital Knowledge", () => {
  const VK = "Vital Knowledge";
  it.each([
    ["Vital Knowledge: Vital Dawn for Tuesday June 9, 2026", "dawn"],
    ["Vital Knowledge: Company-specific news for Tues 6/9 (BMO) - DBI, DKNG, LE, SAIL", "bmo_news"],
    ["Vital Knowledge: Vital Mid-Day Market Update for Tuesday June 9, 2026", "midday"],
    ["Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026", "recap"],
    ["Vital Knowledge: Company-specific news for Mon 6/8 (AMC) - APLD, AVO, MTN, PRGO", "amc_news"],
    ["Vital Knowledge: Vital Weekend (Sun 6/7/2026) - getting ready for the week ahead", "weekend"],
    ["Vital Knowledge: Vital Catalyst Watch (week of Mon 6/8) - US inflation, ECB/BoC", "catalyst_watch"],
    ["Vital Knowledge: Vital Talking Points – Recap for the Week ended Friday June 5, 2026", "talking_points"],
    ["Vital Knowledge: Iran & tech: thoughts on the Tues market price action", "one_off"],
    ["Vital Knowledge: Blackstone's Gray is bullish on the outlook (growth, inflation)", "one_off"],
  ])("%s → %s", (subject, expected) => {
    expect(classifyEdition(VK, subject).edition).toBe(expected);
  });

  it("supersedence chain: recap ⊐ midday ⊐ dawn", () => {
    expect(classifyEdition(VK, "Vital Knowledge: Vital Market Recap for Monday June 8, 2026").supersedes)
      .toEqual(["midday", "dawn"]);
    expect(classifyEdition(VK, "Vital Knowledge: Vital Mid-Day Market Update for Monday June 8, 2026").supersedes)
      .toEqual(["dawn"]);
    expect(classifyEdition(VK, "Vital Knowledge: Vital Dawn for Monday June 8, 2026").supersedes)
      .toEqual([]);
  });

  // "Talking Points – Recap for the Week" contains the word "Recap" — must NOT match recap.
  it("talking_points is checked before recap", () => {
    expect(
      classifyEdition(VK, "Vital Knowledge: Vital Talking Points – Recap for the Week ended Friday June 5, 2026").edition
    ).toBe("talking_points");
  });
});

describe("classifyEdition — TMT Breakout", () => {
  const TMTB = "TMT Breakout";
  it.each([
    ["TMTB Morning Wrap", "morning_wrap"],
    ["TMTB EOD Wrap", "eod_wrap"],
    ["TMTB EOD Wrap; CRDO HPE First Takes", "eod_wrap"],
    ["TMTB: LITE and SNDK CEOs at Mizuho Conference Key Quotes", "note"],
    ["TMTB: SpaceX (SPCX) Roadshow Webinar Key Quotes", "note"],
  ])("%s → %s", (subject, expected) => {
    expect(classifyEdition(TMTB, subject).edition).toBe(expected);
  });
});

describe("classifyEdition — other sources", () => {
  it("returns standalone with no supersedence", () => {
    const r = classifyEdition("Stratechery Updates", "An Interview with Someone");
    expect(r.edition).toBe("standalone");
    expect(r.supersedes).toEqual([]);
  });
});

describe("SOURCE_KINDS / sourceKind", () => {
  it("classifies the known commentary sources", () => {
    for (const name of [
      "Vital Knowledge", "TMT Breakout", "Purple Drink's Market Musings",
      "Helene Meisler", "Torsten Slok", "TBPN", "James Bulltard", "FundaAI", "JRo's Notes",
    ]) {
      expect(sourceKind(name), name).toBe("commentary");
    }
  });
  it("classifies the known essay sources", () => {
    for (const name of [
      "Stratechery Updates", "The Diff", "MBI Deep Dives", "Semi Doped",
      "Eliant Capital", "Paul Kedrosky", "Sam Ro from TKer", "Liberty’s Highlights",
      "BEP Research", "Simon Willison", "Irrational Analysis", "Mobile Dev Memo",
      "Bloomberg Odd Lots", "Northbeam - The Media Buyer", "Consumer Ascent",
      "TickerTrends Research", "Sharp Text", "Emerging AI", "Investing With Martin",
    ]) {
      expect(sourceKind(name), name).toBe("essay");
    }
  });
  it("defaults unknown sources to essay (listed individually, never merged)", () => {
    expect(sourceKind("Some Brand-New Newsletter")).toBe("essay");
  });
  it("every SOURCE_KINDS value is a valid kind", () => {
    for (const v of Object.values(SOURCE_KINDS)) {
      expect(["commentary", "essay"]).toContain(v);
    }
  });
});

describe("editionLabel", () => {
  it("renders a bracketed tag for cyclical editions and empty for standalone/one_off", () => {
    expect(editionLabel("Vital Knowledge", "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026")).toBe(" [recap]");
    expect(editionLabel("TMT Breakout", "TMTB Morning Wrap")).toBe(" [morning_wrap]");
    expect(editionLabel("Vital Knowledge", "Vital Knowledge: Iran & tech: thoughts")).toBe(" [one-off note]");
    expect(editionLabel("Stratechery Updates", "Anything")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest/editions.test.ts`
Expected: FAIL — `Cannot find module '@/lib/digest/editions'`

- [ ] **Step 3: Write the implementation**

```typescript
// lib/digest/editions.ts
/**
 * editions.ts — Edition classifier + source-kind registry for the digest composer.
 *
 * Newsletter publication schedules are stable external facts; they live here as
 * tested constants (same philosophy as RELEASE_TIMES_ET / issuerSiblings), NOT
 * in the synthesis prompt.
 *
 * Worker mirror: workers/cron/src/editions.ts is a byte-parity hand-copy
 * (Next.js path-alias boundary, like presence-only-position.ts). Keep both in
 * sync; workers/cron/test/editions.test.ts enforces parity.
 */

export type SourceKind = "commentary" | "essay";

export type EditionId =
  | "dawn"
  | "bmo_news"
  | "midday"
  | "recap"
  | "amc_news"
  | "weekend"
  | "catalyst_watch"
  | "talking_points"
  | "one_off"
  | "morning_wrap"
  | "eod_wrap"
  | "note"
  | "standalone";

export interface EditionInfo {
  edition: EditionId;
  /** Earlier editions of the same daily cycle that this one supersedes. */
  supersedes: EditionId[];
}

/**
 * Source name → kind. Keyed by research_sources.name. Unknown sources default
 * to "essay" (safe: essays are listed individually, never merged).
 * Moving a source between kinds is a one-line edit here.
 */
export const SOURCE_KINDS: Record<string, SourceKind> = {
  // commentary — time-sensitive market narration; value is what's NEW today
  "Vital Knowledge": "commentary",
  "TMT Breakout": "commentary",
  "Purple Drink's Market Musings": "commentary",
  "Helene Meisler": "commentary",
  "Torsten Slok": "commentary",
  "TBPN": "commentary",
  "James Bulltard": "commentary",
  "FundaAI": "commentary",
  "JRo's Notes": "commentary",
  // essay — timeless research; value is the argument itself
  "Stratechery Updates": "essay",
  "The Diff": "essay",
  "MBI Deep Dives": "essay",
  "Semi Doped": "essay",
  "Eliant Capital": "essay",
  "Paul Kedrosky": "essay",
  "Sam Ro from TKer": "essay",
  "Liberty’s Highlights": "essay",
  "BEP Research": "essay",
  "Simon Willison": "essay",
  "Irrational Analysis": "essay",
  "Mobile Dev Memo": "essay",
  "Bloomberg Odd Lots": "essay",
  "Northbeam - The Media Buyer": "essay",
  "Consumer Ascent": "essay",
  "TickerTrends Research": "essay",
  "Sharp Text": "essay",
  "Emerging AI": "essay",
  "Investing With Martin": "essay",
};

export function sourceKind(sourceName: string): SourceKind {
  return SOURCE_KINDS[sourceName] ?? "essay";
}

interface EditionPattern {
  pattern: RegExp;
  edition: EditionId;
  supersedes: EditionId[];
}

/**
 * Ordered pattern tables — first match wins, so more specific patterns
 * (talking_points, whose subject contains the word "Recap") come before
 * broader ones.
 */
const VITAL_KNOWLEDGE_PATTERNS: EditionPattern[] = [
  { pattern: /Talking Points/i, edition: "talking_points", supersedes: [] },
  { pattern: /Catalyst Watch/i, edition: "catalyst_watch", supersedes: [] },
  { pattern: /Vital Weekend/i, edition: "weekend", supersedes: [] },
  { pattern: /Vital Dawn/i, edition: "dawn", supersedes: [] },
  { pattern: /Mid-Day Market Update/i, edition: "midday", supersedes: ["dawn"] },
  { pattern: /Vital Market Recap/i, edition: "recap", supersedes: ["midday", "dawn"] },
  { pattern: /Company-specific news.*\(BMO\)/i, edition: "bmo_news", supersedes: [] },
  { pattern: /Company-specific news.*\(AMC\)/i, edition: "amc_news", supersedes: [] },
];

const TMT_BREAKOUT_PATTERNS: EditionPattern[] = [
  { pattern: /Morning Wrap/i, edition: "morning_wrap", supersedes: [] },
  { pattern: /EOD Wrap/i, edition: "eod_wrap", supersedes: [] },
];

const PATTERN_TABLES: Record<string, { patterns: EditionPattern[]; fallback: EditionId }> = {
  "Vital Knowledge": { patterns: VITAL_KNOWLEDGE_PATTERNS, fallback: "one_off" },
  "TMT Breakout": { patterns: TMT_BREAKOUT_PATTERNS, fallback: "note" },
};

export function classifyEdition(sourceName: string, subject: string): EditionInfo {
  const table = PATTERN_TABLES[sourceName];
  if (!table) return { edition: "standalone", supersedes: [] };
  for (const { pattern, edition, supersedes } of table.patterns) {
    if (pattern.test(subject)) return { edition, supersedes };
  }
  return { edition: table.fallback, supersedes: [] };
}

/**
 * Bracketed tag appended to a source name in synthesis-prompt bucket lines,
 * e.g. " [recap]". Empty string for standalone sources; one-off VK notes and
 * TMTB notes get a human-readable tag.
 */
export function editionLabel(sourceName: string, subject: string): string {
  const { edition } = classifyEdition(sourceName, subject);
  if (edition === "standalone") return "";
  if (edition === "one_off" || edition === "note") return " [one-off note]";
  return ` [${edition}]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest/editions.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add lib/digest/editions.ts tests/digest/editions.test.ts
git commit -m "feat(digest): edition classifier + source-kind registry"
```

---

### Task 2: Late-arrival split + render block

**Files:**
- Create: `lib/digest/late-arrivals.ts`
- Test: `tests/digest/late-arrivals.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/digest/late-arrivals.test.ts
import { describe, it, expect } from "vitest";
import { splitLateArrivals, renderLateArrivalsBlock } from "@/lib/digest/late-arrivals";

const mk = (received_at: string, subject = "Subj") => ({
  received_at,
  subject,
  source_name: "TMT Breakout",
  summary: "Summary text.",
  source_url: null as string | null,
  website_url: null as string | null,
});

describe("splitLateArrivals", () => {
  // Previous send: 2026-06-09T12:45:00.000Z (8:45 ET). 60-min window → late
  // means received in (12:45, 13:45].
  const since = "2026-06-09T12:45:00.000Z";

  it("flags articles received within 60 min after the previous send", () => {
    const late = mk("2026-06-09T12:48:00.000Z");      // 3 min after → late
    const onTime = mk("2026-06-09T15:00:00.000Z");    // hours later → rest
    const { late: l, rest } = splitLateArrivals([late, onTime], since);
    expect(l).toEqual([late]);
    expect(rest).toEqual([onTime]);
  });

  it("handles SQLite space-separated UTC timestamps", () => {
    const late = mk("2026-06-09 12:50:00"); // SQLite datetime('now') format, UTC
    const { late: l } = splitLateArrivals([late], since);
    expect(l).toEqual([late]);
  });

  it("returns everything as rest when sinceIso is date-only (no send time known)", () => {
    const a = mk("2026-06-09T12:48:00.000Z");
    const { late: l, rest } = splitLateArrivals([a], "2026-06-08");
    expect(l).toEqual([]);
    expect(rest).toEqual([a]);
  });

  it("respects a custom window", () => {
    const a = mk("2026-06-09T14:30:00.000Z"); // 105 min after
    expect(splitLateArrivals([a], since).late).toEqual([]);
    expect(splitLateArrivals([a], since, 120).late).toEqual([a]);
  });
});

describe("renderLateArrivalsBlock", () => {
  it("renders heading, per-article line with ET arrival time, and trailing rule", () => {
    const block = renderLateArrivalsBlock(
      [mk("2026-06-09T12:48:00.000Z", "TMTB Morning Wrap")],
      "this morning's email",
    );
    expect(block).toContain("## ⏰ Late arrivals");
    expect(block).toContain("**TMT Breakout — TMTB Morning Wrap**");
    expect(block).toContain("8:48 AM ET, just after this morning's email");
    expect(block).toContain("Summary text.");
    expect(block.trimEnd().endsWith("---")).toBe(true);
  });

  it("returns empty string for no late articles", () => {
    expect(renderLateArrivalsBlock([], "this morning's email")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest/late-arrivals.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/digest/late-arrivals.ts
/**
 * late-arrivals.ts — pure helpers for the "just missed the previous email"
 * rescue block.
 *
 * An article is LATE when it was received within `windowMinutes` after the
 * previous email's send time (the composer's sinceDate, which is the
 * last_digest_sent_at ISO timestamp). Late articles lead the next email with
 * an explicit "arrived just after X" note instead of being buried mid-list —
 * this is what rescues TMTB's 8:48 Morning Wrap (vs. the 8:45 send) and a
 * 21:32 Friday EOD Wrap (vs. the 17:30 Friday send).
 *
 * When sinceDate is date-only (manual/cron fallback paths pass YYYY-MM-DD),
 * there is no known send TIME, so nothing is flagged late.
 */

export interface LateArticleLike {
  received_at: string;
  subject: string;
  source_name: string;
  summary: string | null;
  source_url: string | null;
  website_url: string | null;
}

/**
 * Parse either ISO ("2026-06-09T12:48:00.000Z") or SQLite UTC
 * ("2026-06-09 12:48:00") timestamps to epoch millis.
 */
function toUtcMs(ts: string): number {
  if (ts.includes("T")) return Date.parse(ts);
  return Date.parse(ts.replace(" ", "T") + "Z");
}

export function splitLateArrivals<T extends { received_at: string }>(
  articles: T[],
  sinceIso: string,
  windowMinutes = 60,
): { late: T[]; rest: T[] } {
  if (!sinceIso.includes("T")) return { late: [], rest: articles };
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return { late: [], rest: articles };
  const cutoffMs = sinceMs + windowMinutes * 60 * 1000;

  const late: T[] = [];
  const rest: T[] = [];
  for (const a of articles) {
    const ms = toUtcMs(a.received_at);
    if (!Number.isNaN(ms) && ms > sinceMs && ms <= cutoffMs) late.push(a);
    else rest.push(a);
  }
  return { late, rest };
}

/**
 * Markdown block for the top of the email. `previousSendLabel` is
 * "this morning's email" (evening) or "yesterday evening's email" (morning).
 * Returns "" when there is nothing late.
 */
export function renderLateArrivalsBlock(
  late: LateArticleLike[],
  previousSendLabel: string,
): string {
  if (late.length === 0) return "";

  const lines: string[] = ["## ⏰ Late arrivals", ""];
  for (const a of late) {
    const etTime = new Date(toUtcMs(a.received_at)).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    });
    const url = a.source_url || a.website_url;
    const head = url
      ? `**[${a.source_name} — ${a.subject}](${url})**`
      : `**${a.source_name} — ${a.subject}**`;
    lines.push(`${head} *(arrived ${etTime} ET, just after ${previousSendLabel})*`);
    lines.push("");
    if (a.summary) {
      lines.push(a.summary);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest/late-arrivals.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/digest/late-arrivals.ts tests/digest/late-arrivals.test.ts
git commit -m "feat(digest): late-arrival split + rescue block renderer"
```

---

### Task 3: Research Desk renderer + cross-file pointers

**Files:**
- Create: `lib/digest/research-desk.ts`
- Test: `tests/digest/research-desk.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/digest/research-desk.test.ts
import { describe, it, expect } from "vitest";
import {
  splitEssays,
  renderResearchDesk,
  insertCrossFilePointers,
} from "@/lib/digest/research-desk";

const essay = (over: Partial<Record<string, string | null>> = {}) => ({
  source_name: "MBI Deep Dives",
  subject: "NVDA's networking moat",
  summary: "Long-form argument about NVLink.",
  mentioned_symbols: '["NVDA"]',
  key_themes: '["networking","moats"]',
  source_url: "https://example.com/nvda",
  website_url: null,
  ...over,
});

describe("splitEssays", () => {
  it("routes by SOURCE_KINDS with unknown→essay default", () => {
    const articles = [
      { source_name: "Vital Knowledge" },
      { source_name: "MBI Deep Dives" },
      { source_name: "Brand New Source" },
    ];
    const { essays, commentary } = splitEssays(articles);
    expect(commentary.map((a) => a.source_name)).toEqual(["Vital Knowledge"]);
    expect(essays.map((a) => a.source_name)).toEqual(["MBI Deep Dives", "Brand New Source"]);
  });
});

describe("renderResearchDesk", () => {
  it("renders one entry per essay with link, summary, themes", () => {
    const md = renderResearchDesk([essay()]);
    expect(md).toContain("## Research Desk");
    expect(md).toContain("**MBI Deep Dives** — [NVDA's networking moat](https://example.com/nvda)");
    expect(md).toContain("Long-form argument about NVLink.");
    expect(md).toContain("*networking · moats*");
  });
  it("returns empty string for no essays", () => {
    expect(renderResearchDesk([])).toBe("");
  });
});

describe("insertCrossFilePointers", () => {
  const ai = [
    "## Overnight & Setup",
    "Macro text.",
    "## NVDA (NVIDIA Corp)",
    "Coverage text.",
    "## Also covered",
    "Tail.",
  ].join("\n");

  it("inserts a pointer line under the matching held-symbol section", () => {
    const out = insertCrossFilePointers(ai, [essay()], ["NVDA"]);
    const lines = out.split("\n");
    const i = lines.indexOf("## NVDA (NVIDIA Corp)");
    expect(lines[i + 1]).toBe(
      '📄 *Deep dive today: **MBI Deep Dives** — "NVDA\'s networking moat" (see Research Desk below)*',
    );
  });

  it("matches across issuer families (GOOGL essay → GOOG section)", () => {
    const md = "## GOOG (Alphabet)\nText.";
    const out = insertCrossFilePointers(
      md,
      [essay({ mentioned_symbols: '["GOOGL"]', subject: "Alphabet piece" })],
      ["GOOG"],
    );
    expect(out).toContain("Deep dive today");
  });

  it("no-ops when the essay's symbol is not held/watchlisted or has no section", () => {
    expect(insertCrossFilePointers(ai, [essay({ mentioned_symbols: '["XYZ"]' })], ["NVDA"])).toBe(ai);
    expect(insertCrossFilePointers(ai, [essay({ mentioned_symbols: '["AMD"]' })], ["AMD"])).toBe(ai);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest/research-desk.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// lib/digest/research-desk.ts
/**
 * research-desk.ts — pure helpers for the essay half of the digest.
 *
 * Essays (Stratechery, The Diff, MBI, …) are timeless and near-zero-overlap;
 * they are NEVER merged or synthesized. Each gets its own Research Desk entry
 * rendered in code from the per-article ingest summary. When an essay covers a
 * held/watchlist name that has its own section in the AI synthesis output, a
 * deterministic pointer line is inserted under that section header
 * (post-processing — never a prompt instruction, which would be flaky).
 */

import { sourceKind } from "@/lib/digest/editions";
import { issuerSiblings } from "@/lib/securities/issuer-family";

export interface EssayLike {
  source_name: string;
  subject: string;
  summary: string | null;
  mentioned_symbols: string | null;
  key_themes: string | null;
  source_url: string | null;
  website_url: string | null;
}

export function splitEssays<T extends { source_name: string }>(
  articles: T[],
): { essays: T[]; commentary: T[] } {
  const essays: T[] = [];
  const commentary: T[] = [];
  for (const a of articles) {
    (sourceKind(a.source_name) === "essay" ? essays : commentary).push(a);
  }
  return { essays, commentary };
}

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** "## Research Desk" markdown section; "" when there are no essays. */
export function renderResearchDesk(essays: EssayLike[]): string {
  if (essays.length === 0) return "";
  const lines: string[] = ["## Research Desk", ""];
  for (const e of essays) {
    const url = e.source_url || e.website_url;
    lines.push(
      url
        ? `**${e.source_name}** — [${e.subject}](${url})`
        : `**${e.source_name}** — ${e.subject}`,
    );
    lines.push("");
    if (e.summary) {
      lines.push(e.summary);
      lines.push("");
    }
    const themes = parseJsonArray(e.key_themes);
    if (themes.length > 0) {
      lines.push(`*${themes.join(" · ")}*`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

/**
 * For each essay covering a held/watchlist symbol, insert a pointer line
 * directly under the matching `## SYM …` section header in the AI output.
 * Symbol matching expands issuer families on BOTH sides (a GOOGL essay
 * cross-files into a GOOG section). At most one pointer per (essay, section).
 */
export function insertCrossFilePointers(
  aiMarkdown: string,
  essays: EssayLike[],
  heldAndWatchlist: string[],
): string {
  if (essays.length === 0 || heldAndWatchlist.length === 0) return aiMarkdown;

  const relevant = new Set(
    heldAndWatchlist.flatMap((s) => issuerSiblings(s)).map((s) => s.toUpperCase()),
  );

  let lines = aiMarkdown.split("\n");
  for (const essay of essays) {
    const symbols = parseJsonArray(essay.mentioned_symbols)
      .map((s) => s.toUpperCase())
      .filter((s) => relevant.has(s));
    if (symbols.length === 0) continue;

    // All family variants this essay could file under.
    const fileUnder = new Set(symbols.flatMap((s) => issuerSiblings(s)).map((s) => s.toUpperCase()));

    const idx = lines.findIndex((line) => {
      const m = line.match(/^##\s+([A-Z][A-Z0-9.\-]*)\b/);
      return m !== null && fileUnder.has(m[1].toUpperCase());
    });
    if (idx === -1) continue;

    const pointer = `📄 *Deep dive today: **${essay.source_name}** — "${essay.subject}" (see Research Desk below)*`;
    lines = [...lines.slice(0, idx + 1), pointer, ...lines.slice(idx + 1)];
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest/research-desk.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/digest/research-desk.ts tests/digest/research-desk.test.ts
git commit -m "feat(digest): Research Desk renderer + deterministic cross-file pointers"
```

---

### Task 4: Synthesis prompt — edition labels + output section contract

**Files:**
- Modify: `lib/digest/synthesize.ts`
- Test: `tests/digest/synthesize.test.ts` (extend)

- [ ] **Step 1: Read the existing test file**

Run: `cat tests/digest/synthesize.test.ts` — note how `generateText` / `getModelForFeature` are mocked and how the three existing prompt blocks are pinned. New pins follow the same mechanism (capture the `system` and `prompt` args from the mocked `generateText`).

- [ ] **Step 2: Add failing pins to `tests/digest/synthesize.test.ts`**

Add (adapting the mock-capture helper already present in that file):

```typescript
describe("edition-aware prompt (digest redesign)", () => {
  it("system prompt pins EDITION COLLAPSING and OUTPUT SECTION ORDER blocks", async () => {
    const { system } = await captureSynthesisCall(); // existing helper pattern in this file
    expect(system).toContain("EDITION COLLAPSING (HARD):");
    expect(system).toContain("Tell each session's story ONCE");
    expect(system).toContain("OUTPUT SECTION ORDER (HARD):");
    expect(system).toContain("## Also covered");
    expect(system).toContain("header MUST begin with the ticker symbol");
  });

  it("session heading flows into the system prompt", async () => {
    const { system } = await captureSynthesisCall({ sessionHeading: "Overnight & Setup" });
    expect(system).toContain("## Overnight & Setup");
  });

  it("bucket lines carry edition tags", async () => {
    const { prompt } = await captureSynthesisCall({
      buckets: [{
        symbol: "(no symbol)",
        companyName: null,
        articles: [{
          id: 1,
          source_name: "Vital Knowledge",
          subject: "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026",
          summary: "Recap summary.",
          sentiment: "neutral",
          mentioned_symbols: null,
          portfolio_relevance: null,
          key_themes: null,
          source_url: null,
          website_url: null,
        }],
      }],
    });
    expect(prompt).toContain("Vital Knowledge [recap]");
  });
});
```

If `captureSynthesisCall` does not exist in the file, add it once at the top alongside the existing mocks:

```typescript
async function captureSynthesisCall(over: Partial<SynthesisInput> = {}) {
  let captured: { system: string; prompt: string } = { system: "", prompt: "" };
  vi.mocked(generateText).mockImplementationOnce(async (args: unknown) => {
    const a = args as { system: string; prompt: string };
    captured = { system: a.system, prompt: a.prompt };
    return { text: "## Heading\n" + "x".repeat(300), finishReason: "stop" } as never;
  });
  await synthesize({
    buckets: [], heldSymbols: [], watchlist: [], anomalies: [],
    ...over,
  });
  return captured;
}
```

- [ ] **Step 3: Run to verify the new pins fail**

Run: `npx vitest run tests/digest/synthesize.test.ts`
Expected: new tests FAIL (blocks absent); existing tests still PASS

- [ ] **Step 4: Implement in `lib/digest/synthesize.ts`**

(a) Add import:

```typescript
import { editionLabel } from "@/lib/digest/editions";
```

(b) Extend `SynthesisInput`:

```typescript
export interface SynthesisInput {
  buckets: CompanyBucket[];
  heldSymbols: string[];
  watchlist: string[];
  anomalies: { symbol: string; companyName: string | null }[];
  /**
   * Heading for the lead macro/market section: "The Session" (evening) or
   * "Overnight & Setup" (morning). Defaults to "The Session".
   */
  sessionHeading?: string;
}
```

(c) In `renderBucket`, change the article line to include the edition tag:

```typescript
    lines.push(
      `- ${article.source_name}${editionLabel(article.source_name, article.subject)} (${sentiment})${urlPart}: ${summaryText}`,
    );
```

(d) Convert the const system prompt into a builder. Rename `SYNTHESIS_SYSTEM_PROMPT` to a function and append two new HARD blocks after the existing three (all existing text stays byte-identical):

```typescript
function buildSystemPrompt(sessionHeading: string): string {
  return `${SYNTHESIS_SYSTEM_PROMPT_BASE}

EDITION COLLAPSING (HARD):
- Some bucket lines carry an edition tag like [dawn], [midday], [recap], [morning_wrap], [eod_wrap], [one-off note]. Tagged articles are installments of ONE publication's daily cycle: dawn → midday → recap narrate the SAME trading session as it develops, and later editions supersede earlier ones.
- Tell each session's story ONCE, chronologically. Treat the latest edition as the authoritative account; pull from earlier editions only what the later ones dropped. Never present two editions of the same publication as independent sources agreeing with each other — they are the same desk.
- An intraday reversal (up at midday, down by the close) is one narrative beat ("reversed in the afternoon as …"), not two contradictory reports.

OUTPUT SECTION ORDER (HARD):
- First section: \`## ${sessionHeading}\` — the macro / market-wide narrative drawn from the Macro bucket and the session-arc commentary.
- Then one section per company with meaningful coverage. The header MUST begin with the ticker symbol exactly as given in the bucket heading — \`## NVDA (NVIDIA Corp)\` — because deterministic post-processing matches on the leading ticker.
- Last section: \`## Also covered\`.`;
}
```

where `SYNTHESIS_SYSTEM_PROMPT_BASE` is the existing `SYNTHESIS_SYSTEM_PROMPT` string renamed (content unchanged — the three pinned blocks must keep passing).

(e) In `synthesize()`:

```typescript
  const sessionHeading = input.sessionHeading ?? "The Session";
  const result = await generateText({
    model,
    system: buildSystemPrompt(sessionHeading),
    prompt,
    maxOutputTokens: 4096,
  });
```

- [ ] **Step 5: Run to verify all pass**

Run: `npx vitest run tests/digest/synthesize.test.ts`
Expected: PASS (old pins + new pins)

- [ ] **Step 6: Commit**

```bash
git add lib/digest/synthesize.ts tests/digest/synthesize.test.ts
git commit -m "feat(digest): edition tags + session-first output contract in synthesis prompt"
```

---

### Task 5: Structured composer in `generateDigestSinceAdaptive` + edition param threading

**Files:**
- Modify: `lib/digest/daily-digest.ts` (the adaptive function, ~lines 366-477)
- Modify: `lib/digest/send-digest.ts:123-124` and `lib/digest/send-evening.ts:107`
- Test: Create `tests/digest/structured-composer.test.ts`; update `tests/digest/adaptive-layout.test.ts`

- [ ] **Step 1: Write the failing composer test**

```typescript
// tests/digest/structured-composer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/digest/synthesize", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/digest/synthesize")>();
  return {
    ...mod,
    synthesize: vi.fn(async (input: { sessionHeading?: string }) =>
      [
        `## ${input.sessionHeading ?? "The Session"}`,
        "Macro narrative.",
        "## NVDA (NVIDIA Corp)",
        "NVDA coverage.",
        "## Also covered",
        "Tail.",
      ].join("\n"),
    ),
  };
});
vi.mock("@/lib/digest/anomalies", () => ({
  computeAnomalies: vi.fn(() => []),
  formatVanguardAnomaliesBlock: vi.fn(() => ""),
}));

import { generateDigestSinceAdaptive } from "@/lib/digest/daily-digest";
import { synthesize } from "@/lib/digest/synthesize";

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (id INTEGER PRIMARY KEY, name TEXT, website_url TEXT);
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY, source_id INTEGER, gmail_message_id TEXT,
      received_at TEXT, subject TEXT, sender TEXT, summary TEXT, key_themes TEXT,
      sentiment TEXT, sentiment_score REAL, mentioned_symbols TEXT,
      portfolio_relevance TEXT, processed_at TEXT, created_at TEXT,
      source_url TEXT, is_relevant INTEGER DEFAULT 1
    );
    CREATE TABLE level_alerts (id INTEGER PRIMARY KEY, level_id INTEGER, security_id INTEGER,
      triggered_at TEXT, triggered_price REAL, user_response TEXT, suggested_action TEXT);
    CREATE TABLE security_levels (id INTEGER PRIMARY KEY, level_type TEXT, price REAL,
      price_source TEXT, source_author TEXT);
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT, name TEXT, security_type TEXT);
    CREATE TABLE holdings (id INTEGER PRIMARY KEY, security_id INTEGER, quantity REAL);
    CREATE TABLE watchlist (id INTEGER PRIMARY KEY, security_id INTEGER, is_active INTEGER);
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1,'Vital Knowledge'),(2,'MBI Deep Dives'),(3,'TMT Breakout')`).run();
  return db;
}

let seq = 0;
function insertArticle(db: Database.Database, sourceId: number, subject: string, receivedAt: string, symbols = '["NVDA"]') {
  seq += 1;
  db.prepare(
    `INSERT INTO research_articles (source_id, gmail_message_id, received_at, subject, summary,
       mentioned_symbols, sentiment, processed_at, created_at, is_relevant)
     VALUES (?, ?, ?, ?, 'Summary.', ?, 'neutral', datetime('now'), datetime('now'), 1)`,
  ).run(sourceId, `m${seq}`, receivedAt, subject, symbols);
}

const SINCE = "2026-06-09T12:45:00.000Z";

function insertFiveCommentary(db: Database.Database) {
  insertArticle(db, 1, "Vital Knowledge: Vital Dawn for Tuesday June 9, 2026", "2026-06-09 14:00:00");
  insertArticle(db, 1, "Vital Knowledge: Vital Mid-Day Market Update for Tuesday June 9, 2026", "2026-06-09 15:00:00");
  insertArticle(db, 1, "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026", "2026-06-09 20:04:00");
  insertArticle(db, 3, "TMTB EOD Wrap", "2026-06-09 21:30:00");
  insertArticle(db, 1, "Vital Knowledge: Iran & tech: thoughts", "2026-06-09 17:30:00");
}

describe("generateDigestSinceAdaptive — structured composer", () => {
  beforeEach(() => {
    vi.mocked(synthesize).mockClear();
  });

  it("evening edition: title, section order, Research Desk after AI body", async () => {
    const db = setupDb();
    insertFiveCommentary(db);
    insertArticle(db, 2, "NVDA's networking moat", "2026-06-09 16:00:00"); // essay

    const md = await generateDigestSinceAdaptive(db, SINCE, { includeAnomalies: true, edition: "evening" });
    expect(md).not.toBeNull();
    expect(md!).toContain("# Evening Recap");
    expect(md!).toContain("## The Session");
    expect(md!).toContain("## Research Desk");
    expect(md!.indexOf("## The Session")).toBeLessThan(md!.indexOf("## Research Desk"));
    // essay cross-filed into the NVDA section
    expect(md!).toContain("Deep dive today");
    // essays excluded from the synthesis input
    const input = vi.mocked(synthesize).mock.calls[0][0];
    const bucketSources = input.buckets.flatMap((b) => b.articles.map((a) => a.source_name));
    expect(bucketSources).not.toContain("MBI Deep Dives");
  });

  it("morning edition: title + Overnight & Setup heading passed to synthesize", async () => {
    const db = setupDb();
    insertFiveCommentary(db);
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "morning" });
    expect(md!).toContain("# Morning Research Digest");
    expect(vi.mocked(synthesize).mock.calls[0][0].sessionHeading).toBe("Overnight & Setup");
  });

  it("late arrivals lead the email and are excluded from synthesis", async () => {
    const db = setupDb();
    insertFiveCommentary(db);
    insertArticle(db, 3, "TMTB Morning Wrap", "2026-06-09 12:48:00"); // 3 min after send → late
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "evening" });
    expect(md!).toContain("## ⏰ Late arrivals");
    expect(md!.indexOf("## ⏰ Late arrivals")).toBeLessThan(md!.indexOf("## The Session"));
    const input = vi.mocked(synthesize).mock.calls[0][0];
    const subjects = input.buckets.flatMap((b) => b.articles.map((a) => a.subject));
    expect(subjects).not.toContain("TMTB Morning Wrap");
  });

  it("<5 commentary articles → per-source fallback for commentary, Research Desk still renders", async () => {
    const db = setupDb();
    insertArticle(db, 1, "Vital Knowledge: Vital Dawn for Tuesday June 9, 2026", "2026-06-09 14:00:00");
    insertArticle(db, 2, "NVDA's networking moat", "2026-06-09 16:00:00");
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "morning" });
    expect(vi.mocked(synthesize)).not.toHaveBeenCalled();
    expect(md!).toContain("## VITAL KNOWLEDGE"); // per-source fallback header
    expect(md!).toContain("## Research Desk");
  });

  it("essay-only window still produces an email (no synthesis)", async () => {
    const db = setupDb();
    insertArticle(db, 2, "NVDA's networking moat", "2026-06-09 16:00:00");
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "evening" });
    expect(vi.mocked(synthesize)).not.toHaveBeenCalled();
    expect(md!).toContain("## Research Desk");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/digest/structured-composer.test.ts`
Expected: FAIL (no `edition` opt, old titles, no Research Desk)

- [ ] **Step 3: Rewrite the adaptive composer**

In `lib/digest/daily-digest.ts`, add imports:

```typescript
import { splitLateArrivals, renderLateArrivalsBlock } from "@/lib/digest/late-arrivals";
import { splitEssays, renderResearchDesk, insertCrossFilePointers } from "@/lib/digest/research-desk";
```

Replace `generateDigestSinceAdaptive` (keep `recordSynthesisFallback`, `getHeldSymbols`, `getWatchlistSymbols`, `enrichBucketCompanyNames`, `renderPerSourceBody` as-is):

```typescript
export async function generateDigestSinceAdaptive(
  db: Database.Database,
  sinceDate: string,
  opts: { includeAnomalies?: boolean; edition?: "morning" | "evening" } = {},
): Promise<string | null> {
  const edition = opts.edition ?? "morning";

  const articles = getRecentArticles(db, {
    startDate: sinceDate,
    processedOnly: true,
    relevantOnly: true,
    limit: 40, // raised from 30 — edition collapsing keeps synthesis input flat; covers heavy Mondays
  });

  const alertsBlock = formatTriggeredAlertsSection(db, sinceDate);

  // Return null only when there is genuinely nothing to say
  if (articles.length === 0 && !alertsBlock) return null;

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const countLine =
    articles.length === 0
      ? "No new research articles, but price levels fired — see below."
      : `${articles.length} article${articles.length === 1 ? "" : "s"} from ${countSources(articles)} source${countSources(articles) === 1 ? "" : "s"}`;

  const title = edition === "evening" ? "# Evening Recap" : "# Morning Research Digest";
  const lines: string[] = [title, `### ${dateStr}`, "", countLine, "", "---", ""];

  // ── 1. Late arrivals — articles that just missed the PREVIOUS email ──────
  // Only meaningful when sinceDate is a full ISO send timestamp (the marker);
  // date-only windows (manual/sinceDate modes) have no known send time.
  const { late, rest: working } = splitLateArrivals(articles, sinceDate);
  if (late.length > 0) {
    lines.push(
      renderLateArrivalsBlock(
        late,
        edition === "evening" ? "this morning's email" : "yesterday evening's email",
      ),
    );
  }

  // ── 2. Alerts ─────────────────────────────────────────────────────────────
  if (alertsBlock) {
    lines.push(alertsBlock);
  }

  // ── 3. Anomalies (evening only) ───────────────────────────────────────────
  if (opts.includeAnomalies) {
    const anomalyBlock = formatVanguardAnomaliesBlock(db);
    if (anomalyBlock) {
      lines.push(anomalyBlock);
      lines.push("---");
      lines.push("");
    }
  }

  // ── 4. Split essays out of the synthesis stream ───────────────────────────
  const { essays, commentary } = splitEssays(working);

  // ── 5. Commentary body — synthesized when there's enough to synthesize ────
  if (commentary.length >= SYNTHESIS_MIN_ARTICLES) {
    const heldSymbols = getHeldSymbols(db);
    const watchlist = getWatchlistSymbols(db);
    const anomalyFlags = opts.includeAnomalies ? computeAnomalies(db) : [];
    const anomalies = anomalyFlags.map((a) => ({
      symbol: a.symbol,
      companyName: a.companyName,
    }));

    const rawBuckets = bucketByCompany(commentary);
    const buckets = enrichBucketCompanyNames(db, rawBuckets);

    try {
      let synth = await synthesize({
        buckets,
        heldSymbols,
        watchlist,
        anomalies,
        sessionHeading: edition === "evening" ? "The Session" : "Overnight & Setup",
      });
      synth = insertCrossFilePointers(synth, essays, [...heldSymbols, ...watchlist]);
      lines.push(synth);
      lines.push("");
      lines.push("---");
      lines.push("");

      // Concise per-source tail: commentary only — essays are linked in Research Desk
      lines.push("**Sources**");
      lines.push("");
      for (const article of commentary) {
        const url = article.source_url || article.website_url;
        if (url) {
          lines.push(`- **${article.source_name}**: [${article.subject}](${url})`);
        } else {
          lines.push(`- **${article.source_name}**: ${article.subject}`);
        }
      }
      lines.push("");
    } catch (err) {
      if (err instanceof SynthesisEmptyError) {
        console.warn(`[digest] synthesis fell back to per-source: ${(err as Error).message}`);
        recordSynthesisFallback(db, (err as Error).message, commentary.length);
      } else {
        console.warn(`[digest] synthesis error (network/rate-limit), fell back to per-source: ${(err as Error).message}`);
        recordSynthesisFallback(db, `generic: ${(err as Error).message}`, commentary.length);
      }
      lines.push(...renderPerSourceBody(commentary));
    }
  } else if (commentary.length > 0) {
    // < SYNTHESIS_MIN_ARTICLES — per-source layout for the commentary stream
    lines.push(...renderPerSourceBody(commentary));
  }

  // ── 6. Research Desk — one entry per essay, rendered in code ──────────────
  const desk = renderResearchDesk(essays);
  if (desk) {
    lines.push(desk);
  }

  return lines.join("\n").trim();
}
```

- [ ] **Step 4: Thread the edition param through the senders**

`lib/digest/send-digest.ts` lines 123-124 — add `edition: "morning"` to both calls:

```typescript
    ? await generateDigestSinceAdaptive(db, sinceSnapshot, { includeAnomalies: false, edition: "morning" })
    : await generateDigestSinceAdaptive(db, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10), { includeAnomalies: false, edition: "morning" });
```

`lib/digest/send-evening.ts` line 107:

```typescript
  const digest = await generateDigestSinceAdaptive(db, sinceSnapshot, {
    includeAnomalies: true,
    edition: "evening",
  });
```

- [ ] **Step 5: Run new + adjacent tests; update title pins in `adaptive-layout.test.ts`**

Run: `npx vitest run tests/digest/structured-composer.test.ts tests/digest/adaptive-layout.test.ts tests/digest/send-evening.test.ts tests/digest/send-digest-race.test.ts tests/digest/daily-digest.test.ts`

`adaptive-layout.test.ts` will fail on assertions that expect the old generic `# Research Digest` title or the old section flow. Update those assertions to the new contract: default (no `edition` opt) renders `# Morning Research Digest`; synthesized body comes from the mocked synthesize; per-source fallback unchanged for commentary. Do not weaken assertions — retarget them.
Expected after updates: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add lib/digest/daily-digest.ts lib/digest/send-digest.ts lib/digest/send-evening.ts tests/digest/structured-composer.test.ts tests/digest/adaptive-layout.test.ts
git commit -m "feat(digest): structured composer — late arrivals, session narrative, Research Desk"
```

---

### Task 6: Stale-marker fix — cloud sentAt → advance `last_digest_sent_at` on skip

**Files:**
- Modify: `workers/cron/src/dedup.ts` (`getMarkerStatus`)
- Modify: `lib/cron/marker-check.ts` (`MarkerCheckResult`)
- Modify: `app/api/cron/digest/route.ts`, `app/api/cron/evening/route.ts`
- Test: extend `workers/cron/test/dedup.test.ts`; create `tests/api/cron-marker-advance.test.ts`

- [ ] **Step 1: Worker — failing test for `sentAt`**

Add to `workers/cron/test/dedup.test.ts` (match the file's existing KV-mock idiom — it already tests `getMarkerStatus`):

```typescript
it("getMarkerStatus returns the marker's ISO value as sentAt", async () => {
  const kv = makeKv(); // existing helper in this file
  await writeMarker(kv, "cloud", "evening", "2026-06-09");
  const status = await getMarkerStatus(kv, "evening", "2026-06-09");
  expect(status.sentBy).toBe("cloud");
  expect(status.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

it("getMarkerStatus returns sentAt null for non-ISO marker values", async () => {
  const kv = makeKv();
  await kv.put("cloud-sent-evening-2026-06-09", "1");
  const status = await getMarkerStatus(kv, "evening", "2026-06-09");
  expect(status.sentBy).toBe("cloud");
  expect(status.sentAt).toBeNull();
});
```

Run: `cd workers/cron && npx vitest run test/dedup.test.ts` → new tests FAIL (no `sentAt`).

- [ ] **Step 2: Worker — implement**

Replace `getMarkerStatus` in `workers/cron/src/dedup.ts`:

```typescript
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

/** Used by the /internal/marker endpoint the Mac polls. */
export async function getMarkerStatus(
  kv: KVNamespace,
  type: JobType,
  date: string = todayET()
): Promise<{ sentBy: SentBy | null; date: string; sentAt: string | null }> {
  // Read VALUES (not just existence): writeMarker / setAttemptingMarker have
  // always stored new Date().toISOString(), which is exactly the send/start
  // timestamp the Mac needs to advance its local last_digest_sent_at when it
  // skips with "cloud already sent" (stale-window fix, 2026-06-09).
  const [mac, cloud, attempting] = await Promise.all([
    kv.get(markerKey("mac", type, date)),
    kv.get(markerKey("cloud", type, date)),
    kv.get(attemptingKey(type, date)),
  ]);
  const iso = (v: string | null): string | null => (v !== null && ISO_RE.test(v) ? v : null);

  // cloud wins ties — if both markers are set, the cloud-sent email definitely
  // went out (Mac marker may have been written after cloud delivery by a race).
  if (cloud !== null) return { sentBy: "cloud", date, sentAt: iso(cloud) };
  // cloud-attempting means a fallback is mid-flight RIGHT NOW. Its timestamp is
  // BEFORE the fallback's Gmail fetch, so it is a safe (conservative) sentAt.
  if (attempting !== null) return { sentBy: "cloud", date, sentAt: iso(attempting) };
  if (mac !== null) return { sentBy: "mac", date, sentAt: iso(mac) };
  return { sentBy: null, date, sentAt: null };
}
```

Run: `cd workers/cron && npx vitest run test/dedup.test.ts` → PASS. (The `/internal/marker` endpoint in `index.ts` returns this object verbatim — no change needed there.)

- [ ] **Step 3: Mac — extend `MarkerCheckResult`**

In `lib/cron/marker-check.ts`:

```typescript
export interface MarkerCheckResult {
  sentBy: MarkerSentBy;
  date: string;
  /** ISO timestamp of the cloud send/attempt start; null for legacy markers. */
  sentAt?: string | null;
}
```

(No logic change — `res.json()` already passes it through.)

- [ ] **Step 4: Mac routes — failing test**

```typescript
// tests/api/cron-marker-advance.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

const testDb = new Database(":memory:");
testDb.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)`);

vi.mock("@/lib/db", () => ({ db: testDb }));
vi.mock("@/lib/cron/marker-check", () => ({ checkCloudMarker: vi.fn() }));
vi.mock("@/lib/cron/running-marker", () => ({
  setRunningMarker: vi.fn(async () => {}),
  clearRunningMarker: vi.fn(async () => {}),
  confirmMacSent: vi.fn(async () => {}),
}));
vi.mock("@/lib/digest/send-digest", () => ({
  sendDigestEmail: vi.fn(),
  DigestSendError: class extends Error { status = 500; },
}));
vi.mock("@/lib/digest/send-evening", () => ({
  sendEveningEmail: vi.fn(),
  EveningSendError: class extends Error { status = 500; },
}));
vi.mock("@/lib/calendar/market-holidays", () => ({
  isMarketHoliday: vi.fn(() => false),
  isMarketClosed: vi.fn(() => false),
}));

import { checkCloudMarker } from "@/lib/cron/marker-check";
import { getLastDigestSentAt, setLastDigestSentAt } from "@/lib/digest/daily-digest";
import { POST as digestPost } from "@/app/api/cron/digest/route";
import { POST as eveningPost } from "@/app/api/cron/evening/route";

const SECRET = "test-secret";
process.env.CRON_SHARED_SECRET = SECRET;

function req() {
  return new Request("http://localhost/api/cron/x", {
    method: "POST",
    headers: { "x-cron-secret": SECRET, "content-type": "application/json" },
    body: "{}",
  });
}

describe.each([
  ["digest", digestPost],
  ["evening", eveningPost],
])("cloud-skip advances last_digest_sent_at (%s)", (_name, post) => {
  beforeEach(() => {
    testDb.prepare(`DELETE FROM settings`).run();
    vi.mocked(checkCloudMarker).mockReset();
  });

  it("advances to the cloud sentAt", async () => {
    setLastDigestSentAt(testDb, "2026-06-04T12:45:00.000Z");
    vi.mocked(checkCloudMarker).mockResolvedValue({
      sentBy: "cloud", date: "2026-06-09", sentAt: "2026-06-09T13:01:00.000Z",
    });
    const res = await post(req());
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(getLastDigestSentAt(testDb)).toBe("2026-06-09T13:01:00.000Z");
  });

  it("falls back to now−30min when sentAt is missing (legacy marker)", async () => {
    vi.mocked(checkCloudMarker).mockResolvedValue({ sentBy: "cloud", date: "2026-06-09" });
    const before = Date.now();
    await post(req());
    const advanced = Date.parse(getLastDigestSentAt(testDb)!);
    expect(advanced).toBeGreaterThan(before - 31 * 60 * 1000);
    expect(advanced).toBeLessThan(before - 29 * 60 * 1000 + 5000);
  });

  it("never moves the marker backwards", async () => {
    setLastDigestSentAt(testDb, "2026-06-09T18:00:00.000Z");
    vi.mocked(checkCloudMarker).mockResolvedValue({
      sentBy: "cloud", date: "2026-06-09", sentAt: "2026-06-09T13:01:00.000Z",
    });
    await post(req());
    expect(getLastDigestSentAt(testDb)).toBe("2026-06-09T18:00:00.000Z");
  });
});
```

Run: `npx vitest run tests/api/cron-marker-advance.test.ts` → FAIL (marker not advanced).

- [ ] **Step 5: Mac routes — implement**

Add a tiny shared helper in `lib/cron/marker-check.ts`:

```typescript
import type Database from "better-sqlite3";
import { getLastDigestSentAt, setLastDigestSentAt } from "@/lib/digest/daily-digest";

/**
 * Stale-window fix (2026-06-09): when the Mac skips because the cloud already
 * sent, advance the shared last_digest_sent_at pointer so the NEXT Mac-won
 * email doesn't re-cover days the cloud already summarized. Forward-only —
 * never regress the pointer. Legacy markers without sentAt fall back to
 * now−30min (slight overlap beats dropped articles).
 */
export function advanceDigestMarkerAfterCloudSend(
  db: Database.Database,
  sentAt: string | null | undefined,
): void {
  const target = sentAt ?? new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const current = getLastDigestSentAt(db);
  if (!current || Date.parse(target) > Date.parse(current)) {
    setLastDigestSentAt(db, target);
  }
}
```

In `app/api/cron/digest/route.ts`, extend the skip branch (lines 51-59):

```typescript
  const marker = await checkCloudMarker("digest");
  if (marker?.sentBy === "cloud") {
    advanceDigestMarkerAfterCloudSend(db, marker.sentAt);
    return Response.json({
      success: true,
      skipped: true,
      reason: "cloud already sent",
      date: marker.date,
    });
  }
```

with the import added: `import { checkCloudMarker, advanceDigestMarkerAfterCloudSend } from "@/lib/cron/marker-check";`

Mirror the same two-line change in `app/api/cron/evening/route.ts`'s `already_sent_by_cloud` branch.

- [ ] **Step 6: Run both test suites**

Run: `npx vitest run tests/api/cron-marker-advance.test.ts tests/api/cron-evening.test.ts && cd workers/cron && npx vitest run test/dedup.test.ts`
Expected: PASS (if `tests/api/cron-evening.test.ts` asserts the skip-path response shape, it still passes — the response body is unchanged)

- [ ] **Step 7: Commit**

```bash
git add workers/cron/src/dedup.ts workers/cron/test/dedup.test.ts lib/cron/marker-check.ts app/api/cron/digest/route.ts app/api/cron/evening/route.ts tests/api/cron-marker-advance.test.ts
git commit -m "fix(cron): advance last_digest_sent_at when cloud already sent (stale-window fix)"
```

---

### Task 7: Worker editions mirror + parity test

**Files:**
- Create: `workers/cron/src/editions.ts`
- Test: `workers/cron/test/editions.test.ts`

- [ ] **Step 1: Copy the file**

```bash
cp lib/digest/editions.ts workers/cron/src/editions.ts
```

The file has zero imports, so the copy is valid Worker code as-is. Edit ONLY the header comment's first line to read `editions.ts — Worker mirror of lib/digest/editions.ts (byte-parity below the header)`.

- [ ] **Step 2: Write the parity test**

```typescript
// workers/cron/test/editions.test.ts
import { describe, it, expect } from "vitest";
import * as worker from "../src/editions";
import * as mac from "../../../lib/digest/editions";

describe("editions parity (Worker mirror of lib/digest/editions.ts)", () => {
  it("SOURCE_KINDS tables are identical", () => {
    expect(worker.SOURCE_KINDS).toEqual(mac.SOURCE_KINDS);
  });

  it("classifyEdition agrees on a representative subject set", () => {
    const cases: Array<[string, string]> = [
      ["Vital Knowledge", "Vital Knowledge: Vital Dawn for Tuesday June 9, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Vital Mid-Day Market Update for Tuesday June 9, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Vital Talking Points – Recap for the Week ended Friday June 5, 2026"],
      ["Vital Knowledge", "Vital Knowledge: Company-specific news for Tues 6/9 (BMO) - DBI"],
      ["Vital Knowledge", "Vital Knowledge: Company-specific news for Mon 6/8 (AMC) - APLD"],
      ["Vital Knowledge", "Vital Knowledge: Iran & tech: thoughts"],
      ["TMT Breakout", "TMTB Morning Wrap"],
      ["TMT Breakout", "TMTB EOD Wrap; CRDO HPE First Takes"],
      ["TMT Breakout", "TMTB: Conference Key Quotes"],
      ["Stratechery Updates", "An Interview"],
    ];
    for (const [src, subj] of cases) {
      expect(worker.classifyEdition(src, subj)).toEqual(mac.classifyEdition(src, subj));
      expect(worker.editionLabel(src, subj)).toBe(mac.editionLabel(src, subj));
    }
  });
});
```

- [ ] **Step 3: Run**

Run: `cd workers/cron && npx vitest run test/editions.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add workers/cron/src/editions.ts workers/cron/test/editions.test.ts
git commit -m "feat(worker): editions mirror + parity test"
```

---

### Task 8: Worker fallback structure mirror

**Files:**
- Modify: `workers/cron/src/fallback-digest.ts` (`composeDigestMarkdown`, ~lines 304-373)
- Modify: `workers/cron/src/fallback-evening.ts` (`buildSynthesisPrompt`, lines 337-374)
- Test: extend `workers/cron/test/fallback-digest.test.ts`, `workers/cron/test/fallback-evening.test.ts`

- [ ] **Step 1: Failing tests**

`workers/cron/test/fallback-digest.test.ts` — add (using the file's existing fixtures/helpers for `runFallbackDigest` or, if it exports `composeDigestMarkdown` for tests, call it directly; if not exported, export it):

```typescript
it("composeDigestMarkdown splits Market Commentary and Research Desk with edition tags", () => {
  const fresh = [
    mkProcessed({ source_name: "Vital Knowledge", subject: "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026" }),
    mkProcessed({ source_name: "The Diff", subject: "An essay" }),
  ];
  const md = composeDigestMarkdown(fresh, []);
  expect(md).toContain("## Market Commentary");
  expect(md).toContain("VITAL KNOWLEDGE [recap]");
  expect(md).toContain("## Research Desk");
  expect(md!.indexOf("## Market Commentary")).toBeLessThan(md!.indexOf("## Research Desk"));
});
```

(`mkProcessed` = the file's existing article-fixture helper; adapt the name to what exists.)

`workers/cron/test/fallback-evening.test.ts` — add prompt pins:

```typescript
it("buildSynthesisPrompt carries edition tags and the section contract", () => {
  const prompt = buildSynthesisPrompt(
    { NVDA: [mkMeta({ source_name: "Vital Knowledge", subject: "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026" })] },
    mkSnapshot(),
  );
  expect(prompt).toContain("**Vital Knowledge [recap]**");
  expect(prompt).toContain("EDITION COLLAPSING");
  expect(prompt).toContain("## The Session");
  expect(prompt).toContain("## Also covered");
});
```

Run: `cd workers/cron && npx vitest run test/fallback-digest.test.ts test/fallback-evening.test.ts` → new tests FAIL.

- [ ] **Step 2: Implement `fallback-digest.ts`**

Import at top: `import { sourceKind, editionLabel } from "./editions";`

Rewrite `composeDigestMarkdown` (export it for tests). Normalize both inputs to one render shape, split by kind, render commentary then Research Desk:

```typescript
interface RenderItem {
  source_name: string;
  subject: string;
  sentiment: string;
  url: string | null;
  summary: string | null;
  portfolio_relevance: string | null;
  themes: string[];
}

export function composeDigestMarkdown(
  fresh: ProcessedArticle[],
  snapshotMeta: RecentArticleMeta[]
): string | null {
  const totalCount = fresh.length + snapshotMeta.length;
  if (totalCount === 0) return null;

  const items: RenderItem[] = [
    ...fresh.map((a) => ({
      source_name: a.source_name,
      subject: a.subject,
      sentiment: a.sentiment ?? "neutral",
      url: null,
      summary: a.summary,
      portfolio_relevance: a.portfolio_relevance,
      themes: a.key_themes,
    })),
    ...snapshotMeta.map((a) => ({
      source_name: a.source_name,
      subject: a.subject,
      sentiment: a.sentiment ?? "neutral",
      url: a.source_url || a.website_url,
      summary: a.summary,
      portfolio_relevance: a.portfolio_relevance,
      themes: parseJsonArray(a.key_themes),
    })),
  ];

  const commentary = items.filter((i) => sourceKind(i.source_name) === "commentary");
  const essays = items.filter((i) => sourceKind(i.source_name) === "essay");

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", // Worker runs in UTC — render the ET market day
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const lines: string[] = [
    `# Morning Research Digest`,
    `### ${dateStr}`,
    "",
    `${totalCount} article${totalCount === 1 ? "" : "s"} · ${new Set(items.map((i) => i.source_name)).size} sources`,
    "",
    "---",
    "",
  ];

  const renderItem = (i: RenderItem, withEdition: boolean) => {
    const tag = withEdition ? editionLabel(i.source_name, i.subject).toUpperCase() : "";
    lines.push(`**${i.source_name.toUpperCase()}${tag}** · *${i.sentiment}*`);
    lines.push(i.url ? `### [${i.subject}](${i.url})` : `### ${i.subject}`);
    lines.push("");
    if (i.summary) {
      lines.push(i.summary);
      lines.push("");
    }
    if (i.portfolio_relevance) {
      lines.push(`> **Portfolio relevance**: ${i.portfolio_relevance}`);
      lines.push("");
    }
    if (i.themes.length > 0) {
      lines.push(`*${i.themes.join(" · ")}*`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  };

  if (commentary.length > 0) {
    lines.push("## Market Commentary");
    lines.push("");
    for (const i of commentary) renderItem(i, true);
  }
  if (essays.length > 0) {
    lines.push("## Research Desk");
    lines.push("");
    for (const i of essays) renderItem(i, false);
  }

  return lines.join("\n").trim();
}
```

(Structure mirror at less depth: no Session synthesis on the cloud morning path — that would add a Claude call + subrequests; disclosed limitation per spec.)

- [ ] **Step 3: Implement `fallback-evening.ts`**

Import: `import { editionLabel } from "./editions";`

In `buildSynthesisPrompt`, change the article line (line 348):

```typescript
      bucketLines.push(`**${a.source_name}${editionLabel(a.source_name, a.subject)}**: ${a.subject}`);
```

And replace the instruction block at the end of the returned template (after the existing numbered list, before TIMEFRAME) with the section contract + edition rule — final template:

```typescript
  return `You are a financial analyst writing an evening recap email (${dateStr}) for a portfolio manager.

Portfolio holdings: ${holdingsList}

Today's research feed — grouped by company/topic:

${bucketLines.join("\n")}

Write a concise markdown evening recap with EXACTLY this section order:
1. \`## The Session\` — the macro / market-wide narrative of the day (2-4 sentences).
2. One \`## SYM\` section per relevant holding with significant coverage — the header MUST begin with the ticker symbol. One tight paragraph each: what was said, what it means for the position.
3. \`## Also covered\` — one closing line for everything thin.

EDITION COLLAPSING (follow strictly):
- Some source names carry an edition tag like [dawn], [midday], [recap], [morning_wrap], [eod_wrap]. Tagged articles are installments of ONE publication's daily cycle; later editions supersede earlier ones. Tell each session's story ONCE — never present two editions of the same publication as independent sources agreeing with each other.

TIMEFRAME & THREAD COHERENCE (follow strictly):
- A company's coverage may span DIFFERENT trading days with OPPOSING moves. When it does, attribute each price move to its specific day ("rose Thursday as money rotated into financials; fell ~5% Friday in the broad selloff") instead of fusing them into one sentence. A name up one day and down the next is NOT a contradiction — name the days.
- Keep a structural / longer-horizon thread (e.g. an IPO-underwriting fee catalyst, a pending deal) SEPARATE from a same-day tactical move (e.g. today's selloff). Use separate sentences; do not imply one caused the other unless a source says so.
- Do not invent a sector or market driver a source did not state. If a name fell but no source attributes it to its sector, say it fell with the broad market — do not assert an unsourced reason.

Output markdown only. No preamble, no sign-off.`;
```

(The "Positioning Notes" section is absorbed into the per-name paragraphs; TIMEFRAME block byte-unchanged.)

- [ ] **Step 4: Run Worker suite; fix any pinned-prompt drift**

Run: `cd workers/cron && npx vitest run`
Expected: PASS. `fallback-evening.test.ts` pins on the TIMEFRAME block must still pass (the block is unchanged); pins on "Today's Key Themes"/"Company-by-Company"/"Positioning Notes" (if any) must be retargeted to the new section names.

- [ ] **Step 5: Commit**

```bash
git add workers/cron/src/fallback-digest.ts workers/cron/src/fallback-evening.ts workers/cron/test/fallback-digest.test.ts workers/cron/test/fallback-evening.test.ts
git commit -m "feat(worker): mirror structured digest layout in cloud fallbacks"
```

---

### Task 9: Preview route + viewer third layout

**Files:**
- Modify: `app/api/digest/preview/route.ts`
- Modify: `app/dashboard/components/DigestEmailViewer.tsx`

(No new automated test — the route is a thin composition of already-tested functions; verification is the manual preview step in Task 10. The API contract addition is additive.)

- [ ] **Step 1: Route — add `structuredHtml`**

Replace the body of `GET` in `app/api/digest/preview/route.ts` from line 33 down:

```typescript
  // Structured layout = exactly what the next real email will send (morning
  // flavor, no anomalies). NOTE: fires one Sonnet synthesis call when ≥5
  // commentary articles are in the window — user-triggered, acceptable cost.
  const structuredMd = await generateDigestSinceAdaptive(db, since, {
    includeAnomalies: false,
    edition: "morning",
  });
  const bySourceMd = generateDigestSince(db, since);
  const byCompanyMd = generateDigestByCompanySince(db, since);

  if (!structuredMd && !bySourceMd && !byCompanyMd) {
    return NextResponse.json({
      success: true,
      since,
      empty: true,
      structuredHtml: null,
      bySourceHtml: null,
      byCompanyHtml: null,
    });
  }

  const title = "Daily Research Digest";
  return NextResponse.json({
    success: true,
    since,
    empty: false,
    structuredHtml: structuredMd ? briefingToHtml(structuredMd, title) : null,
    bySourceHtml: bySourceMd ? briefingToHtml(bySourceMd, title) : null,
    byCompanyHtml: byCompanyMd ? briefingToHtml(byCompanyMd, title) : null,
  });
```

with the import updated to include `generateDigestSinceAdaptive`:

```typescript
import {
  generateDigestSince,
  generateDigestSinceAdaptive,
  getLastDigestSentAt,
} from "@/lib/digest/daily-digest";
```

- [ ] **Step 2: Viewer — third toggle, structured default**

In `app/dashboard/components/DigestEmailViewer.tsx`:

```typescript
type Layout = "structured" | "by_source" | "by_company";
```

`DigestPreviewResponse` gains `structuredHtml: string | null;`. Initial state: `useState<Layout>("structured")`. The post-fetch default fallback (line 56) becomes:

```typescript
        if (d.structuredHtml) setLayout("structured");
        else if (d.bySourceHtml) setLayout("by_source");
        else if (d.byCompanyHtml) setLayout("by_company");
```

`activeHtml` (line 81) becomes:

```typescript
  const activeHtml =
    layout === "structured" ? data?.structuredHtml
    : layout === "by_source" ? data?.bySourceHtml
    : data?.byCompanyHtml;
  const otherAvailable = Boolean(data?.structuredHtml || data?.bySourceHtml || data?.byCompanyHtml);
```

Add a third button BEFORE the existing two in the toggle group (line 106), same classes as the "By publication" button but without `border-l`:

```tsx
              <button
                type="button"
                onClick={() => setLayout("structured")}
                disabled={!data?.structuredHtml}
                className={`px-2.5 py-1 ${
                  layout === "structured"
                    ? "bg-gold/15 text-gold"
                    : "text-ink-dim hover:bg-raised disabled:opacity-40"
                }`}
              >
                Structured
              </button>
```

and add `border-l border-edge` to the "By publication" button's className so all three stay visually separated. Update the unavailable-view fallback text (line 165) to:

```tsx
              {layout === "structured" ? "Structured" : layout === "by_source" ? "By-publication" : "By-company"} view unavailable.
```

and the switch button at line 169 to cycle: `structured → by_source → by_company → structured`:

```tsx
                  onClick={() => setLayout(layout === "structured" ? "by_source" : layout === "by_source" ? "by_company" : "structured")}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add app/api/digest/preview/route.ts app/dashboard/components/DigestEmailViewer.tsx
git commit -m "feat(digest): structured layout in preview API + viewer toggle"
```

---

### Task 10: Full verification + docs

**Files:**
- Modify: `CLAUDE.md` (Conventions section)
- Run: full test suites, type-check, live preview

- [ ] **Step 1: Full Mac + Worker test suites**

Run: `npx vitest run && cd workers/cron && npx vitest run && cd ../..`
Expected: ALL PASS (report counts — baseline was 2418 Mac + 224 Worker; do not commit on any failure)

- [ ] **Step 2: Type-check both**

Run: `npx tsc --noEmit && cd workers/cron && npx tsc --noEmit && cd ../..`
Expected: clean

- [ ] **Step 3: Live preview against real data**

With the dev server running (`npm run dev`, port 3000):

```bash
curl -s "http://localhost:3000/api/digest/preview" | python3 -c "import json,sys; d=json.load(sys.stdin); print('empty:', d['empty']); print('structured present:', bool(d.get('structuredHtml')))"
```

Then eyeball the structured layout in the app (Research → Feeds → Preview button): confirm section order (Late arrivals if any → alerts → Session → names → Research Desk), VK editions collapsed into one narrative, essays listed individually.

- [ ] **Step 4: Add CLAUDE.md convention entry**

Append to the Conventions section of `CLAUDE.md`:

```markdown
- **Digest structured composer (2026-06-09)**: morning/evening emails render Late arrivals → alerts → anomalies (evening) → `## The Session`/`## Overnight & Setup` + per-name synthesis (commentary only) → `## Research Desk` (essays, rendered in code, never merged). `lib/digest/editions.ts` is the single source for source kinds (`commentary | essay`, unknown → essay) and edition regexes (VK dawn/midday/recap supersedence, TMTB wraps) — Worker mirror `workers/cron/src/editions.ts` is byte-parity (parity test in `workers/cron/test/editions.test.ts`); update BOTH when a newsletter changes its subject-line format, and add new sources to `SOURCE_KINDS`. Late-arrival rescue (`lib/digest/late-arrivals.ts`) flags articles received ≤60 min after the previous send (only when `last_digest_sent_at` is a full ISO timestamp). **Cloud-skip advances the marker**: `advanceDigestMarkerAfterCloudSend` (`lib/cron/marker-check.ts`) runs in both cron routes' "cloud already sent" branches, forward-only, using the Worker marker's `sentAt` (KV value has always been an ISO timestamp) — without it the next Mac-won email re-covers everything since the Mac last won (the 2026-06-09 7pm regression).
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: digest structured-composer conventions"
```

- [ ] **Step 6: Deploy + rollout (requires user confirmation per global git/deploy rules)**

Ask the user before each: `npx wrangler deploy` from `workers/cron/` (cloud mirror live), then watch the next 3-4 real sends for edition-collapsing quality and model self-talk. DMG rebuild happens at `/session-end` as usual.

---

## Self-Review Notes

- **Spec coverage:** layout (§Task 5), editions registry (§1), composer routing (§5), late arrivals (§2/§5), marker fix (§6), Worker mirror (§7/§8), preview (§9), tests (§1-§8), rollout (§10). Spec's "old-format marker tolerance" → Task 6 `iso()` guard + legacy fallback test. Spec's cap 30→40 → Task 5. Cross-file pointers → Task 3 + composer wiring in Task 5.
- **Type consistency:** `EditionId`/`sourceKind`/`editionLabel` (Task 1) are the only cross-task exports and are used with those exact names in Tasks 3, 4, 7, 8. `MarkerCheckResult.sentAt` (Task 6) matches Worker `getMarkerStatus` return. `generateDigestSinceAdaptive` opts `{ includeAnomalies?, edition? }` consistent across Tasks 5 and 9.
- **Known adaptation points (deliberate, not placeholders):** Tasks 4, 6, and 8 extend existing test files whose internal helper names (`captureSynthesisCall`, `makeKv`, `mkProcessed`, `mkMeta`, `mkSnapshot`) may differ — the steps name the intent and provide full test bodies; the executor adapts helper names to the file's existing idiom and must not weaken existing pins.
