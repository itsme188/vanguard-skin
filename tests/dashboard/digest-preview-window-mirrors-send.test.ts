import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { resolveDigestSince } from "@/lib/digest/digest-window";
import { todayET } from "@/lib/calendar/date-utils";
import {
  DEFAULT_DIGEST_WINDOW,
  DIGEST_WINDOW_OPTIONS,
  digestPreviewSince,
  digestSendBody,
  digestWindowNeedsDate,
  isDigestMode,
  type DigestWindowChoice,
} from "@/app/dashboard/components/digest-window-choice";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// No DOM harness in this repo: the pure helpers are tested directly and the
// JSX wiring is pinned by source anchors.
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const VIEWER = read("app/dashboard/components/DigestEmailViewer.tsx");
const PANEL = read("app/dashboard/components/SendDigestPanel.tsx");
const FEEDS = read("app/dashboard/components/ResearchFeedsView.tsx");
const ROUTE = read("app/api/digest/preview/route.ts");

describe("digest window: the preview opens the same window a send would", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });
  afterEach(() => db.close());

  // The sender resolves its window with resolveDigestSince on the POST body.
  // The preview route takes `since`, or applies the since-last rule itself.
  const previewWindow = (w: DigestWindowChoice) =>
    digestPreviewSince(w) ?? resolveDigestSince(db, { mode: "since_last" });

  it.each<DigestWindowChoice>([
    { mode: "today", sinceDate: "" },
    { mode: "today", sinceDate: "2026-03-02" },
    { mode: "since_last", sinceDate: "" },
    { mode: "since_date", sinceDate: "2026-03-02" },
  ])("$mode ($sinceDate): same window as the send", (w) => {
    expect(previewWindow(w)).toBe(resolveDigestSince(db, digestSendBody(w)));
  });

  it("today is the Eastern calendar day, not the UTC one", () => {
    // 01:30 UTC on 3 March is still 2 March in New York.
    const evening = new Date("2026-03-03T01:30:00.000Z");
    expect(digestPreviewSince({ mode: "today", sinceDate: "" }, evening)).toBe("2026-03-02");
    expect(digestPreviewSince({ mode: "today", sinceDate: "" })).toBe(todayET());
  });

  it("since last email sends no window, so the server's own marker rule decides", () => {
    expect(digestPreviewSince({ mode: "since_last", sinceDate: "2026-03-02" })).toBeUndefined();
    const fn = sliceBetween(ROUTE, "function resolveSince(", "\n}");
    expect(fn).toContain("if (sinceParam) return sinceParam;");
    expect(fn).toContain('resolveDigestSince(db, { mode: "since_last" })');
  });

  it("a date mode with no date is flagged, and never falls back to another window", () => {
    const blank: DigestWindowChoice = { mode: "since_date", sinceDate: "" };
    expect(digestWindowNeedsDate(blank)).toBe(true);
    expect(digestPreviewSince(blank)).toBeUndefined();
    expect(digestWindowNeedsDate({ mode: "since_date", sinceDate: "2026-03-02" })).toBe(false);
    expect(digestWindowNeedsDate({ mode: "today", sinceDate: "" })).toBe(false);
    expect(digestWindowNeedsDate({ mode: "since_last", sinceDate: "" })).toBe(false);
  });

  it("the send body carries the date only in date mode", () => {
    expect(digestSendBody({ mode: "today", sinceDate: "2026-03-02" })).toEqual({ mode: "today" });
    expect(digestSendBody({ mode: "since_date", sinceDate: "2026-03-02" })).toEqual({
      mode: "since_date",
      sinceDate: "2026-03-02",
    });
  });

  it("the default and the options are the Send panel's own", () => {
    expect(DEFAULT_DIGEST_WINDOW).toEqual({ mode: "today", sinceDate: "" });
    expect(DIGEST_WINDOW_OPTIONS.map((o) => o.mode)).toEqual(["today", "since_last", "since_date"]);
    expect(isDigestMode("since_last")).toBe(true);
    expect(isDigestMode("last_week")).toBe(false);
  });
});

