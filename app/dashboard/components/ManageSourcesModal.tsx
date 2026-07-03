"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ResearchSource } from "@/lib/queries/research";
import { ConfirmDialog } from "./ConfirmDialog";

interface DiscoveredSender {
  email: string;
  name: string;
  messageCount: number;
  latestSubject: string;
  latestDate: string;
}

interface Props {
  initialSources: ResearchSource[];
  open: boolean;
  onClose: () => void;
  onSourcesChanged: () => void;
}

export function ManageSourcesModal({
  initialSources,
  open,
  onClose,
  onSourcesChanged,
}: Props) {
  const [sources, setSources] = useState(initialSources);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredSender[]>([]);
  const [showDiscover, setShowDiscover] = useState(false);
  const [addedEmails, setAddedEmails] = useState<Set<string>>(new Set());
  const [showManual, setShowManual] = useState(false);
  const manualFormRef = useRef<HTMLDivElement>(null);
  const [manualName, setManualName] = useState("");
  const [manualEmail, setManualEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  // One shared error line for toggle/delete/add mutations — without it a
  // failed write looks identical to a successful one (optimistic UI).
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Sync local sources when prop changes (e.g., modal reopens)
  useEffect(() => {
    setSources(initialSources);
  }, [initialSources]);

  const existingEmails = new Set(
    sources.map((s) => s.sender_email?.toLowerCase()).filter(Boolean)
  );

  const handleToggle = useCallback(
    async (sourceId: number, currentActive: number) => {
      const newActive = currentActive ? 0 : 1;
      // Optimistic update
      setMutationError(null);
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, is_active: newActive } : s))
      );
      try {
        const res = await fetch("/api/research/sources", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sourceId, is_active: newActive }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.success === false) {
          throw new Error(data?.error ?? `server returned ${res.status}`);
        }
        onSourcesChanged();
      } catch (err) {
        // Revert on failure — and say so, or the flipped toggle lies
        setSources((prev) =>
          prev.map((s) =>
            s.id === sourceId ? { ...s, is_active: currentActive } : s
          )
        );
        setMutationError(
          `Couldn't update the source: ${err instanceof Error ? err.message : "network error"}. The toggle was reverted.`
        );
      }
    },
    [onSourcesChanged]
  );

  const handleToggleOffTopic = useCallback(
    async (sourceId: number, currentValue: number | null) => {
      const newValue = currentValue === 1 ? 0 : 1;
      setMutationError(null);
      setSources((prev) =>
        prev.map((s) => (s.id === sourceId ? { ...s, allow_off_topic: newValue } : s))
      );
      try {
        const res = await fetch("/api/research/sources", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sourceId, allow_off_topic: newValue }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.success === false) {
          throw new Error(data?.error ?? `server returned ${res.status}`);
        }
        onSourcesChanged();
      } catch (err) {
        setSources((prev) =>
          prev.map((s) =>
            s.id === sourceId ? { ...s, allow_off_topic: currentValue } : s
          )
        );
        setMutationError(
          `Couldn't update the off-topic setting: ${err instanceof Error ? err.message : "network error"}. The toggle was reverted.`
        );
      }
    },
    [onSourcesChanged]
  );

  const handleDelete = useCallback(
    async (sourceId: number) => {
      setMutationError(null);
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
      try {
        const res = await fetch("/api/research/sources", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: sourceId }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.success === false) {
          throw new Error(data?.error ?? `server returned ${res.status}`);
        }
        onSourcesChanged();
      } catch (err) {
        // Refetch on failure so the row reappears — and explain why
        setMutationError(
          `Couldn't delete the source: ${err instanceof Error ? err.message : "network error"}.`
        );
        const res = await fetch("/api/research/sources").catch(() => null);
        const data = await res?.json().catch(() => null);
        if (data?.success) setSources(data.data);
      }
    },
    [onSourcesChanged]
  );

  const handleDiscover = useCallback(async () => {
    setDiscovering(true);
    setShowDiscover(true);
    setDiscoverError(null);
    try {
      const res = await fetch("/api/research/discover", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setDiscovered(data.data);
      } else {
        setDiscoverError(data.error || "Discovery failed");
      }
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : "Failed to connect to Gmail");
    } finally {
      setDiscovering(false);
    }
  }, []);

  const handleAddDiscovered = useCallback(
    async (sender: DiscoveredSender) => {
      setAdding(true);
      try {
        const res = await fetch("/api/research/sources", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: sender.name || sender.email.split("@")[0],
            sender_email: sender.email,
          }),
        });
        const data = await res.json();
        if (data.success) {
          setAddedEmails((prev) => new Set([...prev, sender.email.toLowerCase()]));
          // Refresh sources
          const srcRes = await fetch("/api/research/sources");
          const srcData = await srcRes.json();
          if (srcData.success) setSources(srcData.data);
          onSourcesChanged();
        } else {
          setMutationError(`Couldn't add ${sender.email}: ${data.error ?? "unknown error"}.`);
        }
      } catch {
        setMutationError(`Couldn't add ${sender.email}: could not reach the server.`);
      } finally {
        setAdding(false);
      }
    },
    [onSourcesChanged]
  );

  const handleAddManual = useCallback(async () => {
    if (!manualName.trim() || !manualEmail.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/research/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: manualName.trim(),
          sender_email: manualEmail.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        setManualName("");
        setManualEmail("");
        setShowManual(false);
        // Refresh sources
        const srcRes = await fetch("/api/research/sources");
        const srcData = await srcRes.json();
        if (srcData.success) setSources(srcData.data);
        onSourcesChanged();
      } else {
        setMutationError(`Couldn't add the source: ${data.error ?? "unknown error"}.`);
      }
    } catch {
      setMutationError("Couldn't add the source: could not reach the server.");
    } finally {
      setAdding(false);
    }
  }, [manualName, manualEmail, onSourcesChanged]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-none" />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-edge bg-panel shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-edge bg-panel/95 backdrop-blur-sm rounded-t-xl">
          <h2 className="text-sm font-medium text-ink">Manage Sources</h2>
          <button
            onClick={onClose}
            className="text-ink-faint hover:text-ink text-xs"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Current sources */}
          <div className="space-y-2">
            <p className="text-xs text-ink-faint uppercase tracking-wider">
              Newsletter Sources
            </p>
            {sources.length === 0 ? (
              <p className="text-sm text-ink-dim py-2">
                No sources configured yet.
              </p>
            ) : (
              <div className="space-y-1">
                {sources.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-raised/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink">
                        {s.name}
                      </div>
                      {s.sender_email ? (
                        <div className="text-xs text-ink-faint font-mono truncate">
                          {s.sender_email}
                        </div>
                      ) : (
                        <div className="text-xs text-down/80">
                          No email configured — use Discover or edit to add one
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {s.article_count != null && s.article_count > 0 && (
                        <span className="text-xs text-ink-faint tabular-nums">
                          {s.article_count}
                        </span>
                      )}
                      {/* Off-topic filter exemption (migration 055 allow_off_topic) */}
                      <button
                        onClick={() => handleToggleOffTopic(s.id, s.allow_off_topic ?? 0)}
                        className={`text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors ${
                          s.allow_off_topic === 1
                            ? "border-gold/40 text-gold bg-gold/10"
                            : "border-edge text-ink-faint hover:text-ink-dim"
                        }`}
                        title={
                          s.allow_off_topic === 1
                            ? "Off-topic exemption ON — everything from this source reaches digests, even articles the AI votes not portfolio-relevant. Click to re-enable filtering."
                            : "Off-topic exemption OFF — articles the AI votes not portfolio-relevant are excluded from digests (visible under Research → Feeds → Filtered). Click to keep everything from this source."
                        }
                      >
                        off-topic OK
                      </button>
                      {/* Toggle */}
                      <button
                        onClick={() => handleToggle(s.id, s.is_active)}
                        className={`relative w-9 h-5 rounded-full transition-colors ${
                          s.is_active ? "bg-gold" : "bg-muted"
                        }`}
                      >
                        <div
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                            s.is_active ? "translate-x-4" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                      {/* Delete — only for sources with no articles.
                          Confirm first, matching the Notes/Documents delete
                          flows (deep-QA: instant delete was jarring). */}
                      {(!s.article_count || s.article_count === 0) && (
                        <button
                          onClick={() => setPendingDeleteId(s.id)}
                          className="text-ink-faint hover:text-down transition-colors"
                          title="Delete source"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {mutationError && (
            <p className="text-xs text-down px-1">{mutationError}</p>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleDiscover}
              disabled={discovering}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-gold/40 text-gold hover:bg-gold/10 transition-colors disabled:opacity-50"
            >
              {discovering ? (
                <div className="w-3.5 h-3.5 border-2 border-gold border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
              )}
              Discover from Gmail
            </button>
            <button
              onClick={() => {
                setShowManual(!showManual);
                if (!showManual) {
                  setTimeout(() => manualFormRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-edge text-ink-dim hover:text-ink hover:bg-raised transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add Manually
            </button>
          </div>

          {/* Manual add form */}
          {showManual && (
            <div ref={manualFormRef} className="space-y-2 p-3 rounded-lg border border-edge bg-raised/50">
              <input
                type="text"
                placeholder="Source name (e.g. Morning Brew)"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-canvas border border-edge text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold"
              />
              <input
                type="email"
                placeholder="Sender email (e.g. newsletter@morningbrew.com)"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-canvas border border-edge text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold"
              />
              <button
                onClick={handleAddManual}
                disabled={adding || !manualName.trim() || !manualEmail.trim()}
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add Source
              </button>
            </div>
          )}

          {/* Discover results */}
          {showDiscover && (() => {
            const newSenders = discovered.filter(
              (s) =>
                !existingEmails.has(s.email.toLowerCase()) &&
                !addedEmails.has(s.email.toLowerCase())
            );
            const alreadyAddedCount = discovered.length - newSenders.length;

            return (
              <div className="space-y-2">
                <p className="text-xs text-ink-faint uppercase tracking-wider">
                  Found in Gmail
                </p>
                {discovering ? (
                  <div className="flex items-center gap-2 py-4 justify-center text-sm text-ink-dim">
                    <div className="w-4 h-4 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
                    Scanning Gmail...
                  </div>
                ) : discoverError ? (
                  <div className="px-3 py-2.5 rounded-lg bg-down/10 border border-down/30 text-sm text-down">
                    {discoverError}
                  </div>
                ) : discovered.length === 0 ? (
                  <div className="px-3 py-2.5 rounded-lg bg-raised/50 text-sm text-ink-dim space-y-1">
                    <div>Scanned Gmail — no newsletter senders found in the last 90 days.</div>
                    <div className="text-xs text-ink-faint">
                      Discovery looks for emails with an &ldquo;unsubscribe&rdquo; link. Senders without one won&rsquo;t appear — use &ldquo;Add Manually&rdquo; instead.
                    </div>
                  </div>
                ) : newSenders.length === 0 ? (
                  <div className="px-3 py-2.5 rounded-lg bg-raised/50 text-sm text-ink-dim space-y-1">
                    <div>
                      Scanned {discovered.length} sender{discovered.length === 1 ? "" : "s"} — all are already in your list.
                    </div>
                    <div className="text-xs text-ink-faint">
                      Use &ldquo;Add Manually&rdquo; for any newsletter that doesn&rsquo;t have an unsubscribe link.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-ink-faint">
                      {newSenders.length} new sender{newSenders.length === 1 ? "" : "s"}
                      {alreadyAddedCount > 0 && ` · ${alreadyAddedCount} already in list`}
                    </p>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {newSenders.map((sender) => (
                        <div
                          key={sender.email}
                          className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-raised/50"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-ink">
                              {sender.name}
                            </div>
                            <div className="text-xs text-ink-faint font-mono truncate">
                              {sender.email}
                            </div>
                            <div className="text-xs text-ink-faint mt-0.5 truncate">
                              {sender.messageCount} emails &middot; {sender.latestSubject}
                            </div>
                          </div>
                          <button
                            onClick={() => handleAddDiscovered(sender)}
                            disabled={adding}
                            className="shrink-0 px-2.5 py-1 rounded-md text-xs font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-50"
                          >
                            Add
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 px-5 py-3 border-t border-edge bg-panel/95 backdrop-blur-sm rounded-b-xl">
          <button
            onClick={onClose}
            className="w-full px-3 py-2 rounded-md text-sm font-medium border border-edge text-ink hover:bg-raised transition-colors"
          >
            Done
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="Delete source"
        message="Are you sure you want to remove this newsletter source? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          const id = pendingDeleteId;
          setPendingDeleteId(null);
          if (id !== null) void handleDelete(id);
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
