/**
 * Plaid Link session storage is per tab (wave Q unit 30).
 *
 * The connect page kept the Link token under ONE localStorage key. Two tabs
 * on the page overwrote each other: tab A came back from the bank's sign-in
 * and resumed with tab B's token (and tab B's reauth flag), and whichever tab
 * finished first deleted the other's entry.
 *
 * Now each tab writes its own entry. The tab's id lives in sessionStorage,
 * which the browser keeps per tab across the redirect and back. The entry
 * itself stays in localStorage, so a return that lands in a different tab
 * (some phone flows) still finds a session: the newest one, which is what the
 * single key gave before.
 *
 * No DOM harness in this repo, so the storage logic is a plain module driven
 * here with in-memory stand-ins; the page is source-pinned to use it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  createPlaidLinkStore,
  PLAID_LINK_STORAGE_KEY,
  PLAID_LINK_TAB_KEY,
  PLAID_LINK_ENTRY_MAX_AGE_MS,
  type StorageLike,
} from "@/lib/plaid/link-storage";

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

class ThrowingStorage implements StorageLike {
  get length(): number {
    throw new Error("blocked");
  }
  key(): string | null {
    throw new Error("blocked");
  }
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
  removeItem(): void {
    throw new Error("blocked");
  }
}

/** One browser: a shared localStorage and a clock; each tab has its own sessionStorage. */
function browser() {
  const local = new MemoryStorage();
  let clock = 1_000_000;
  let seq = 0;
  return {
    local,
    advance(ms: number) {
      clock += ms;
    },
    /** A page load in a tab. Pass the same `session` to model a reload or the redirect back. */
    page(session: StorageLike = new MemoryStorage()) {
      return {
        session,
        store: createPlaidLinkStore({
          local,
          session,
          now: () => clock,
          newId: () => `tab-${++seq}`,
        }),
      };
    },
  };
}

describe("one tab: the session survives the redirect and back", () => {
  it("saves, then a fresh page load in the same tab reads the same token and flag", () => {
    const b = browser();
    const first = b.page();
    first.store.save({ token: "link-token-a", reauth: true });

    const afterRedirect = b.page(first.session);
    expect(afterRedirect.store.load()).toEqual({ token: "link-token-a", reauth: true });
  });

  it("clear removes the entry, so a second resume finds nothing", () => {
    const b = browser();
    const first = b.page();
    first.store.save({ token: "link-token-a", reauth: false });
    const back = b.page(first.session);
    expect(back.store.load()).not.toBeNull();
    back.store.clear();
    expect(b.page(first.session).store.load()).toBeNull();
    expect(b.local.keys().filter((k) => k.startsWith(PLAID_LINK_STORAGE_KEY))).toEqual([]);
  });

  it("nothing stored: load is null", () => {
    expect(browser().page().store.load()).toBeNull();
  });

  it("a second connect in the same tab replaces that tab's entry, not adds one", () => {
    const b = browser();
    const p = b.page();
    p.store.save({ token: "link-token-a", reauth: false });
    b.page(p.session).store.save({ token: "link-token-a2", reauth: true });
    expect(b.local.keys().filter((k) => k.startsWith(`${PLAID_LINK_STORAGE_KEY}:`))).toHaveLength(1);
    expect(b.page(p.session).store.load()).toEqual({ token: "link-token-a2", reauth: true });
  });
});

describe("two tabs do not overwrite each other", () => {
  it("each tab resumes with its OWN token and reauth flag, whichever saved last", () => {
    const b = browser();
    const tabA = b.page();
    tabA.store.save({ token: "link-token-a", reauth: true });
    b.advance(5_000);
    const tabB = b.page();
    tabB.store.save({ token: "link-token-b", reauth: false });

    // Tab A returns from the bank AFTER tab B saved. The single key handed it
    // tab B's token and a fresh-connect flag; it must get its own.
    expect(b.page(tabA.session).store.load()).toEqual({ token: "link-token-a", reauth: true });
    expect(b.page(tabB.session).store.load()).toEqual({ token: "link-token-b", reauth: false });
  });

  it("one tab finishing does not delete the other tab's session", () => {
    const b = browser();
    const tabA = b.page();
    tabA.store.save({ token: "link-token-a", reauth: true });
    const tabB = b.page();
    tabB.store.save({ token: "link-token-b", reauth: false });

    // Tab B finishes without ever loading (the direct, no-redirect leg).
    tabB.store.clear();
    expect(b.page(tabA.session).store.load()).toEqual({ token: "link-token-a", reauth: true });

    // And a tab that resumed and then cleared leaves the other alone too.
    const tabC = b.page();
    tabC.store.save({ token: "link-token-c", reauth: false });
    const aBack = b.page(tabA.session);
    aBack.store.load();
    aBack.store.clear();
    expect(b.page(tabC.session).store.load()).toEqual({ token: "link-token-c", reauth: false });
    expect(b.page(tabA.session).store.load()).toEqual({ token: "link-token-c", reauth: false }); // fallback only
  });
});