describe("digest window: one choice, held by the page, feeds both surfaces", () => {
  it("the page owns the choice and hands the same value to the preview and the panel", () => {
    expect(FEEDS).toContain("useState<DigestWindowChoice>(DEFAULT_DIGEST_WINDOW)");
    const viewer = sliceBetween(FEEDS, "<DigestEmailViewer", "/>");
    expect(viewer).toContain("digestWindow={digestWindow}");
    expect(viewer).toContain("onDigestWindowChange={setDigestWindow}");
    const panel = sliceBetween(FEEDS, "<SendDigestPanel", "/>");
    expect(panel).toContain("digestWindow={digestWindow}");
    expect(panel).toContain("onDigestWindowChange={setDigestWindow}");
  });

  it("the panel keeps no window state of its own and sends the shared choice", () => {
    expect(PANEL).not.toMatch(/useState<DigestMode>/);
    expect(PANEL).not.toContain('const [sinceDate, setSinceDate] = useState("")');
    const send = sliceBetween(PANEL, 'if (emailType === "digest") {', 'apiFetch("/api/digest/email"');
    expect(send).toContain("...digestSendBody(digestWindow)");
  });

  it("a window changed from the preview clears the panel's old status line", () => {
    const at = anchorIndex(PANEL, "if (seenWindow !== digestWindow) {");
    const block = PANEL.slice(at, at + 200);
    expect(block).toContain("setSeenWindow(digestWindow)");
    expect(block).toContain("setResult(null)");
  });

  it("the preview has its own picker with the same three options and a date box", () => {
    const picker = sliceBetween(VIEWER, 'aria-label="Digest window"', "</select>");
    expect(picker).toContain("value={digestWindow.mode}");
    expect(picker).toContain("DIGEST_WINDOW_OPTIONS.map(");
    expect(picker).toContain("isDigestMode(");
    const at = anchorIndex(VIEWER, 'aria-label="Digest window start date"');
    expect(VIEWER.slice(at - 200, at + 300)).toContain('type="date"');
    expect(VIEWER).toContain("Choose a date first");
  });
});

describe("digest window: a changed window never shows the old preview, and never pays", () => {
  const effect = sliceBetween(
    VIEWER,
    "useEffect(() => {\n    if (!open) return;\n    let cancelled",
    "}, [open, since, needsDate]);",
  );

  it("the load effect re-runs on the window and wipes the previous result first", () => {
    for (const reset of [
      "++sessionRef.current",
      "generatingRef.current = false",
      "setGenLoading(false)",
      "setGenFailed(false)",
      "setAttempted(false)",
      "setError(null)",
      "setData(null)",
    ]) {
      expect(effect.indexOf(reset)).toBeGreaterThan(-1);
      expect(effect.indexOf(reset)).toBeLessThan(effect.indexOf("(async () => {"));
    }
  });

  it("a blank date loads nothing", () => {
    const at = anchorIndex(effect, "if (needsDate) {");
    expect(at).toBeLessThan(effect.indexOf("(async () => {"));
    expect(effect.slice(at, at + 120)).toContain("return");
  });

  it("the effect still makes no AI call; the one POST stays behind the click and uses the window", () => {
    expect(effect).not.toContain("POST");
    expect(effect).not.toContain("apiFetch");
    expect(VIEWER.match(/method: "POST"/g)?.length).toBe(1);
    const gen = sliceBetween(VIEWER, "const generateStructured = async", "const openStructured");
    expect(gen).toContain("if (needsDate) return;");
    expect(gen).toContain('apiFetch(previewUrl(), { method: "POST" })');
    expect(gen).toContain("session !== sessionRef.current");
    const url = sliceBetween(VIEWER, "const previewUrl = () => {", "};");
    expect(url).toContain("since ? `?since=${encodeURIComponent(since)}`");
  });

  it("the window is resolved from the shared choice, on the Eastern clock", () => {
    expect(VIEWER).toContain("const since = digestPreviewSince(digestWindow);");
    expect(VIEWER).toContain("const needsDate = digestWindowNeedsDate(digestWindow);");
    expect(VIEWER).not.toMatch(/toISOString\(\)\.slice\(0, ?10\)/);
    expect(VIEWER).not.toMatch(/from "@\/lib\/digest\//);
  });
});
