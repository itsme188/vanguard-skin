/**
 * Plan Task 8, part B (cost item R4): the compact model-facing output.
 *
 * Every chat tool carries `toModelOutput` (Contract H). The installed SDK
 * (ai 6.0.138, createToolModelOutput) calls it with { toolCallId, input,
 * output } when it builds the tool-result message for the MODEL, both in the
 * live step loop and when convertToModelMessages replays history with the
 * route's tools; the UI stream carries the raw `output` unchanged. So the
 * client and every executeTool test see the full result; only the model
 * reads the compact one.
 *
 * Protects:
 *  - no information loss: every non-empty field path of the full result is
 *    present in the compact one (columns, _same_in_rows_shown, or keys), per tool family;
 *    list_info, units, currency, as-of dates, warnings, scope notes and
 *    withheld reasons included;
 *  - every row survives, and money columns sum to the raw sum within
 *    $0.01 x rows (rounding to cents only);
 *  - error results are never compacted;
 *  - long text is cut per row only in lists of 2+ rows, with a marker naming
 *    the call that reads it in full, and that call works.
 * Bounds: the compact form of 50 holdings is at least 30% smaller.
 * Synthetic data only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS, compactToolOutput, COMPACT_FORMAT_LEGEND } from "@/lib/chat/tools";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const text = (n: number, seed: string) => (seed + " ").repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);

/** A synthetic book big enough to hit every list cap. */
function seedBig(n = 60): void {
  const today = todayET();
  const sec = db.prepare("INSERT INTO securities (symbol, name, security_type, currency, sector) VALUES (?, ?, 'stock', 'USD', 'Technology')");
  const hold = db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (3, ?, ?, ?, ?, ?)",
  );
  const price = db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
  const lot = db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
     VALUES (3, ?, ?, ?, 5, 5, ?)`,
  );
  const tx = db.prepare(
    "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key) VALUES (3, ?, ?, 'BUY', 5, ?, ?, ?)",
  );
  const level = db.prepare(
    "INSERT INTO security_levels (security_id, level_type, price, source_author, thesis) VALUES (?, 'support', ?, 'Me', ?)",
  );
  const alert = db.prepare(
    "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, suggested_action) VALUES (?, ?, datetime('now', ?), ?, ?)",
  );
  for (let i = 0; i < n; i++) {
    const id = sec.run(`ZQ${i}`, `ZQ${i} Holdings Corporation`).lastInsertRowid as number;
    hold.run(id, 10 + i, 1000 + i * 3.333, today, `h${i}`);
    price.run(id, today, 100 + i / 7);
    lot.run(id, addDays(today, -400 - i), 100 + i / 3, 500 + i / 3);
    lot.run(id, addDays(today, -40 - i), 101 + i / 3, 505 + i / 3);
    for (let k = 0; k < 4; k++) tx.run(id, addDays(today, -i - k * 30), 100 + i / 9, -(500 + i / 9), `t${i}-${k}`);
    for (let k = 0; k < 2; k++) {
      const lid = level.run(id, 90 + i + k / 4, text(400, `level thesis ${i}`)).lastInsertRowid as number;
      alert.run(lid, id, `-${i * 2 + k + 1} hours`, 91 + i, text(600, `suggested action ${i}`));
    }
    db.prepare("INSERT INTO notes (note_type, content, security_id, event_date) VALUES ('earnings', ?, ?, ?)").run(
      text(1500, `note body ${i}`),
      id,
      addDays(today, -i),
    );
    db.prepare(
      "INSERT INTO calendar_events (source, event_type, event_date, title, description, symbol, source_key) VALUES ('t', 'earnings', ?, ?, ?, ?, ?)",
    ).run(addDays(today, (i % 14) + 1), `ZQ${i} earnings`, text(200, `event ${i}`), `ZQ${i}`, `e${i}`);
  }
  for (let w = 0; w < 4; w++) {
    db.prepare(
      "INSERT INTO calendar_briefings (week_of, title, content, event_count, generated_at) VALUES (?, ?, ?, 10, datetime('now'))",
    ).run(addDays("2026-10-05", 7 * w), `Week ${w}`, text(30000, `briefing ${w}`));
  }
}

/** Every non-empty field path (array positions dropped). */
function fullPaths(v: unknown, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => fullPaths(x, path, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (x === null || x === undefined || x === "") continue;
      out.add(`${path}.${k}`);
      fullPaths(x, `${path}.${k}`, out);
    }
  }
  return out;
}
function compactPaths(v: unknown, path = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => compactPaths(x, path, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o._cols) && Array.isArray(o._rows)) {
      (o._cols as string[]).forEach((c, i) => {
        out.add(`${path}.${c}`);
        (o._rows as unknown[][]).forEach((r) => compactPaths(r[i], `${path}.${c}`, out));
      });
      for (const [k, x] of Object.entries((o._same_in_rows_shown as Record<string, unknown>) ?? {})) {
        out.add(`${path}.${k}`);
        compactPaths(x, `${path}.${k}`, out);
      }
      return out;
    }
    for (const [k, x] of Object.entries(o)) {
      if (k === "_format") continue;
      out.add(`${path}.${k}`);
      compactPaths(x, `${path}.${k}`, out);
    }
  }
  return out;
}
function expectNoFieldLost(tool: string, full: unknown): unknown {
  const compact = compactToolOutput(tool, full);
  const missing = [...fullPaths(full)].filter((p) => !compactPaths(compact).has(p));
  expect(missing, tool).toEqual([]);
  return compact;
}

type Cols = { _cols: string[]; _rows: unknown[][]; _same_in_rows_shown?: Record<string, unknown> };
const col = (c: Cols | Array<Record<string, unknown>>, name: string): unknown[] => {
  // A result the compact form would only lengthen is returned whole.
  if (Array.isArray(c)) return c.map((r) => r[name]);
  const i = c._cols.indexOf(name);
  return i >= 0 ? c._rows.map((r) => r[i]) : c._rows.map(() => c._same_in_rows_shown?.[name]);
};

describe("toModelOutput wiring", () => {
  it("every tool carries it and it returns the compact JSON", async () => {
    seedBig(3);
    const full = await executeTool(db, "query_holdings", {});
    for (const t of CHAT_TOOLS) expect(typeof t.toModelOutput, t.name).toBe("function");
    const holdings = CHAT_TOOLS.find((t) => t.name === "query_holdings")!;
    const out = await holdings.toModelOutput!({ toolCallId: "c1", input: {}, output: full });
    expect(out).toEqual({ type: "json", value: compactToolOutput("query_holdings", full) });
  });

  it("an error result is never compacted", () => {
    const err = { error: "No security 'ZZZZ' on file. Nothing was filtered or returned." };
    expect(compactToolOutput("query_notes", err)).toBe(err);
  });

  it("the legend is present whenever the form changed", async () => {
    seedBig(3);
    const c = compactToolOutput("query_holdings", await executeTool(db, "query_holdings", {})) as Record<string, unknown>;
    expect(c._format).toBe(COMPACT_FORMAT_LEGEND);
  });
});

describe("no field is lost, per tool family", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ["query_holdings", { limit: 50 }],
    ["query_tax_lots", { status: "all", limit: 50 }],
    ["query_transactions", { limit: 50 }],
    ["query_allocation", { group_by: "symbol" }],
    ["query_price_history", { symbol: "ZQ1" }],
    ["query_calendar_events", { days_ahead: 30 }],
    ["query_calendar_briefings", { weeks_back: 4 }],
    ["query_levels", {}],
    ["query_alerts", {}],
    ["query_notes", {}],
    ["query_options_greeks", {}],
    ["query_risk", {}],
    ["query_realized_gains", {}],
    ["query_data_confidence", {}],
    ["query_alerts", {}, { scopeAccountIds: [3] }],
    ["query_calendar_briefings", { weeks_back: 4 }, { scopeAccountIds: [3] }],
  ];
  for (const [tool, input, opts] of cases) {
    it(`${tool} ${JSON.stringify(input)}${opts ? " (single-account chat)" : ""}`, async () => {
      seedBig(60);
      const full = await executeTool(db, tool, input, opts);
      expect((full as { error?: string }).error, tool).toBeUndefined();
      expectNoFieldLost(tool, full);
    });
  }
});

describe("size and conservation", () => {
  it("50 holdings: at least 30% smaller, every row kept, market values to the cent", async () => {
    seedBig(50);
    const full = (await executeTool(db, "query_holdings", { limit: 50 })) as { data: Array<{ market_value: number }> };
    const compact = compactToolOutput("query_holdings", full) as { data: Cols };
    expect(JSON.stringify(compact).length).toBeLessThanOrEqual(0.7 * JSON.stringify(full).length);
    expect(compact.data._rows).toHaveLength(50);
    const rawSum = full.data.reduce((a, r) => a + r.market_value, 0);
    const cSum = (col(compact.data, "market_value") as number[]).reduce((a, v) => a + v, 0);
    expect(Math.abs(rawSum - cSum)).toBeLessThanOrEqual(0.01 * 50);
    // A uniform per-row constant is hoisted, not repeated.
    expect(compact.data._same_in_rows_shown?.account_name).toBe("IBKR");
    expect(compact.data._same_in_rows_shown?.currency).toBe("USD");
  });

  it("identifiers, dates and quantities are never rounded", async () => {
    seedBig(5);
    const full = (await executeTool(db, "query_tax_lots", {})) as { data: Array<Record<string, unknown>> };
    const compact = compactToolOutput("query_tax_lots", full) as { data: Cols };
    expect(col(compact.data, "quantity_remaining")).toEqual(full.data.map((r) => r.quantity_remaining));
    expect(col(compact.data, "acquisition_date")).toEqual(full.data.map((r) => r.acquisition_date));
  });
});

describe("long text is cut per row with a working way to read it in full", () => {
  it("notes: a cut body names query_notes with id, and that call returns it whole", async () => {
    seedBig(12);
    const full = await executeTool(db, "query_notes", {});
    const compact = compactToolOutput("query_notes", full) as { data: Cols };
    const bodies = col(compact.data, "content") as string[];
    const ids = col(compact.data, "id") as number[];
    expect(bodies[0]).toMatch(/…\[cut: \d+ more chars; call query_notes with \{"id":\d+\} to read it in full\]$/);
    const one = (await executeTool(db, "query_notes", { id: ids[0] })) as { data: Array<{ content: string }> };
    expect(one.data).toHaveLength(1);
    expect(one.data[0].content).toHaveLength(1500);
    // One row: never cut.
    const oneCompact = compactToolOutput("query_notes", one) as { data: Array<{ content: string }> };
    expect(oneCompact.data[0].content).toHaveLength(1500);
  });

  it("alerts and levels: id fetch returns the full text", async () => {
    seedBig(4);
    const alerts = compactToolOutput("query_alerts", await executeTool(db, "query_alerts", {})) as { data: { alerts: Cols } };
    expect((col(alerts.data.alerts, "suggested_action") as string[])[0]).toMatch(/call query_alerts with \{"id":\d+\}/);
    const alertId = (col(alerts.data.alerts, "id") as number[])[0];
    const oneAlert = (await executeTool(db, "query_alerts", { id: alertId })) as { data: { alerts: Array<{ suggested_action: string }> } };
    expect(oneAlert.data.alerts).toHaveLength(1);
    expect(oneAlert.data.alerts[0].suggested_action).toHaveLength(600);

    const levels = compactToolOutput("query_levels", await executeTool(db, "query_levels", {})) as { data: { levels: Cols } };
    expect((col(levels.data.levels, "thesis") as string[])[0]).toMatch(/call query_levels with \{"id":\d+\}/);
    const levelId = (col(levels.data.levels, "id") as number[])[0];
    const oneLevel = (await executeTool(db, "query_levels", { id: levelId })) as { data: { levels: Array<{ thesis: string }> } };
    expect(oneLevel.data.levels).toHaveLength(1);
    expect(oneLevel.data.levels[0].thesis).toHaveLength(400);
  });

  it("briefings: several weeks are cut, one week_of is whole", async () => {
    seedBig(1);
    const c = compactToolOutput(
      "query_calendar_briefings",
      await executeTool(db, "query_calendar_briefings", { weeks_back: 4 }),
    ) as { data: { briefings: Cols } };
    expect((col(c.data.briefings, "content") as string[])[0]).toMatch(/call query_calendar_briefings with \{"week_of":"\d{4}-\d{2}-\d{2}"\}/);
    const one = (await executeTool(db, "query_calendar_briefings", { week_of: "2026-10-05" })) as {
      data: { briefings: Array<{ content: string }> };
    };
    expect(one.data.briefings[0].content).toHaveLength(30000);
  });

  it("an id that matches nothing is an error", async () => {
    seedBig(1);
    expect(((await executeTool(db, "query_notes", { id: 99999 })) as { error?: string }).error).toMatch(/No note with id 99999/);
    expect(((await executeTool(db, "query_alerts", { id: 99999 })) as { error?: string }).error).toMatch(/No alert with id 99999/);
    expect(((await executeTool(db, "query_levels", { id: 99999 })) as { error?: string }).error).toMatch(/No level with id 99999/);
  });

  it("a scoped chat reads another account's note by id, with its account named (owner ruling 2026-11-12)", async () => {
    seedBig(1);
    const t = db
      .prepare("INSERT INTO transactions (account_id, trade_date, type, amount, source_key) VALUES (1, '2026-10-01', 'FEE', -1, 'x1')")
      .run().lastInsertRowid as number;
    const nid = db
      .prepare("INSERT INTO notes (note_type, content, transaction_id, event_date) VALUES ('journal', 'other account', ?, '2026-10-01')")
      .run(t).lastInsertRowid as number;
    const r = (await executeTool(db, "query_notes", { id: nid }, { scopeAccountIds: [3] })) as {
      error?: string;
      data?: Array<{ content: string; account?: string }>;
    };
    expect(r.error).toBeUndefined();
    expect(r.data?.[0]).toMatchObject({ content: "other account", account: "Vanguard Taxable" });
  });
});

describe("row limits a model can use", () => {
  const cases: Array<[string, Record<string, unknown>, number, number, (d: unknown) => number]> = [
    ["query_alerts", {}, 20, 40, (d) => (d as { alerts: unknown[] }).alerts.length],
    ["query_levels", {}, 30, 60, (d) => (d as { levels: unknown[] }).levels.length],
    ["query_notes", {}, 10, 30, (d) => (d as unknown[]).length],
    ["query_allocation", { group_by: "symbol" }, 50, 200, (d) => (d as unknown[]).length],
  ];
  for (const [tool, input, def, max, count] of cases) {
    it(`${tool}: default ${def}, max ${max}, list_info honest`, async () => {
      seedBig(60);
      const d = (await executeTool(db, tool, input)) as { data: unknown; list_info: { limit: number; truncated: boolean; returned: number } };
      expect(d.list_info.limit).toBe(def);
      expect(count(d.data)).toBe(Math.min(def, d.list_info.returned));
      const m = (await executeTool(db, tool, { ...input, limit: 9999 })) as { list_info: { limit: number } };
      expect(m.list_info.limit).toBe(max);
      const desc = JSON.stringify(CHAT_TOOLS.find((t) => t.name === tool)!.input_schema);
      expect(desc).toContain(`default ${def}, max ${max}`);
    });
  }

  it("query_allocation by symbol reports truncation and keeps the largest groups", async () => {
    seedBig(60);
    const d = (await executeTool(db, "query_allocation", { group_by: "symbol", limit: 10 })) as {
      data: Array<{ total_market_value: number }>;
      list_info: { truncated: boolean; returned: number };
    };
    expect(d.list_info).toMatchObject({ returned: 10, truncated: true });
    const values = d.data.map((r) => r.total_market_value);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });
});

describe("size report (set COMPACT_REPORT=1 to print)", () => {
  it("measures the nine cases at their caps", async () => {
    seedBig(220);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["query_alerts", { limit: 50 }],
      ["query_notes", { limit: 30 }],
      ["query_levels", { limit: 100 }],
      ["query_calendar_briefings", { weeks_back: 4 }],
      ["query_tax_lots", { status: "all", limit: 200 }],
      ["query_holdings", { limit: 200 }],
      ["query_calendar_events", { days_ahead: 30, limit: 200 }],
      ["query_transactions", { limit: 200 }],
      ["query_allocation", { group_by: "symbol", limit: 200 }],
    ];
    const lines: string[] = [];
    for (const [tool, input] of cases) {
      const full = await executeTool(db, tool, input);
      const compact = compactToolOutput(tool, full);
      const f = JSON.stringify(full).length;
      const c = JSON.stringify(compact).length;
      expect(c, tool).toBeLessThan(f);
      lines.push(`${tool}\t${f}\t${c}`);
    }
    if (process.env.COMPACT_REPORT) console.log(lines.join("\n"));
  }, 60000);
});

// Review RF-1 / RF-2: rounding is decided by an explicit per-tool field map,
// never by a substring of the key. Hand-checked cases from the review.
describe("only mapped fields are rounded", () => {
  // Long, repeated keys so the compact form really applies (it is skipped
  // when it would not shorten the result); both forms are checked by col().
  const five = <T extends Record<string, unknown>>(f: (i: number) => T) =>
    Array.from({ length: 30 }, (_, i) => ({ ...f(i), sector_classification_label: "Technology hardware and equipment" }));

  it("return contributions keep every digit, sign and order", () => {
    const full = {
      data: {
        attribution: {
          top_contributors: five((i) => ({ symbol: `ZA${i}`, contribution: 0.00321 - i * 0.0005 })),
          top_detractors: five((i) => ({ symbol: `ZB${i}`, contribution: -0.00178 - i * 0.0001 })),
        },
      },
    };
    const c = compactToolOutput("query_performance_vs_benchmark", full) as {
      data: { attribution: { top_contributors: Cols; top_detractors: Cols } };
    };
    expect((c as unknown as Record<string, unknown>)._format).toBeDefined();
    expect((col(c.data.attribution.top_contributors, "contribution") as number[])[0]).toBe(0.00321);
    expect((col(c.data.attribution.top_detractors, "contribution") as number[])[0]).toBe(-0.00178);
    expect(col(c.data.attribution.top_contributors, "contribution")).toEqual(
      full.data.attribution.top_contributors.map((r) => r.contribution),
    );
    expect(col(c.data.attribution.top_detractors, "contribution")).toEqual(
      full.data.attribution.top_detractors.map((r) => r.contribution),
    );
  });

  it("a FRED value of 4.001 or 1.0823 is exact", () => {
    const full = { data: five((i) => ({ date: `2026-01-0${i + 1}`, value: i % 2 ? 1.0823 : 4.001 })) };
    const c = compactToolOutput("query_fred", full) as { data: Cols };
    expect(col(c.data, "value")).toEqual(full.data.map((r) => r.value));
    expect((col(c.data, "value") as number[]).slice(0, 2)).toEqual([4.001, 1.0823]);
    expect((c as unknown as Record<string, unknown>)._format).toBeDefined();
  });

  it("a scenario share_of_option_value is exact", () => {
    const full = { data: { presets: five((i) => ({ name: `P${i}`, share_of_option_value: 0.48459052573500433 + i })) } };
    const c = compactToolOutput("query_scenarios", full) as { data: { presets: Cols } };
    expect((col(c.data.presets, "share_of_option_value") as number[])[0]).toBe(0.48459052573500433);
    expect((c as unknown as Record<string, unknown>)._format).toBeDefined();
  });

  it("a mapped field is rounded and named in _rounded", async () => {
    seedBig(3);
    const c = compactToolOutput("query_holdings", await executeTool(db, "query_holdings", {})) as {
      _rounded: Record<string, string[]>;
    };
    expect(c._rounded.cents).toContain("market_value");
    expect(c._rounded.price4).toContain("latest_price");
    expect(c._rounded.pct2).toContain("position_weight_pct");
    expect(compactToolOutput("query_fred", { data: five((i) => ({ value: i + 0.5, date: `d${i}` })) })).not.toHaveProperty("_rounded");
  });
});

// Review RF-5: a uniform column of a truncated list is named for the rows
// shown, and the legend says so.
describe("uniform columns name the rows shown", () => {
  it("a truncated list hoists into _same_in_rows_shown, never _same", async () => {
    seedBig(60);
    const full = (await executeTool(db, "query_holdings", { limit: 10 })) as { list_info: { truncated: boolean } };
    expect(full.list_info.truncated).toBe(true);
    const c = compactToolOutput("query_holdings", full) as { data: Cols & { _same?: unknown } };
    expect(c.data._same).toBeUndefined();
    expect(c.data._same_in_rows_shown?.currency).toBe("USD");
    expect(COMPACT_FORMAT_LEGEND).toMatch(/_same_in_rows_shown holds columns whose value is identical on every row SHOWN/);
    expect(COMPACT_FORMAT_LEGEND).toMatch(/Only the fields named in _rounded are rounded/);
  });
});
