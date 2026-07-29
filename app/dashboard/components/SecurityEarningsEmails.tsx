"use client";

import { useState } from "react";
import type { SentEarningsEmail } from "@/lib/queries/earnings-emails";
import { EarningsEmailViewer } from "./EarningsEmailViewer";
import { Chip } from "./Chip";

/**
 * Per-symbol sent earnings emails on Security Detail — family-aware rows the
 * page fetches server-side via getSentEarningsEmails; the page renders the
 * Section wrapper only when at least one email exists.
 * Spec: docs/superpowers/specs/2026-07-28-earnings-email-archive-design.md
 * (name note: EarningsEmailsSection is the Settings prefs panel).
 */

function fmtSentAt(sentAt: string): string {
  // sent_at is SQLite datetime('now') — UTC with a space separator.
  const d = new Date(sentAt.replace(" ", "T") + (sentAt.includes("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return sentAt;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

export function SecurityEarningsEmails({ emails }: { emails: SentEarningsEmail[] }) {
  const [viewing, setViewing] = useState<SentEarningsEmail | null>(null);

  return (
    <div>
      {emails.map((e, idx) => (
        <button
          key={`${e.event_id}-${e.phase}`}
          onClick={() => setViewing(e)}
          className={`w-full flex items-center gap-3.5 px-5 py-2.5 text-left hover:bg-raised transition-colors ${
            idx === 0 ? "" : "border-t border-edge"
          }`}
          title={`Open the ${e.phase} email`}
        >
          <span
            className="font-mono text-ink-dim flex-shrink-0"
            style={{ fontSize: "12px", letterSpacing: "0.1em", width: "90px" }}
          >
            {e.event_date}
          </span>
          <Chip tone={e.phase === "preview" ? "gold" : "info"} size="xs" uppercase>
            {e.phase}
          </Chip>
          {e.sent_by_cloud === 1 && (
            <Chip tone="neutral" size="xs">cloud</Chip>
          )}
          <span className="ml-auto text-[11px] text-ink-faint font-mono">
            sent {fmtSentAt(e.sent_at)}
          </span>
        </button>
      ))}
      {viewing && (
        <EarningsEmailViewer
          eventId={viewing.event_id}
          phase={viewing.phase}
          open
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}