describe("the return lands in a different tab: still resumable, as before", () => {
  it("a tab with no session of its own resumes the only stored session", () => {
    const b = browser();
    b.page().store.save({ token: "link-token-a", reauth: true });
    const otherTab = b.page();
    expect(otherTab.store.load()).toEqual({ token: "link-token-a", reauth: true });
    // Finishing there clears the entry it used.
    otherTab.store.clear();
    expect(b.page().store.load()).toBeNull();
  });

  it("with several stored sessions it takes the newest (what the single key held)", () => {
    const b = browser();
    b.page().store.save({ token: "link-token-old", reauth: true });
    b.advance(60_000);
    b.page().store.save({ token: "link-token-new", reauth: false });
    expect(b.page().store.load()).toEqual({ token: "link-token-new", reauth: false });
  });

  it("a session written by the previous build (the single key) is still read and cleared", () => {
    const b = browser();
    b.local.setItem(PLAID_LINK_STORAGE_KEY, JSON.stringify({ token: "link-token-legacy", reauth: true }));
    const p = b.page();
    expect(p.store.load()).toEqual({ token: "link-token-legacy", reauth: true });
    p.store.clear();
    expect(b.local.getItem(PLAID_LINK_STORAGE_KEY)).toBeNull();
  });

  it("a per-tab session wins over a leftover single-key entry", () => {
    const b = browser();
    b.local.setItem(PLAID_LINK_STORAGE_KEY, JSON.stringify({ token: "link-token-legacy", reauth: true }));
    b.page().store.save({ token: "link-token-a", reauth: false });
    expect(b.page().store.load()).toEqual({ token: "link-token-a", reauth: false });
  });
});

describe("bad and stale entries", () => {
  it("a corrupt entry is ignored, never thrown on", () => {
    const b = browser();
    const p = b.page();
    p.store.save({ token: "link-token-a", reauth: false });
    const ownKey = b.local.keys().find((k) => k.startsWith(`${PLAID_LINK_STORAGE_KEY}:`))!;
    b.local.setItem(ownKey, "{not json");
    expect(b.page(p.session).store.load()).toBeNull();

    b.local.setItem(ownKey, JSON.stringify({ token: "", reauth: false, savedAt: 1 }));
    expect(b.page(p.session).store.load()).toBeNull();
    b.local.setItem(ownKey, JSON.stringify({ token: "link-token-a", reauth: "yes", savedAt: 1 }));
    expect(b.page(p.session).store.load()).toBeNull();
  });

  it("saving sweeps out other tabs' entries older than a Link token's life, and corrupt ones", () => {
    const b = browser();
    b.page().store.save({ token: "link-token-abandoned", reauth: false });
    b.local.setItem(`${PLAID_LINK_STORAGE_KEY}:junk`, "{not json");
    b.advance(PLAID_LINK_ENTRY_MAX_AGE_MS + 1);
    const fresh = b.page();
    fresh.store.save({ token: "link-token-fresh", reauth: false });
    const entries = b.local.keys().filter((k) => k.startsWith(`${PLAID_LINK_STORAGE_KEY}:`));
    expect(entries).toHaveLength(1);
    expect(b.page(fresh.session).store.load()).toEqual({ token: "link-token-fresh", reauth: false });
  });

  it("saving keeps another tab's entry that is still within a Link token's life", () => {
    const b = browser();
    const tabA = b.page();
    tabA.store.save({ token: "link-token-a", reauth: true });
    b.advance(PLAID_LINK_ENTRY_MAX_AGE_MS - 1);
    b.page().store.save({ token: "link-token-b", reauth: false });
    expect(b.page(tabA.session).store.load()).toEqual({ token: "link-token-a", reauth: true });
  });

  it("the sweep never touches a key outside the Plaid Link prefix", () => {
    const b = browser();
    b.local.setItem("vgs:theme", "dark");
    b.local.setItem("vgs:plaidLinkOther", "keep");
    b.advance(PLAID_LINK_ENTRY_MAX_AGE_MS * 2);
    const p = b.page();
    p.store.save({ token: "link-token-a", reauth: false });
    p.store.clear();
    expect(b.local.getItem("vgs:theme")).toBe("dark");
    expect(b.local.getItem("vgs:plaidLinkOther")).toBe("keep");
  });
});

describe("sessionStorage unavailable (blocked or private mode)", () => {
  it("still saves and resumes, through the newest-session fallback", () => {
    const local = new MemoryStorage();
    const mk = () =>
      createPlaidLinkStore({ local, session: new ThrowingStorage(), now: () => 5, newId: () => "mem-1" });
    const first = mk();
    expect(() => first.save({ token: "link-token-a", reauth: true })).not.toThrow();
    const back = mk();
    expect(back.load()).toEqual({ token: "link-token-a", reauth: true });
    back.clear();
    expect(mk().load()).toBeNull();
  });

  it("the tab id is written to sessionStorage, not localStorage", () => {
    const b = browser();
    const p = b.page();
    p.store.save({ token: "link-token-a", reauth: false });
    expect(p.session.getItem(PLAID_LINK_TAB_KEY)).toBe("tab-1");
    expect(b.local.getItem(PLAID_LINK_TAB_KEY)).toBeNull();
  });
});

describe("the connect page uses the per-tab store", () => {
  const src = readFileSync("app/dashboard/plaid-link/page.tsx", "utf8");

  it("builds the store from both storages and never touches localStorage by a fixed key", () => {
    expect(src).toContain('from "@/lib/plaid/link-storage"');
    expect(src).toContain("createPlaidLinkStore({ local: window.localStorage, session: window.sessionStorage })");
    expect(src).not.toMatch(/localStorage\.(getItem|setItem|removeItem)\(/);
    expect(src).not.toContain("LINK_STORAGE_KEY");
  });

  it("every place that used to drop the single key now clears through the store", () => {
    expect(src.match(/linkStore\.clear\(\)/g)).toHaveLength(4);
    expect(src.match(/linkStore\.save\(/g)).toHaveLength(1);
    expect(src.match(/linkStore\.load\(\)/g)).toHaveLength(1);
  });
});
