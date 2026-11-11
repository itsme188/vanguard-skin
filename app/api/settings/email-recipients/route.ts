import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { firstBadRecipient } from "@/lib/queries/email-recipients";

export const dynamic = "force-dynamic";

const ALLOWED_KEYS = [
  "briefing_email_recipients",
  "digest_email_recipients",
  "evening_email_recipients",
] as const;

type RecipientKey = (typeof ALLOWED_KEYS)[number];

/**
 * GET /api/settings/email-recipients
 *
 * Returns the current per-email-type recipient overrides stored in the
 * `settings` key-value table.
 *
 * Shape: {
 *   briefing_email_recipients?: string,
 *   digest_email_recipients?: string,
 *   evening_email_recipients?: string,
 * }
 *
 * Absent or empty-string values are omitted. Callers that need a fallback
 * should check `lib/queries/email-recipients.ts::getRecipientsFor` which
 * falls back to the relevant env var when no DB override is present.
 */
export async function GET(): Promise<Response> {
  const rows = db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (
        'briefing_email_recipients',
        'digest_email_recipients',
        'evening_email_recipients'
      )`,
    )
    .all() as { key: string; value: string }[];

  const out: Partial<Record<RecipientKey, string>> = {};
  for (const r of rows) {
    out[r.key as RecipientKey] = r.value;
  }
  return NextResponse.json(out);
}

/**
 * PATCH /api/settings/email-recipients
 *
 * Updates one or more recipient lists. Only keys present in the request body
 * are written (partial updates allowed).
 *
 * Body: {
 *   briefing_email_recipients?: string,
 *   digest_email_recipients?: string,
 *   evening_email_recipients?: string,
 * }
 *
 * Every value is checked first; a bad entry answers 400 and nothing is saved.
 * Values are stored as-is (comma-separated email strings). Parsing into an
 * array happens in `getRecipientsFor` at read time. Pass an empty string to
 * clear a key and fall back to the env var.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Check every key first; write nothing unless all of them pass.
  const values: [RecipientKey, string][] = [];
  for (const key of ALLOWED_KEYS) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: "Recipients must be text, a comma-separated list. Nothing was saved.",
        },
        { status: 400 },
      );
    }
    const value = typeof raw === "string" ? raw : "";
    const bad = firstBadRecipient(value);
    if (bad !== null) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: `"${bad}" is not an email address. Nothing was saved.`,
        },
        { status: 400 },
      );
    }
    values.push([key, value]);
  }

  db.transaction(() => {
    for (const [key, value] of values) {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE
           SET value = excluded.value,
               updated_at = excluded.updated_at`,
      ).run(key, value);
    }
  })();

  return NextResponse.json({ ok: true, success: true });
}
