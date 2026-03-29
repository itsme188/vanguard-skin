import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

interface SearchResult {
  type: "security" | "note" | "transaction";
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

    // Search securities (symbol or name)
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
          .join(" \u00b7 "),
        href: `/dashboard/security/${s.id}`,
      });
    }

    // Search notes (content)
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
          n.content.length > 80
            ? n.content.slice(0, 80) + "..."
            : n.content,
        href: `/dashboard/research?search=${encodeURIComponent(q)}`,
      });
    }

    // Search transactions (by symbol)
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
        // Only add if not already in securities results
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
