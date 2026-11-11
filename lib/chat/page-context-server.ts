import type Database from "better-sqlite3";
import { getEventById } from "@/lib/queries/calendar";
import { getPageContext, type PageContextData } from "@/lib/chat/page-context";

/**
 * Page context, server side (Portfolio Assistant plan, Contract A).
 *
 * The client sends `page: { path }` (its `usePathname()` value) and nothing
 * else. The server takes only the path (and a numeric id inside it) from the
 * client and reads everything else from the database, so no client-written
 * text ever reaches the system prompt. The legacy free-text `pageContext`
 * field is ignored entirely.
 */

export const PAGE_PATH_MAX = 200;

export interface PageField {
  path: string;
}

/** The validated `page` field of a request body, or undefined (never an error). */
export function readPageField(body: unknown): PageField | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const page = (body as { page?: unknown }).page;
  if (page === null || typeof page !== "object" || Array.isArray(page)) return undefined;
  const path = (page as { path?: unknown }).path;
  if (typeof path !== "string") return undefined;
  if (path.length > PAGE_PATH_MAX || !path.startsWith("/dashboard")) return undefined;
  return { path };
}

export type ServerPageData = PageContextData & { eventDate?: string };

export interface ResolvedPage {
  path: string;
  data?: ServerPageData;
}

export const PAGE_TEXT_MAX = 80;

/**
 * A database string as it may appear in the page sentence (review R3-5):
 * control characters (newlines and tabs included) become spaces, runs of
 * whitespace collapse to one, and the result is capped, so a stored name can
 * never start a new line or section in the system prompt.
 */
export function cleanPageText(value: string | null | undefined, max: number = PAGE_TEXT_MAX): string {
  if (typeof value !== "string") return "";
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trim() : flat;
}

function positiveId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function resolvePageData(db: Database.Database, path: string): ResolvedPage {
  const security = /^\/dashboard\/security\/([^/?#]+)/.exec(path);
  if (security) {
    const id = positiveId(security[1]);
    if (id === null) return { path };
    const row = db
      .prepare("SELECT symbol, name, security_type FROM securities WHERE id = ?")
      .get(id) as { symbol: string; name: string | null; security_type: string | null } | undefined;
    const symbol = cleanPageText(row?.symbol);
    if (!row || !symbol) return { path };
    const data: ServerPageData = { symbol };
    const name = cleanPageText(row.name);
    if (name) data.name = name;
    const type = cleanPageText(row.security_type);
    if (type) data.type = type;
    return { path, data };
  }

  const print = /^\/dashboard\/print\/([^/?#]+)/.exec(path);
  if (print) {
    const id = positiveId(print[1]);
    if (id === null) return { path };
    const event = getEventById(db, id);
    const symbol = cleanPageText(event?.symbol);
    if (!event || !symbol) return { path };
    return { path, data: { symbol, eventDate: cleanPageText(event.event_date) } };
  }

  return { path };
}

/** The page sentence for the volatile system block, or undefined with no page. */
export function pageNoteFor(db: Database.Database, page: PageField | undefined): string | undefined {
  if (!page) return undefined;
  const { path, data } = resolvePageData(db, page.path);
  return getPageContext(path, data);
}
