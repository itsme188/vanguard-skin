/**
 * Unit B26: global overlays, search ranking, theme, privacy sync, digest banner.
 * No DOM harness in this repo, so component behaviour is pinned with source
 * scans (anchorIndex throws on a vanished anchor) plus one pure function.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";
import { anchorIndex } from "../helpers/source-anchor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const read = (p: string) => readFileSync(p, "utf8");

describe("Escape closes only the topmost overlay", () => {
  const palette = read("app/dashboard/components/CommandPalette.tsx");
  const notes = read("app/dashboard/components/NotesAmbient.tsx");

  it("the palette stops propagation of the Escape it claims", () => {
    const at = anchorIndex(palette, 'e.key === "Escape" && open');
    expect(palette.slice(at, at + 700)).toContain("e.stopPropagation()");
  });

  it("the notes overlay ignores an already-claimed Escape", () => {
    expect(notes).toMatch(/e\.key === "Escape" && open && !e\.defaultPrevented/);
  });

  it("Cmd+K, Cmd+J and Cmd+; toggles are still wired", () => {
    expect(palette).toMatch(/e\.key === "k"/);
    expect(notes).toMatch(/e\.key === ";"/);
    expect(read("app/dashboard/components/ChatDrawer.tsx")).toMatch(/e\.key === "j"/);
  });
});

describe("ambient notes yields to the chat overlay", async () => {
  const { shouldDismissForChat } = await import("@/app/dashboard/components/NotesAmbient");
  it("dismisses on phone/tablet widths when chat opens", () => {
    expect(shouldDismissForChat(true, 390)).toBe(true);
    expect(shouldDismissForChat(true, 1279)).toBe(true);
  });
  it("keeps the panel beside the xl rail and when chat is closed", () => {
    expect(shouldDismissForChat(true, 1280)).toBe(false);
    expect(shouldDismissForChat(false, 390)).toBe(false);
  });
  it("listens for the drawer's chat-state-change broadcast", () => {
    expect(read("app/dashboard/components/NotesAmbient.tsx")).toContain('"chat-state-change"');
  });
});

describe("palette symbol cell wraps an OCC symbol", () => {
  it("no longer a fixed w-16 column", () => {
    const src = read("app/dashboard/components/CommandPalette.tsx");
    expect(src).toContain("min-w-16");
    expect(src).toContain("break-all");
    expect(src).not.toMatch(/shrink-0 w-16/);
  });
});

describe("theme color-scheme", () => {
  const css = read("app/globals.css");
  it("declares light on :root and dark under data-theme=dark", () => {
    const root = anchorIndex(css, ":root {");
    expect(css.slice(root, root + 300)).toContain("color-scheme: light");
    const dark = anchorIndex(css, '[data-theme="dark"] {');
    expect(css.slice(dark, dark + 200)).toContain("color-scheme: dark");
  });
});

describe("privacy follows other tabs", () => {
  const src = read("lib/privacy/context.tsx");
  it("listens to the storage event for the privacy key only", () => {
    expect(src).toContain('addEventListener("storage"');
    expect(src).toMatch(/e\.key !== STORAGE_KEY\) return/);
    expect(src).toMatch(/setIsPrivate\(e\.newValue === "1"\)/);
  });
});

describe("digest banner dismissal persists", () => {
  const src = read("app/dashboard/components/DigestCatchup.tsx");
  it("uses a try-wrapped sessionStorage keyed by ET date", () => {
    const at = anchorIndex(src, "function isDismissedToday");
    const block = src.slice(at, at + 300);
    expect(block).toContain("try {");
    expect(block).toContain("todayET()");
  });
  it("the X button records the dismissal", () => {
    const at = anchorIndex(src, 'aria-label="Dismiss digest reminder"');
    expect(src.slice(at - 200, at)).toContain("rememberDismissal()");
  });
  it("shows the server skip reason, not a hardcoded already-sent claim", () => {
    expect(src).not.toContain("already sent (cloud fallback");
    expect(src).toContain("data.reason");
  });
});

describe("/api/search ranks live contracts above expired ones", () => {
  beforeEach(() => {
    hoisted.db = new Database(":memory:");
    hoisted.db.pragma("foreign_keys = ON");
    runMigrations(hoisted.db);
    vi.resetModules();
  });

  function seed(symbol: string, expiry: string | null, kind: "stock" | "option") {
    hoisted.db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, expiration_date) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(symbol, symbol, kind, kind === "stock" ? "equity" : "option", kind === "stock" ? 1 : 100, expiry);
  }

  it("puts a live option ahead of expired ones that sort earlier by symbol", async () => {
    const expired = buildOCCSymbol("ZZZ", "2024-08-02", "PUT", 100);
    const expired2 = buildOCCSymbol("ZZZ", "2026-02-11", "PUT", 100);
    const live = buildOCCSymbol("ZZZ", "2099-11-20", "CALL", 100);
    seed(expired, "2024-08-02", "option");
    seed(expired2, "2026-02-11", "option");
    seed(live, "2099-11-20", "option");
    seed("ZZZ", null, "stock");
    const mod = await import("@/app/api/search/route");
    const res = await mod.GET(new NextRequest("http://test/api/search?q=ZZZ&type=security"));
    const titles = ((await res.json()) as { results: { title: string }[] }).results.map((r) => r.title);
    expect(titles[0]).toBe("ZZZ");
    expect(titles[1]).toBe(live);
    expect(titles.indexOf(live)).toBeLessThan(titles.indexOf(expired));
    expect(titles.indexOf(live)).toBeLessThan(titles.indexOf(expired2));
  });
});
