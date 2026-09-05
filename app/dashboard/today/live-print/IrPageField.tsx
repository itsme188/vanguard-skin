"use client";

import { useEffect, useState } from "react";
import apiFetch from "@/lib/http/apiFetch";

/**
 * The first UI for /api/print-watch/sources (M-F16). Slice B shipped the route
 * with zero callers, and its PUT treats an empty url as CLEAR — so this control
 * must never present an empty box it did not first prove is empty. It loads,
 * shows what is stored, and keeps Save disabled until it knows.
 *
 * Four states, all of them honest:
 *   loading   — inputs disabled, placeholder says so, both buttons disabled.
 *   loaded, a row stored  — the stored url and filter are in the boxes, Save
 *                           and "clear the stored page" both live.
 *   loaded, nothing stored — empty boxes, Save live once something is typed,
 *                           clear disabled with a title saying why.
 *   refused   — the read failed: the field stays UNLOADED, so no write can be
 *               made over a configuration this control never saw, and it SAYS
 *               so (review I-1). It used to wear the loading state's copy —
 *               "loading…" in the box, "Reading what is stored…" on Save —
 *               which claimed a read was still in flight forever after it had
 *               already failed. It now names the failure and offers "retry the
 *               read", so the desk is not left collapsing and re-expanding the
 *               row to get a second attempt.
 */
export default function IrPageField({
  symbol,
  onNote,
  onError,
}: {
  symbol: string;
  onNote: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  /** The read was attempted and REFUSED — distinct from "not loaded yet", which
   *  is what the copy used to conflate (I-1). */
  const [readFailed, setReadFailed] = useState(false);
  /** Bumped by "retry the read"; the effect keys on it, so a retry is one more
   *  run of the same read rather than a second code path. */
  const [attempt, setAttempt] = useState(0);
  const [hasStored, setHasStored] = useState(false);
  const [value, setValue] = useState("");
  const [mustContain, setMustContain] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setLoaded(false);
    setReadFailed(false);
    (async () => {
      try {
        const res = await apiFetch(`/api/print-watch/sources?symbol=${encodeURIComponent(symbol)}`, {
          signal: ac.signal,
        });
        const data = (await res.json().catch(() => null)) as
          | { success?: boolean; error?: string; data?: { irPageUrl: string; linkMustContain: string | null } | null }
          | null;
        if (ac.signal.aborted) return;
        if (!res.ok || !data?.success) {
          setReadFailed(true);
          onError(data?.error ?? `Could not read the stored IR page (HTTP ${res.status}).`);
          return; // stays UNLOADED, so Save stays disabled
        }
        setHasStored(data.data != null);
        setValue(data.data?.irPageUrl ?? "");
        setMustContain(data.data?.linkMustContain ?? "");
        setLoaded(true);
      } catch (err) {
        if (ac.signal.aborted) return;
        setReadFailed(true);
        onError(err instanceof Error ? err.message : "Could not reach the server for the stored IR page.");
      }
    })();
    return () => ac.abort();
    // `onError` is a dependency by the rules of hooks; LivePrintRow hands down
    // a `useCallback`-stable setter for exactly that reason, so this read runs
    // once per symbol and not once per poll tick.
  }, [symbol, onError, attempt]);

  async function put(body: Record<string, unknown>, describe: (cleared: boolean | undefined) => string) {
    setBusy(true);
    try {
      const res = await apiFetch("/api/print-watch/sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { symbol: string; cleared?: boolean } }
        | null;
      if (!res.ok || !data?.success) {
        onError(data?.error ?? `Could not save the IR page (HTTP ${res.status}).`);
        return;
      }
      onNote(describe(data.data?.cleared));
      setHasStored(data.data?.cleared === true ? false : true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    void put(
      { symbol, irPageUrl: value.trim(), ...(mustContain.trim() ? { linkMustContain: mustContain.trim() } : {}) },
      () => `Saved — the IR lane will scan this page for ${symbol} from the next poll.`,
    );

  /** Clearing is its OWN button. An empty Save used to mean "clear", which is a
   *  destructive action hiding inside a save. */
  const clear = () =>
    void put({ symbol, irPageUrl: "" }, (cleared) =>
      cleared === false
        ? `No IR page was stored for ${symbol}, so nothing was cleared.`
        : `Cleared the stored IR page for ${symbol} — the IR lane will stop polling it.`,
    );

  return (
    <div className="flex flex-wrap items-end gap-2 text-[12px]">
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">IR page</span>
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            loaded
              ? "https://investors.example.com/news"
              : readFailed
                ? "could not read what is stored"
                : "loading…"
          }
          disabled={!loaded || busy}
          className="w-[22rem] max-w-full bg-raised border border-edge rounded px-2 py-1 font-mono text-[12px] text-ink focus:outline-none focus:border-gold"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">Link must contain</span>
        <input
          type="text"
          value={mustContain}
          onChange={(e) => setMustContain(e.target.value)}
          placeholder={readFailed ? "could not read what is stored" : "press-release"}
          disabled={!loaded || busy}
          className="w-[11rem] max-w-full bg-raised border border-edge rounded px-2 py-1 font-mono text-[12px] text-ink focus:outline-none focus:border-gold"
        />
      </label>
      <button
        type="button"
        onClick={save}
        disabled={!loaded || busy || value.trim() === ""}
        title={
          readFailed
            ? "Save is disabled because the stored value could not be read — saving now would overwrite a configuration this field never saw. Retry the read first."
            : !loaded
              ? "Reading what is stored for this symbol…"
              : value.trim() === ""
                ? "Type a page address, or use “clear the stored page”."
                : "Save this IR page"
        }
        className="border border-edge rounded px-2 py-1 text-ink-dim hover:text-gold disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={clear}
        disabled={!loaded || busy || !hasStored}
        title={
          readFailed
            ? "Could not read what is stored for this symbol — retry the read first."
            : !hasStored
              ? "Nothing is stored for this symbol."
              : "Remove the stored IR page"
        }
        className="border border-edge rounded px-2 py-1 text-ink-faint hover:text-down disabled:opacity-50"
      >
        clear the stored page
      </button>
      {readFailed && (
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          disabled={busy}
          title="Read the stored IR page for this symbol again"
          className="border border-edge rounded px-2 py-1 text-ink-dim hover:text-gold disabled:opacity-50"
        >
          retry the read
        </button>
      )}
    </div>
  );
}
