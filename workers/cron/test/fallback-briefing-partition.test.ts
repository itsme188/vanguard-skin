/**
 * Worker <-> Mac parity for how the weekly briefing sorts a week's calendar
 * rows (lib/calendar/briefing-partition.ts): "portfolio earnings" is the kept
 * earnings row for each print, whatever its source.
 *
 * Three pins:
 *  1. the block between the BEGIN / END markers in
 *     workers/cron/src/fallback-briefing.ts is byte-identical to the same
 *     block in lib/calendar/briefing-partition.ts;
 *  2. both copies return the same answer on a case matrix;
 *  3. the Worker's briefing prompt lists a Nasdaq-kept or hand-entered print
 *     under portfolio earnings once, never under macro, and never lists a
 *     hidden row (the snapshot, unlike the Mac's week reader, carries them).
 *
 * Synthetic symbols and invented round figures only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { FallbackEnv } from "../src/fallback-digest";
import type { Snapshot } from "../src/state";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  jsonSchema: (s: unknown) => s,
}));
vi.mock("../src/ai", () => ({
  getModelForFeature: vi.fn(() => "mock-model"),
  generateWithFailover: vi.fn(
    async (_env: unknown, _feature: unknown, _catalog: unknown, call: (model: unknown) => Promise<unknown>) =>
      call("mock-model"),
  ),
}));
vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});
vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

import {
  runFallbackBriefing,
  partitionBriefingEvents as workerPartition,
  briefingRowHasRealSlot as workerHasSlot,
} from "../src/fallback-briefing";
import {
  partitionBriefingEvents as macPartition,
  briefingRowHasRealSlot as macHasSlot,
  type BriefingPartitionRow,
} from "../../../lib/calendar/briefing-partition";
import { loadLatestSnapshot } from "../src/state";
import { generateText } from "ai";

const PRINT = "2026-11-05";

type Row = Snapshot["calendarEvents"][number];

function row(over: Partial<Row> & { id: number; source: string }): Row {
  return {
    event_type: "earnings",
    event_date: PRINT,
    event_time: null,
    title: `${over.symbol ?? "?"} earnings`,
    description: null,
    security_id: null,
    symbol: null,
    expected_impact: "high",
    consensus_estimate: null,
    previous_value: null,
    raw_json: null,
    superseded: 0,
    ...over,
  } as Row;
}

const finnhubRow = (id: number, symbol: string, hour?: string, over: Partial<Row> = {}) =>
  row({
    id,
    source: "finnhub",
    symbol,
    title: `${symbol} earnings (Finnhub row)`,
    raw_json: JSON.stringify({
      entry: { symbol, date: PRINT, epsEstimate: 1, ...(hour ? { hour } : {}) },
      history: [],
      finnhub_symbol: symbol,
    }),
    ...over,
  });

const nasdaqRow = (id: number, symbol: string, hour: string | null, over: Partial<Row> = {}) =>
  row({
    id,
    source: "nasdaq",
    symbol,
    title: `${symbol} earnings (Nasdaq row)`,
    raw_json: JSON.stringify({ entry: { hour, epsForecast: 1, epsActual: null }, nasdaq_symbol: symbol }),
    ...over,
  });

const manualRow = (id: number, symbol: string, over: Partial<Row> = {}) =>
  row({
    id,
    source: "manual",
    symbol,
    event_time: "AMC",
    title: `${symbol} earnings (Manual entry)`,
    ...over,
  });

const cpiRow = (id: number, over: Partial<Row> = {}) =>
  row({ id, source: "fred", event_type: "cpi", title: "CPI", event_time: "08:30", ...over });

function makeEnv(): FallbackEnv {
  return {
    CRON_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    ANTHROPIC_API_KEY: "test-key",
    BRIEFING_EMAIL_TO: "default@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  } as FallbackEnv;
}

function makeSnapshot(calendarEvents: Row[]): Snapshot {
  return {
    schemaVersion: 7,
    snapshotDate: "2026-11-01",
    generatedAt: "2026-11-01T07:00:00Z",
    heldSymbols: ["ZZA"],
    briefingHoldings: [{ symbol: "ZZA", name: "ZZA Corp", sector: "Technology", netQty: 10 }],
    settings: {},
    calendarEvents,
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
  } as unknown as Snapshot;
}

async function promptFor(calendarEvents: Row[]): Promise<string> {
  (loadLatestSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(makeSnapshot(calendarEvents));
  const result = await runFallbackBriefing(makeEnv());
  expect(result.kind).toBe("success");
  const calls = (generateText as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0].prompt as string;
}

function sectionOf(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n## ${heading}`);
  if (start < 0) return "";
  const next = prompt.indexOf("\n## ", start + 4);
  return prompt.slice(start, next < 0 ? undefined : next);
}

beforeEach(() => {
  vi.clearAllMocks();
  (generateText as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "## Week Overview\n\nBody." });
});

describe("Worker briefing prompt: portfolio earnings are the kept row, any source", () => {
  it("Nasdaq row kept, Finnhub twin hidden: listed once under portfolio earnings, not under macro", async () => {
    const prompt = await promptFor([
      finnhubRow(1, "ZZA", undefined, { superseded: 1 }),
      nasdaqRow(2, "ZZA", "bmo"),
      cpiRow(3),
    ]);
    const earnings = sectionOf(prompt, "Portfolio Earnings This Week");
    const other = sectionOf(prompt, "Macro & Other Events This Week");
    expect(earnings).toContain("ZZA earnings (Nasdaq row)");
    expect(prompt).not.toContain("ZZA earnings (Finnhub row)");
    expect(other).toContain("**CPI**");
    expect(other).not.toContain("ZZA");
  });

  it("hand-entered row kept, Finnhub twin hidden: listed once under portfolio earnings", async () => {
    const prompt = await promptFor([finnhubRow(1, "ZZB", "amc", { superseded: 1 }), manualRow(2, "ZZB")]);
    const earnings = sectionOf(prompt, "Portfolio Earnings This Week");
    expect(earnings).toContain("ZZB earnings (Manual entry)");
    expect(prompt).not.toContain("ZZB earnings (Finnhub row)");
    expect(sectionOf(prompt, "Macro & Other Events This Week")).toBe("");
  });

  it("both rows still showing (no reconcile pass yet): listed once, the slotted row", async () => {
    const prompt = await promptFor([finnhubRow(1, "ZZA"), nasdaqRow(2, "ZZA", "amc")]);
    const earnings = sectionOf(prompt, "Portfolio Earnings This Week");
    expect(earnings.match(/\*\*ZZA earnings/g)).toHaveLength(1);
    expect(earnings).toContain("ZZA earnings (Nasdaq row)");
    expect(sectionOf(prompt, "Macro & Other Events This Week")).toBe("");
  });

  it("a hidden macro row is not narrated either", async () => {
    const prompt = await promptFor([cpiRow(3, { superseded: 1 }), finnhubRow(1, "ZZA", "amc")]);
    expect(prompt).not.toContain("**CPI**");
  });

  it("tolerates a snapshot row whose raw_json is an object", async () => {
    const prompt = await promptFor([
      finnhubRow(1, "ZZA"),
      nasdaqRow(2, "ZZA", "amc", { raw_json: { entry: { hour: "amc" } } as unknown as string }),
    ]);
    expect(sectionOf(prompt, "Portfolio Earnings This Week")).toContain("ZZA earnings (Nasdaq row)");
  });
});

describe("briefing-partition parity (Worker mirror vs Mac)", () => {
  function block(path: string): string {
    const src = readFileSync(new URL(path, import.meta.url), "utf8");
    const begin = src.indexOf("// ── BEGIN briefing-partition");
    const endMarker = "// ── END briefing-partition";
    const end = src.indexOf(endMarker);
    expect(begin, `${path}: BEGIN marker`).toBeGreaterThan(-1);
    expect(end, `${path}: END marker`).toBeGreaterThan(begin);
    return src.slice(begin, end + endMarker.length);
  }

  it("the mirrored block is byte-identical", () => {
    const mac = block("../../../lib/calendar/briefing-partition.ts");
    const worker = block("../src/fallback-briefing.ts");
    expect(mac.length).toBeGreaterThan(1000);
    expect(worker).toBe(mac);
  });

  const matrix: { name: string; rows: BriefingPartitionRow[] }[] = [
    { name: "empty", rows: [] },
    { name: "nasdaq kept / finnhub hidden", rows: [finnhubRow(1, "ZZA", undefined, { superseded: 1 }), nasdaqRow(2, "ZZA", "bmo"), cpiRow(3)] },
    { name: "manual kept / finnhub hidden", rows: [finnhubRow(1, "ZZB", "amc", { superseded: 1 }), manualRow(2, "ZZB")] },
    { name: "unreconciled, nasdaq slotted", rows: [finnhubRow(1, "ZZA"), nasdaqRow(2, "ZZA", "amc")] },
    { name: "unreconciled, both slotted", rows: [nasdaqRow(1, "ZZA", "amc"), finnhubRow(2, "ZZA", "amc")] },
    { name: "unreconciled, neither slotted", rows: [nasdaqRow(1, "ZZA", null), finnhubRow(2, "ZZA", "dmh")] },
    { name: "unreconciled, manual vs unslotted finnhub", rows: [finnhubRow(1, "ZZA"), manualRow(2, "ZZA")] },
    { name: "different dates", rows: [finnhubRow(1, "ZZA", "amc", { event_date: "2026-11-04" }), nasdaqRow(2, "ZZA", "amc")] },
    { name: "wsh + macro", rows: [row({ id: 1, source: "wsh", symbol: "ZZC" }), cpiRow(2)] },
    { name: "case-different symbols", rows: [finnhubRow(1, "zza", "amc"), nasdaqRow(2, "ZZA", "amc")] },
    { name: "no symbol rows are never merged", rows: [row({ id: 1, source: "manual" }), row({ id: 2, source: "manual" })] },
  ];

  it.each(matrix)("same partition: $name", ({ rows }) => {
    const idsOf = (p: ReturnType<typeof macPartition<BriefingPartitionRow>>) => ({
      portfolioEarnings: p.portfolioEarnings.map((r) => r.id),
      wshEarnings: p.wshEarnings.map((r) => r.id),
      otherEvents: p.otherEvents.map((r) => r.id),
    });
    expect(idsOf(workerPartition(rows))).toEqual(idsOf(macPartition(rows)));
    for (const r of rows) expect(workerHasSlot(r)).toBe(macHasSlot(r));
  });

  it("the matrix answers are the intended ones", () => {
    const answer = (name: string) =>
      macPartition(matrix.find((m) => m.name === name)!.rows).portfolioEarnings.map((r) => r.id);
    expect(answer("nasdaq kept / finnhub hidden")).toEqual([2]);
    expect(answer("manual kept / finnhub hidden")).toEqual([2]);
    expect(answer("unreconciled, nasdaq slotted")).toEqual([2]);
    expect(answer("unreconciled, both slotted")).toEqual([2]); // Finnhub
    expect(answer("unreconciled, neither slotted")).toEqual([2]); // Finnhub
    expect(answer("unreconciled, manual vs unslotted finnhub")).toEqual([2]); // the slot wins
    expect(answer("different dates")).toEqual([1, 2]);
    expect(answer("wsh + macro")).toEqual([]);
    expect(answer("case-different symbols")).toEqual([1]);
    expect(answer("no symbol rows are never merged")).toEqual([1, 2]);
  });
});
