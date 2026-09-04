"use client";

/**
 * The manual acquisition controls for one print (slice C's two buttons, moved
 * out of `PrintWatchPanel.tsx`, plus the NEW paste box).
 *
 * "Print is live" and "Extend 30 min" are verbatim moves. What is new is the
 * paste box: contract §4 lets the desk hand the release over directly, either
 * as a link (`{ eventId, url }`) or as the file itself
 * (`{ eventId, contentBase64, filename }`), through the SAME
 * `POST /api/print-watch/go` the buttons use.
 *
 * Every rule about what may be pressed — https only, SSRF-safe host, no
 * secret-bearing query key, under 10 MB, readable — lives in `requestGo` on
 * the server. This box never second-guesses it: it posts, and it renders the
 * server's refusal verbatim. Re-implementing half the rule here would produce
 * a control that refuses things the server would take and accepts things it
 * would not.
 *
 * The file input is a native `<input type="file">` inside a `<label>` (M-F10)
 * — the idiom the panel already used, because it is the one that works on iOS
 * Safari, where the Hub is also used.
 */

import { useState } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { etClock, fileToBase64 } from "./helpers";
import type { GoRequestWire } from "../hub-live/types";

/** Which control is mid-flight — one at a time, so a second press cannot race
 *  the first and leave the desk unsure which one the note belongs to. */
type Pending = "go" | "extend" | "url" | "file" | null;

export default function GoControls({
  eventId,
  goRequest,
  hasWindow,
  onChanged,
  onNote,
  onError,
}: {
  eventId?: number;
  goRequest: GoRequestWire | null;
  hasWindow: boolean;
  onChanged: () => Promise<void>;
  onNote: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<Pending>(null);

  const noEventId = eventId === undefined;
  const busy = pending !== null;
  const goInFlight = goRequest?.status === "queued" || goRequest?.status === "claimed";

  /**
   * The ONE call site for `POST /api/print-watch/go` — the button press, a
   * pasted link and a pasted file are the same request with different bodies,
   * so they share the same 200/4xx handling and the same non-fatal-wake
   * caveat.
   *
   * The press itself commits even when the in-process wake-up throws (the go
   * route never 500s a durable row over a wake failure) — that is a soft
   * warning, not a failure: the watcher's own cadence picks the request up on
   * its next tick.
   */
  async function postGo(body: Record<string, unknown>, okNote: string, which: Pending) {
    if (noEventId) {
      onError("This print has no event reference from the server — cannot press go.");
      return;
    }
    setPending(which);
    try {
      const res = await apiFetch("/api/print-watch/go", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { requestId: number; wakeError?: string | null } }
        | null;
      if (!res.ok || !data?.success) {
        onError(data?.error ?? `Go failed (HTTP ${res.status}).`);
        return;
      }
      onNote(
        data.data?.wakeError
          ? `${okNote} Could not wake the watcher immediately (${data.data.wakeError}) — it will pick this up on its next poll.`
          : okNote,
      );
      setUrl("");
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Go failed.");
    } finally {
      setPending(null);
    }
  }

  const handleGo = () =>
    void postGo({ eventId }, "Print is live — acquiring from every road now.", "go");

  const submitUrl = () => {
    if (url.trim() === "") {
      onError("Paste the release link first — an empty box has nothing to fetch.");
      return;
    }
    void postGo({ eventId, url: url.trim() }, "Link accepted — acquiring now.", "url");
  };

  const submitFile = async (file: File) => {
    try {
      const contentBase64 = await fileToBase64(file);
      await postGo({ eventId, contentBase64, filename: file.name }, "File accepted — parsing now.", "file");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not read that file.");
    }
  };

  async function handleExtend() {
    if (noEventId) {
      onError("This print has no event reference from the server — cannot extend.");
      return;
    }
    setPending("extend");
    try {
      const res = await apiFetch("/api/print-watch/extend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { windowExtendedUntil: string; wakeError?: string | null } }
        | null;
      if (!res.ok || !data?.success || !data.data) {
        onError(data?.error ?? `Extend failed (HTTP ${res.status}).`);
        return;
      }
      const base = `Window extended to ${etClock(data.data.windowExtendedUntil)}.`;
      // Same non-fatal-wake caveat as the go press — the extension itself is
      // durable even when the in-process nudge fails.
      onNote(
        data.data.wakeError
          ? `${base} Could not wake the watcher immediately (${data.data.wakeError}) — it will pick this up on its next poll.`
          : base,
      );
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Extend failed.");
    } finally {
      setPending(null);
    }
  }

  const disabledTitle = noEventId
    ? "This print has no event reference from the server — cannot press go."
    : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={handleGo}
        disabled={busy || noEventId || goInFlight}
        className="text-[12px] font-mono border border-edge rounded px-2 py-1 hover:bg-raised disabled:opacity-60"
        title={
          disabledTitle ??
          (goInFlight
            ? "A go request is already in flight for this print."
            : "Acquire from every road now and open the window if it is not open")
        }
      >
        {pending === "go" ? "Pressing…" : "Print is live"}
      </button>

      {hasWindow && (
        <button
          type="button"
          onClick={handleExtend}
          disabled={busy || noEventId}
          className="text-[12px] font-mono border border-edge rounded px-2 py-1 hover:bg-raised disabled:opacity-60"
          title={disabledTitle ?? "Keep polling 30 minutes longer (presses stack)"}
        >
          {pending === "extend" ? "Extending…" : "Extend 30 min"}
        </button>
      )}

      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitUrl();
          }
        }}
        placeholder="Paste the release link"
        disabled={busy || noEventId}
        className="w-[20rem] max-w-full bg-raised border border-edge rounded px-2 py-1 font-mono text-[12px] text-ink focus:outline-none focus:border-gold disabled:opacity-60"
        aria-label="Paste the release link"
      />
      <button
        type="button"
        onClick={submitUrl}
        disabled={busy || noEventId || url.trim() === ""}
        className="text-[12px] font-mono border border-edge rounded px-2 py-1 hover:bg-raised disabled:opacity-60"
        title={
          disabledTitle ??
          (url.trim() === ""
            ? "Paste the release link first."
            : "Press go with this link — opens the window if it is closed, fetches the page and reads it as the release")
        }
      >
        {pending === "url" ? "Fetching…" : "Use link"}
      </button>

      <label
        className={`relative text-[12px] font-mono border border-edge rounded px-2 py-1 cursor-pointer hover:bg-raised pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 ${
          busy || noEventId ? "opacity-60 pointer-events-none" : ""
        }`}
        title={
          disabledTitle ??
          "Press go with a saved file (HTML, text or PDF) — opens the window if it is closed, then parses it. The drop zone above ingests a document into an already-open print."
        }
      >
        {pending === "file" ? "Reading…" : "⇪ Paste file"}
        <input
          type="file"
          accept=".html,.htm,.txt,.pdf,text/html,text/plain,application/pdf"
          className="hidden"
          disabled={busy || noEventId}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void submitFile(file);
          }}
        />
      </label>
    </div>
  );
}
