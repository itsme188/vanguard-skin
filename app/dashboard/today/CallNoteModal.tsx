"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const GUIDANCE_OPTIONS = [
  { value: "raised", label: "Raised" },
  { value: "inline", label: "In line" },
  { value: "lowered", label: "Lowered" },
  { value: "not_given", label: "Not given" },
] as const;

type Guidance = (typeof GUIDANCE_OPTIONS)[number]["value"];

interface Props {
  eventId: number;
  symbol: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function CallNoteModal({ eventId, symbol, open, onClose, onSaved }: Props) {
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [tone, setTone] = useState("");
  const [surprises, setSurprises] = useState("");
  const [followUps, setFollowUps] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setGuidance(null);
    setTone("");
    setSurprises("");
    setFollowUps("");
    setLoading(true);
    fetch(`/api/earnings/call-notes?eventId=${eventId}`)
      .then((r) => r.json() as Promise<{ success: boolean; data?: { guidance: Guidance | null; tone: string | null; surprises: string | null; follow_ups: string | null } | null; error?: string }>)
      .then((json) => {
        if (cancelled) return;
        if (json.success && json.data) {
          setGuidance(json.data.guidance ?? null);
          setTone(json.data.tone ?? "");
          setSurprises(json.data.surprises ?? "");
          setFollowUps(json.data.follow_ups ?? "");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't load the existing note — saving will overwrite.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, eventId]);

  if (!open || typeof document === "undefined") return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/earnings/call-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, guidance, tone, surprises, followUps }),
      });
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? `Save failed (HTTP ${res.status}).`);
        return; // honest feedback: modal stays open, error visible
      }
      onSaved();
      onClose();
    } catch {
      setError("Save failed — network error. Your text is still here; try again.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="relative w-full max-w-md max-h-[85dvh] overflow-y-auto rounded-xl bg-panel p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-ink">{symbol} — call notes</h3>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Feeds tonight&apos;s recap email and next quarter&apos;s preview.
        </p>

        <div className="mt-3">
          <span className="text-[11px] uppercase tracking-wide text-ink-faint">
            Guidance
          </span>
          <div className="mt-1 flex gap-1">
            {GUIDANCE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() =>
                  setGuidance(guidance === opt.value ? null : opt.value)
                }
                className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  guidance === opt.value
                    ? "bg-gold/20 text-gold-ink"
                    : "bg-raised text-ink-dim hover:text-ink"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {(
          [
            [
              "Management tone",
              tone,
              setTone,
              "Confident? Defensive? What stood out on the call.",
            ],
            [
              "Surprises",
              surprises,
              setSurprises,
              "Anything the bogeys didn't prepare you for.",
            ],
            [
              "Follow-ups",
              followUps,
              setFollowUps,
              "What to check before next quarter.",
            ],
          ] as const
        ).map(([label, value, setter, placeholder]) => (
          <label key={label} className="mt-3 block">
            <span className="text-[11px] uppercase tracking-wide text-ink-faint">
              {label}
            </span>
            <textarea
              value={value}
              onChange={(e) => setter(e.target.value)}
              placeholder={placeholder}
              rows={2}
              className="mt-1 w-full rounded-lg border border-edge bg-canvas p-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-gold"
            />
          </label>
        ))}

        {error && <p className="mt-2 text-[12px] text-down">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="relative rounded-lg px-3 py-1.5 text-[13px] text-ink-dim hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="relative rounded-lg bg-gold px-3 py-1.5 text-[13px] font-medium text-canvas disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
          >
            {saving ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
