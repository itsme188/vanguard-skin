/**
 * Where the Plaid Link connect page keeps its session across the bank's
 * sign-in redirect. Browser-only, no imports: the page hands in the two
 * storages, tests hand in stand-ins.
 *
 * One entry PER TAB. The page used a single localStorage key, so two tabs
 * overwrote each other: a tab coming back from the bank resumed with the
 * other tab's token and reauth flag, and the first tab to finish deleted the
 * other's entry.
 *
 *   - The tab's id lives in sessionStorage, which a browser keeps per tab
 *     across a redirect away and back.
 *   - The entry lives in localStorage under `<key>:<tab id>`, so a return
 *     that lands in a DIFFERENT tab (some phone flows) can still find a
 *     session. It takes the newest one, which is what the single key held.
 *   - An entry left by the previous build under the bare key is still read.
 */

export const PLAID_LINK_STORAGE_KEY = "vgs:plaidLink";
export const PLAID_LINK_TAB_KEY = "vgs:plaidLinkTab";
/** A Plaid link token lives four hours; an older entry can never resume. */
export const PLAID_LINK_ENTRY_MAX_AGE_MS = 4 * 60 * 60 * 1000;

const ENTRY_PREFIX = `${PLAID_LINK_STORAGE_KEY}:`;

/** The Link token to resume with, and whether the session is a reauth
 * (update mode: skip the exchange) or a fresh connect. */
export type StoredLinkPayload = { token: string; reauth: boolean };

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface PlaidLinkStore {
  /** Record this tab's session before Link opens. */
  save(payload: StoredLinkPayload): void;
  /** The session to resume: this tab's, else the newest stored, else none. */
  load(): StoredLinkPayload | null;
  /** Drop this tab's entry and whichever entry `load` resumed from. */
  clear(): void;
}

type Entry = StoredLinkPayload & { savedAt: number };

function parseEntry(raw: string | null): Entry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Entry> | null;
    if (
      parsed &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0 &&
      typeof parsed.reauth === "boolean"
    ) {
      const savedAt =
        typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0;
      return { token: parsed.token, reauth: parsed.reauth, savedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function defaultNewId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPlaidLinkStore(opts: {
  local: StorageLike;
  session: StorageLike;
  now?: () => number;
  newId?: () => string;
}): PlaidLinkStore {
  const { local, session } = opts;
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? defaultNewId;

  // Kept in memory too, so a browser that blocks sessionStorage still clears
  // what this page load saved.
  let tabId: string | null = null;
  let resumedKey: string | null = null;

  function readTabId(): string | null {
    if (tabId) return tabId;
    try {
      const stored = session.getItem(PLAID_LINK_TAB_KEY);
      if (stored) tabId = stored;
    } catch {
      // sessionStorage blocked: fall through to the newest-session lookup.
    }
    return tabId;
  }

  function ensureTabId(): string {
    const existing = readTabId();
    if (existing) return existing;
    const id = newId();
    tabId = id;
    try {
      session.setItem(PLAID_LINK_TAB_KEY, id);
    } catch {
      // Not persisted: the return leg will use the newest-session lookup.
    }
    return id;
  }

  function entryKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < local.length; i++) {
      const k = local.key(i);
      if (k && k.startsWith(ENTRY_PREFIX)) keys.push(k);
    }
    return keys;
  }

  return {
    save(payload) {
      const ownKey = `${ENTRY_PREFIX}${ensureTabId()}`;
      const cutoff = now() - PLAID_LINK_ENTRY_MAX_AGE_MS;
      for (const k of entryKeys()) {
        if (k === ownKey) continue;
        const entry = parseEntry(local.getItem(k));
        if (!entry || entry.savedAt < cutoff) local.removeItem(k);
      }
      local.setItem(ownKey, JSON.stringify({ ...payload, savedAt: now() } satisfies Entry));
    },

    load() {
      resumedKey = null;
      const id = readTabId();
      if (id) {
        const ownKey = `${ENTRY_PREFIX}${id}`;
        const own = parseEntry(local.getItem(ownKey));
        if (own) {
          resumedKey = ownKey;
          return { token: own.token, reauth: own.reauth };
        }
      }

      let newest: { key: string; entry: Entry } | null = null;
      for (const k of entryKeys()) {
        const entry = parseEntry(local.getItem(k));
        if (entry && (!newest || entry.savedAt > newest.entry.savedAt)) newest = { key: k, entry };
      }
      if (newest) {
        resumedKey = newest.key;
        return { token: newest.entry.token, reauth: newest.entry.reauth };
      }

      const legacy = parseEntry(local.getItem(PLAID_LINK_STORAGE_KEY));
      if (legacy) {
        resumedKey = PLAID_LINK_STORAGE_KEY;
        return { token: legacy.token, reauth: legacy.reauth };
      }
      return null;
    },

    clear() {
      const id = readTabId();
      if (id) local.removeItem(`${ENTRY_PREFIX}${id}`);
      if (resumedKey) local.removeItem(resumedKey);
      resumedKey = null;
    },
  };
}
