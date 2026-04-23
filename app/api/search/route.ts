import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { searchResearchDocuments } from "@/lib/queries/research-documents";

export type SearchResultType =
  | "security"
  | "note"
  | "transaction"
  | "research_article"
  | "research_document"
  | "level"
  | "alert";

interface SearchResult {
  type: SearchResultType;
  id: number;
  title: string;
  subtitle: string;
  href: string;
}

export async function GET(request: NextRequest) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 1) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results: SearchResult[] = [];
    const pattern = `%${q}%`;

    // ── Securities (symbol or name) ─────────────────────────────
    const securities = db
      .prepare(
        `SELECT id, symbol, name, security_type, sector
         FROM securities
         WHERE symbol LIKE ? OR name LIKE ?
         ORDER BY
           CASE WHEN symbol LIKE ? THEN 0 ELSE 1 END,
           symbol
         LIMIT 8`
      )
      .all(pattern, pattern, `${q}%`) as {
      id: number;
      symbol: string;
      name: string | null;
      security_type: string | null;
      sector: string | null;
    }[];

    for (const s of securities) {
      results.push({
        type: "security",
        id: s.id,
        title: s.symbol,
        subtitle: [s.name, s.security_type, s.sector]
          .filter(Boolean)
          .join(" · "),
        href: `/dashboard/security/${s.id}`,
      });
    }

    // ── Notes (content) ─────────────────────────────────────────
    const notes = db
      .prepare(
        `SELECT n.id, n.note_type, n.content, n.event_date, s.symbol
         FROM notes n
         LEFT JOIN securities s ON s.id = n.security_id
         WHERE n.content LIKE ?
         ORDER BY n.event_date DESC
         LIMIT 5`
      )
      .all(pattern) as {
      id: number;
      note_type: string;
      content: string;
      event_date: string;
      symbol: string | null;
    }[];

    for (const n of notes) {
      const typeLabel =
        n.note_type === "trade_thesis"
          ? "Trade Thesis"
          : n.note_type === "earnings"
            ? "Earnings"
            : "Journal";
      results.push({
        type: "note",
        id: n.id,
        title: `${typeLabel}${n.symbol ? ` — ${n.symbol}` : ""}`,
        subtitle:
          n.content.length > 80 ? n.content.slice(0, 80) + "..." : n.content,
        href: `/dashboard/research?search=${encodeURIComponent(q)}`,
      });
    }

    // ── Research articles (subject + summary) ───────────────────
    const articles = db
      .prepare(
        `SELECT a.id, a.subject, a.summary, a.received_at, rs.name AS source_name
         FROM research_articles a
         JOIN research_sources rs ON rs.id = a.source_id
         WHERE a.subject LIKE ? OR a.summary LIKE ?
         ORDER BY a.received_at DESC
         LIMIT 5`
      )
      .all(pattern, pattern) as {
      id: number;
      subject: string;
      summary: string | null;
      received_at: string;
      source_name: string;
    }[];

    for (const a of articles) {
      const date = a.received_at.slice(0, 10);
      const body =
        a.summary && a.summary.length > 0
          ? a.summary.length > 80
            ? a.summary.slice(0, 80) + "..."
            : a.summary
          : a.subject;
      results.push({
        type: "research_article",
        id: a.id,
        title: `${a.source_name} — ${date}`,
        subtitle: body,
        href: `/dashboard/research?search=${encodeURIComponent(q)}`,
      });
    }

    // ── Research documents (FTS5) ───────────────────────────────
    // Require ≥ 3 chars — FTS5 phrase search on a single letter is noisy.
    if (q.length >= 3) {
      try {
        const docs = searchResearchDocuments(db, { query: q, limit: 4 });
        for (const d of docs) {
          const subtitleParts = [
            d.author,
            d.publication_date ?? d.uploaded_at.slice(0, 10),
            d.document_type,
          ].filter(Boolean);
          results.push({
            type: "research_document",
            id: d.id,
            title: d.title,
            subtitle: subtitleParts.join(" · "),
            href: `/dashboard/research/documents/${d.id}`,
          });
        }
      } catch {
        // FTS5 can throw on unusual query strings (e.g. unmatched quotes).
        // Fail open — the palette still returns other result types.
      }
    }

    // ── Security levels (thesis + source_author + symbol) ───────
    const levels = db
      .prepare(
        `SELECT sl.id, sl.security_id, sl.level_type, sl.price, sl.thesis,
                sl.source_author, sl.is_active, s.symbol
         FROM security_levels sl
         JOIN securities s ON s.id = sl.security_id
         WHERE sl.thesis LIKE ?
            OR sl.source_author LIKE ?
            OR s.symbol LIKE ?
         ORDER BY sl.is_active DESC, sl.created_at DESC
         LIMIT 4`
      )
      .all(pattern, pattern, pattern) as {
      id: number;
      security_id: number;
      level_type: string;
      price: number;
      thesis: string | null;
      source_author: string | null;
      is_active: number;
      symbol: string;
    }[];

    for (const l of levels) {
      const activeMark = l.is_active ? "" : " (inactive)";
      const thesisFragment = l.thesis
        ? l.thesis.length > 60
          ? l.thesis.slice(0, 60) + "..."
          : l.thesis
        : l.source_author ?? "";
      results.push({
        type: "level",
        id: l.id,
        title: `${l.symbol} ${l.level_type.replace("_", " ")} $${l.price.toFixed(2)}${activeMark}`,
        subtitle: thesisFragment,
        href: `/dashboard/security/${l.security_id}`,
      });
    }

    // ── Level alerts (suggested_action + symbol) ────────────────
    const alerts = db
      .prepare(
        `SELECT la.id, la.security_id, la.triggered_at, la.triggered_price,
                la.user_response, la.suggested_action, s.symbol
         FROM level_alerts la
         JOIN securities s ON s.id = la.security_id
         WHERE la.suggested_action LIKE ? OR s.symbol LIKE ?
         ORDER BY la.triggered_at DESC
         LIMIT 3`
      )
      .all(pattern, pattern) as {
      id: number;
      security_id: number;
      triggered_at: string;
      triggered_price: number;
      user_response: string;
      suggested_action: string | null;
      symbol: string;
    }[];

    for (const a of alerts) {
      const date = a.triggered_at.slice(0, 10);
      const status =
        a.user_response === "pending" ? "pending" : a.user_response;
      const body = a.suggested_action ?? `hit $${a.triggered_price.toFixed(2)}`;
      results.push({
        type: "alert",
        id: a.id,
        title: `${a.symbol} alert — ${date} (${status})`,
        subtitle: body.length > 80 ? body.slice(0, 80) + "..." : body,
        href: `/dashboard/alerts`,
      });
    }

    // ── Transactions (by symbol, 2+ chars only) ─────────────────
    if (q.length >= 2) {
      const txnSymbols = db
        .prepare(
          `SELECT DISTINCT s.id, s.symbol, s.name, COUNT(*) AS cnt
           FROM transactions t
           JOIN securities s ON s.id = t.security_id
           WHERE s.symbol LIKE ?
           GROUP BY s.id
           ORDER BY cnt DESC
           LIMIT 3`
        )
        .all(`${q}%`) as {
        id: number;
        symbol: string;
        name: string | null;
        cnt: number;
      }[];

      for (const t of txnSymbols) {
        if (!results.some((r) => r.type === "security" && r.id === t.id)) {
          results.push({
            type: "transaction",
            id: t.id,
            title: `${t.symbol} transactions`,
            subtitle: `${t.cnt} trades${t.name ? ` — ${t.name}` : ""}`,
            href: `/dashboard/security/${t.id}`,
          });
        }
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
