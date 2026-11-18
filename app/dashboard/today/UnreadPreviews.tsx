"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { CHIP_TONE_TEXT, GOLD_OUTLINE_HOVER } from "@/app/dashboard/components/chip-tone-text";

/**
 * The "not read" list on an armed Earnings Hub row (bogey intake 2026-11-18,
 * Task D). Lists the previews that name this print's ticker, arrived in the
 * days before it, and have not been read for its bogeys
 * (`listUnreadPreviews`, lib/earnings/unread-previews.ts), each with a
 * "Read for bogeys" button that runs ONE AI read of that article.
 *
 * Loading the list is a plain read (no AI). Nothing renders when the list is
 * empty. A row being read elsewhere shows "Reading…" and no button.
 */

type RowState = "not_read" | "read_failed" | "reading";

interface UnreadPreview {
  articleId: number;
  sourceName: string;
  subject: string;
  receivedAt: string;
  state: RowState;
}

interface RecompileReport {
  added: string[];
  updated: string[];
  retired: string[];
  deleted: string[];
  conflicts: Array<{ id: string; fields: string[] }>;
}

interface ReadData {
  bogeysStored: number;
  status: "hit" | "no_numbers" | "images_incomplete";
  recompiled: RecompileReport | null;
  recompileFailed?: boolean;
}

type Outcome =
  | { kind: "running" }
  | { kind: "done"; text: string; warn: string | null }
  | { kind: "error"; text: string };

const STATE_LABEL: Record<RowState, string> = {
  not_read: "Not read",
  read_failed: "Read failed",
  reading: "Reading…",
};

/** Stored `received_at` is space-separated UTC; shown as the Eastern date. */
function shortEasternDate(receivedAt: string): string {
  const raw = receivedAt.trim();
  const iso = raw.replace(" ", "T") + (/([zZ]|[+-]\d{2}:?\d{2})$/.test(raw) ? "" : "Z");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return receivedAt.slice(0, 10);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(d);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The outcome sentence and, when the live sheet needs a look, a warning. Pure. */
export function describeReadOutcome(data: ReadData): { text: string; warn: string | null } {
  let text: string;
  if (data.status === "hit") text = "Added figures.";
  else if (data.status === "no_numbers") text = "No figures found.";
  else if (data.bogeysStored > 0) text = "Added figures from the text; some images could not be read. Try again later for them.";
  else text = "Some images could not be read and the text had no figures. Try again later.";

  let warn: string | null = null;
  if (data.recompileFailed) {
    warn = "The live sheet was not updated. Open the bogeys box and save to update it.";
  } else if (data.recompiled && data.recompiled.conflicts.length > 0) {
    warn = `No line is compiled for ${plural(data.recompiled.conflicts.length, "metric id")} until every sheet agrees on it. Open the bogeys box to see which.`;
  }
  return { text, warn };
}

export default function UnreadPreviews({ eventId }: { eventId: number }) {
  const router = useRouter();
  const [articles, setArticles] = useState<UnreadPreview[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<number, Outcome>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/earnings/bogeys/unread?eventId=${eventId}`);
        const r = await readMutationResult<{ data?: { articles?: UnreadPreview[] } }>(res);
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(r.message);
          return;
        }
        setArticles(Array.isArray(r.data.data?.articles) ? r.data.data.articles : []);
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError(networkFailureMessage("load the previews not read for bogeys"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  async function read(articleId: number) {
    setOutcomes((o) => ({ ...o, [articleId]: { kind: "running" } }));
    try {
      const res = await apiFetch("/api/earnings/bogeys/read-article", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, articleId }),
      });
      const r = await readMutationResult<{ data?: ReadData }>(res);
      if (!r.ok || !r.data.data) {
        setOutcomes((o) => ({
          ...o,
          [articleId]: { kind: "error", text: r.ok ? "The server sent no result. Try again." : r.message },
        }));
        return;
      }
      setOutcomes((o) => ({ ...o, [articleId]: { kind: "done", ...describeReadOutcome(r.data.data!) } }));
      router.refresh();
    } catch {
      setOutcomes((o) => ({ ...o, [articleId]: { kind: "error", text: networkFailureMessage("read that preview") } }));
    }
  }

  if (loadError) {
    return (
      <p className="px-5 py-1.5 text-[12px] text-ink-dim" role="status">
        {loadError}
      </p>
    );
  }
  if (!articles || articles.length === 0) return null;

  const waiting = articles.filter((a) => outcomes[a.articleId]?.kind !== "done").length;
  const listId = `unread-previews-${eventId}`;

  return (
    <div className="px-5 py-1.5 text-[12px] border-t border-edge/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className={`font-medium rounded px-1 -mx-1 ${CHIP_TONE_TEXT.gold} ${GOLD_OUTLINE_HOVER} relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2`}
      >
        {waiting === 0
          ? `${plural(articles.length, "preview")} read for bogeys`
          : `${plural(waiting, "preview")} not read for bogeys`}
        {open ? " · hide" : " · show"}
      </button>
      {open && (
        <ul id={listId} className="mt-1.5 flex flex-col gap-1.5">
          {articles.map((a) => {
            const outcome = outcomes[a.articleId];
            const running = outcome?.kind === "running";
            return (
              <li key={a.articleId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                <span className="text-ink-dim whitespace-nowrap">{a.sourceName}</span>
                <span className="text-ink truncate min-w-0 max-w-full sm:max-w-[28rem]" title={a.subject}>
                  {a.subject || "(no subject)"}
                </span>
                <span className="text-ink-dim font-mono whitespace-nowrap">{shortEasternDate(a.receivedAt)}</span>
                {!outcome && (
                  <span className={`whitespace-nowrap ${a.state === "read_failed" ? CHIP_TONE_TEXT.warn : "text-ink-dim"}`}>
                    {STATE_LABEL[a.state]}
                  </span>
                )}
                {a.state !== "reading" && outcome?.kind !== "done" && (
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => read(a.articleId)}
                    className={`font-medium whitespace-nowrap rounded px-1 -mx-1 ${CHIP_TONE_TEXT.gold} ${GOLD_OUTLINE_HOVER} disabled:cursor-wait relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-3 pointer-coarse:after:-inset-x-2`}
                  >
                    {running ? "Reading…" : "Read for bogeys"}
                  </button>
                )}
                {outcome?.kind === "done" && (
                  <span className="basis-full text-ink" role="status">
                    {outcome.text}
                    {outcome.warn && <span className={`block ${CHIP_TONE_TEXT.warn}`}>{outcome.warn}</span>}
                  </span>
                )}
                {outcome?.kind === "error" && (
                  <span className={`basis-full ${CHIP_TONE_TEXT.down}`} role="alert">
                    {outcome.text}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
