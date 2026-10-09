"use client";

import { GOLD_FILL_CLASSES } from "@/app/dashboard/components/chip-tone-text";
import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { NoteWithContext, EarningsTimelineEntry } from "@/lib/queries/notes";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";
import { NOTE_TYPES, NOTE_SENTIMENTS } from "@/lib/types";
import type { NoteType, NoteSentiment } from "@/lib/types";
import { coerceNoteType, coerceNoteSentiment } from "@/lib/notes/coerce";
import { todayET } from "@/lib/calendar/date-utils";
import { TranscriptCard, FetchTranscriptButton } from "./TranscriptCard";
import { SymbolLink } from "./SymbolLink";
// Group headers count calls and filings separately — an edgar_8k row on this
// wall is an SEC 8-K press release, and the cards beside it already say so.
import { transcriptCountLabel } from "@/lib/transcripts/presentation";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import apiFetch from "@/lib/http/apiFetch";
import { PrivateText } from "@/lib/privacy/components";
import {
  isSelectableNoteSecurity,
  defaultPickerSecurities,
  searchPickerSecurities,
  type PickerTier,
  type TieredPickerSecurity,
} from "@/lib/notes/security-picker";
import { describeNoteSaveFailure } from "@/lib/notes/save-failure-copy";
import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import {
  NotesDraftRecovery,
  mergeDraftIntoComposer,
  clearAmbientDraftIfSaved,
} from "./NotesDraftRecovery";

// ─── Props ───────────────────────────────────────────────────────

interface NotesViewProps {
  initialNotes: NoteWithContext[];
  earningsTimeline: EarningsTimelineEntry[];
  transcriptSummaries: TranscriptSummaryEntry[];
  /**
   * Every ticker that has a cached transcript — the UNFILTERED set, unlike
   * `transcriptSummaries` (the search-filtered wall). The "Fetch <TICKER>
   * Transcript" buttons are its complement, so it must not shrink when a
   * filter is active.
   */
  transcriptTickers: string[];
  securities: PickerSecurity[];
  currentType: NoteType | null;
  currentSearch: string | null;
}

/**
 * A row of the security list the page hands over. `security_type` is
 * optional: when the page supplies it, the transcript fetch wall offers
 * stocks only (a fund or an ETF never holds an earnings call).
 */
export interface PickerSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type?: string | null;
  /** held / watch / other; absent on rows from older callers (treated as held). */
  tier?: PickerTier;
}

// ─── Constants ───────────────────────────────────────────────────

// "Stock Note" is the broadened presentation of the trade_thesis note type
// (2026-06-09 rework): position notes, thesis updates, "why I'm watching
// this" — anything stock-specific that isn't earnings. Journal is reserved
// for market & trading psychology. The DB value stays trade_thesis (schema
// CHECK constraint; existing rows keep working).
//
// ONE label per note type (owner ruling 2026-09-02): the filter tab, the
// composer option and the card badge all read from this map, so a note
// saved as "Stock Note" is badged "Stock Note".
export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  journal: "Journal",
  earnings: "Earnings",
  trade_thesis: "Stock Note",
};

/** The user-facing name of a stored note_type; an unknown value is humanized. */
export function noteTypeLabel(raw: string): string {
  const type = coerceNoteType(raw);
  return type ? NOTE_TYPE_LABELS[type] : raw.replace(/_/g, " ");
}

const TYPE_OPTIONS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  ...NOTE_TYPES.map((value) => ({ label: NOTE_TYPE_LABELS[value], value })),
];

const SENTIMENT_OPTIONS: { label: string; value: NoteSentiment }[] =
  NOTE_SENTIMENTS.map((value) => ({
    label: value.charAt(0).toUpperCase() + value.slice(1),
    value,
  }));

const SENTIMENT_STYLES: Record<string, string> = {
  bullish: CHIP_TONE_CLASSES.up,
  bearish: CHIP_TONE_CLASSES.down,
  neutral: "bg-muted text-ink-dim",
  cautious: CHIP_TONE_CLASSES.gold,
  confident: "bg-blue/20 text-blue",
};

// Rows the transcript wall adds per "Load more" — the server page's own size.
const TRANSCRIPT_PAGE_SIZE = 50;

const TYPE_BORDER: Record<string, string> = {
  journal: "border-l-gold",
  earnings: "border-l-blue",
  trade_thesis: "border-l-up",
};

// ─── Pure helpers (exported for tests) ───────────────────────────

/** The fields the composer collects. The note editor edits the same set. */
export interface NoteDraft {
  type: NoteType;
  content: string;
  symbol: string;
  date: string;
  sentiment: NoteSentiment | "";
  tags: string;
}

/** `notes.tags` is a JSON array in a TEXT column; anything else reads as no tags. */
export function parseNoteTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** A saved note as the editor's starting draft. */
export function draftFromNote(note: NoteWithContext): NoteDraft {
  return {
    type: coerceNoteType(note.note_type) ?? "journal",
    content: note.content,
    symbol: note.symbol ?? "",
    date: note.event_date,
    sentiment: coerceNoteSentiment(note.sentiment) ?? "",
    tags: parseNoteTags(note.tags).join(", "),
  };
}

export interface NoteUpdateBody {
  id: number;
  content: string;
  event_date?: string;
  tags: string[] | null;
  sentiment: NoteSentiment | null;
  note_type?: NoteType;
  security_id?: number | null;
}

/**
 * The PUT /api/notes body for an edit, or null when the text is empty.
 *
 * `note_type` and `security_id` are sent ONLY when the edit changed them, so
 * a body-only edit can never move a note. Journal follows the composer's
 * rule (a journal entry carries no security): switching a note TO journal
 * clears its security, while a note that already was a journal entry keeps
 * whatever link it has — its security control is not on screen.
 * An emptied date is left out: the server reads that as "leave unchanged".
 */
export function buildNoteUpdateBody(
  note: NoteWithContext,
  draft: NoteDraft,
  securities: PickerSecurity[],
): NoteUpdateBody | null {
  const content = draft.content.trim();
  if (!content) return null;

  const tags = splitTags(draft.tags);
  const body: NoteUpdateBody = {
    id: note.id,
    content,
    tags: tags.length > 0 ? tags : null,
    sentiment: draft.sentiment || null,
  };
  if (draft.date) body.event_date = draft.date;

  const typeChanged = draft.type !== note.note_type;
  if (typeChanged) body.note_type = draft.type;

  if (draft.type === "journal") {
    if (typeChanged && note.security_id != null) body.security_id = null;
  } else if (draft.symbol !== (note.symbol ?? "")) {
    if (draft.symbol === "") {
      body.security_id = null;
    } else {
      const match = securities.find((s) => s.symbol === draft.symbol);
      if (match) body.security_id = match.id;
    }
  }
  return body;
}

/**
 * Which requested changes the saved row does NOT show. The editor checks the
 * server's reply instead of assuming: a type or security change the server
 * did not apply must be reported, never shown as saved.
 */
export function unappliedNoteEdits(body: NoteUpdateBody, saved: unknown): string[] {
  const row = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const missing: string[] = [];
  if (body.note_type !== undefined && row.note_type !== body.note_type) {
    missing.push("type");
  }
  if (body.security_id !== undefined && (row.security_id ?? null) !== body.security_id) {
    missing.push("security");
  }
  return missing;
}

export const EARNINGS_NOTE_NEEDS_SECURITY =
  "An earnings note needs a security. Pick one, then save.";

/**
 * Why this draft may not be saved, or null. The Earnings tab files notes
 * under per-security headers, so an earnings note with no security would
 * save and then appear nowhere on that tab. /api/notes refuses the same
 * thing with a 400; this says so before the request is made.
 *
 * `note` is the saved note being edited. An older earnings note that never
 * had a security keeps an editable text: the edit changes neither field.
 */
export function noteDraftBlocker(
  draft: Pick<NoteDraft, "type" | "symbol">,
  note?: Pick<NoteWithContext, "note_type" | "security_id"> | null,
): string | null {
  if (draft.type !== "earnings" || draft.symbol !== "") return null;
  if (note && note.note_type === "earnings" && note.security_id == null) return null;
  return EARNINGS_NOTE_NEEDS_SECURITY;
}

export { isSelectableNoteSecurity };

/**
 * The picker's default options (held + watchlist). `keep` is the security a
 * note being edited already points at: it stays selectable even when the
 * filter would drop it, so opening the editor never silently re-files a note.
 */
export function notePickerSecurities(
  securities: PickerSecurity[],
  keep?: { id: number | null; symbol: string | null } | null,
): PickerSecurity[] {
  const tiered: TieredPickerSecurity[] = securities.map((s) => ({ ...s, tier: s.tier ?? "held" }));
  return defaultPickerSecurities(tiered, keep);
}

// A US-listed ticker: starts with a letter, at most five characters, with
// only a class separator besides letters. A placeholder "-" and a numeric
// foreign ticker both fail: the transcript sources cannot serve either.
const FETCHABLE_TICKER_RE = /^[A-Za-z][A-Za-z./-]{0,4}$/;

/**
 * Tickers offered a "Fetch <TICKER> Transcript" button: stocks with a real
 * ticker and no cached transcript. A fund or an ETF holds no earnings call,
 * so a button for one is a guaranteed dead click.
 */
export function transcriptFetchCandidates(
  securities: PickerSecurity[],
  cachedTickers: Iterable<string>,
): string[] {
  const cached = new Set<string>();
  for (const t of cachedTickers) cached.add(t.toUpperCase());
  const out = new Set<string>();
  for (const s of securities) {
    const sym = s.symbol.trim();
    if (!FETCHABLE_TICKER_RE.test(sym)) continue;
    if (s.security_type != null && s.security_type.trim().toLowerCase() !== "stock") continue;
    if (cached.has(sym.toUpperCase())) continue;
    out.add(sym);
  }
  return [...out];
}

/**
 * The security id the server filtered by, or null. Mirrors the server's gate
 * exactly: page.tsx parseInt()s the param and getNotesFiltered ignores a
 * falsy security_id, so a non-numeric ?security=NVDA filters nothing.
 */
export function parseSecurityFilterId(
  raw: string | number | null | undefined,
): number | null {
  const id = typeof raw === "number" ? raw : raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** The filtered security's symbol, from the rows already on the page. */
export function resolveSecurityFilterSymbol(
  id: number,
  securities: PickerSecurity[],
  notes: NoteWithContext[],
): string | null {
  return (
    securities.find((s) => s.id === id)?.symbol ??
    notes.find((n) => n.security_id === id)?.symbol ??
    null
  );
}

export function securityFilterChipText(symbol: string | null): string {
  return symbol ? `Filtered: ${symbol}` : "Filtered to one security";
}

/**
 * Empty-state copy when ONLY the security filter is active: it names the
 * security and the chip that clears it. Null when a search is also active
 * (the generic "no matches" copy then covers both controls) or when no
 * security filter is on.
 */
export function securityFilterEmptyCopy(opts: {
  filterActive: boolean;
  filterSymbol: string | null;
  searchActive: boolean;
  earnings?: boolean;
}): { title: string; description: string } | null {
  if (!opts.filterActive || opts.searchActive) return null;
  const noun = opts.earnings ? "earnings notes" : "notes";
  return {
    title: `No ${noun} for ${opts.filterSymbol ?? "this security"}`,
    description: `Clear the "${securityFilterChipText(opts.filterSymbol)}" chip above to see every note.`,
  };
}

/**
 * The rows a per-ticker "(2 transcripts, 1 filing)" header counts. Built
 * from the row's uncapped `ticker_sources` when the query supplied it, so a
 * ticker whose older quarters fell below the row cap is not under-counted.
 */
export function tickerCountRows(rows: TranscriptSummaryEntry[]): { source: string }[] {
  const sources = rows[0]?.ticker_sources;
  return sources
    ? sources.split(",").filter(Boolean).map((source) => ({ source }))
    : rows;
}

/** Everything a note card needs to edit or delete itself. */
interface NoteEditController {
  editingId: number | null;
  draft: NoteDraft | null;
  saving: boolean;
  securities: PickerSecurity[];
  onStart: (note: NoteWithContext) => void;
  onChange: (patch: Partial<NoteDraft>) => void;
  onCancel: () => void;
  onSave: (note: NoteWithContext) => void;
  onDelete: (id: number) => void;
}

// ─── Main Component ──────────────────────────────────────────────

export function NotesView({
  initialNotes,
  earningsTimeline,
  transcriptSummaries,
  transcriptTickers,
  securities,
  currentType,
  currentSearch,
}: NotesViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();

  // Form state — sync with active filter tab
  const [formType, setFormType] = useState<NoteType>(currentType ?? "journal");
  useEffect(() => {
    if (currentType) setFormType(currentType);
  }, [currentType]);
  const [formContent, setFormContent] = useState("");
  // ?symbol= prefill — the Security Detail "+ Add note" link lands here with
  // type+symbol preselected so a stock thought is one textarea away.
  const [formSymbol, setFormSymbol] = useState(
    () => searchParams.get("symbol")?.toUpperCase() ?? ""
  );
  const [formDate, setFormDate] = useState(() => todayET());
  const [formSentiment, setFormSentiment] = useState<NoteSentiment | "">("");
  const [formTags, setFormTags] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<NoteDraft | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ─── Live search (deep-QA finding: Enter-only read as broken) ──
  // Controlled draft + 350ms debounce → URL replace. Enter still applies
  // immediately. Skip the initial mount (and echoes of the current URL
  // value) so navigation isn't triggered by arriving with ?search= set.
  const [searchDraft, setSearchDraft] = useState(currentSearch ?? "");
  useEffect(() => {
    if (searchDraft === (currentSearch ?? "")) return;
    const t = setTimeout(() => {
      setFilter("search", searchDraft.trim(), { replace: true });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft, currentSearch]);

  // ─── Filter navigation ─────────────────────────────────────────

  function setFilter(key: string, value: string, opts?: { replace?: boolean }) {
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      // replace: live-search keystrokes shouldn't stack history entries.
      if (opts?.replace) router.replace(`?${params.toString()}`);
      else router.push(`?${params.toString()}`);
    });
  }

  // ─── Create note ───────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formContent.trim()) return;

    const blocker = noteDraftBlocker({ type: formType, symbol: formSymbol });
    if (blocker) {
      setSaveError(blocker);
      return;
    }

    setIsSaving(true);
    setSaveError(null);

    try {
      const body: Record<string, unknown> = {
        note_type: formType,
        content: formContent.trim(),
        event_date: formDate,
      };
      // Only attach `symbol` when the dropdown is actually rendered for this
      // note type — `formSymbol` state persists in React even when the
      // dropdown unmounts (e.g. user picks Earnings + CRCL, switches back
      // to Journal). Without this gate the residual symbol leaks into the
      // POST body and the server tags the journal entry with CRCL.
      if (
        formSymbol &&
        (formType === "earnings" || formType === "trade_thesis")
      ) {
        body.symbol = formSymbol;
      }
      if (formSentiment) body.sentiment = formSentiment;
      if (formTags.trim()) {
        body.tags = splitTags(formTags);
      }

      // Both awaits carry their own .catch so a failure is classified where
      // it happens: a rejected fetch is "could not reach the server", a
      // non-OK / unparseable response is "the server refused it". Neither may
      // reach the composer as a raw JS message.
      const res = await apiFetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res) {
        setSaveError(describeNoteSaveFailure({ kind: "network" }));
        return;
      }

      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: unknown }
        | null;
      if (!res.ok || !data?.success) {
        setSaveError(
          describeNoteSaveFailure({ kind: "server", status: res.status, error: data?.error }),
        );
        return;
      }

      // The save is confirmed. If it carried the whole draft the ambient
      // overlay left in this browser, that draft is now a note: drop the
      // stored copy so the recovery row goes away.
      clearAmbientDraftIfSaved(formContent.trim());

      // Reset form — all stateful fields, not just the visible ones.
      // `formSymbol` was previously missed here: a residual symbol from a
      // prior Earnings/Trade-Thesis save would carry forward into the next
      // note (visible if the user reopened the dropdown; ineffective if
      // they didn't — but the value was still in state). Belt + suspenders
      // with the gate above in case a future refactor accidentally drops
      // the build-time guard.
      // `formDate` was missed for the same reason: a back-dated note left
      // the date field stuck, so the NEXT note (a same-day journal entry
      // written right after) silently filed under the old date too.
      setFormContent("");
      setFormTags("");
      setFormSentiment("");
      setFormSymbol("");
      setFormDate(todayET());

      // Refresh page data
      startTransition(() => {
        router.refresh();
      });
    } catch {
      // Safety net only — every await above is already guarded. Whatever
      // lands here is still reported in English, never as err.message.
      setSaveError(describeNoteSaveFailure({ kind: "unknown" }));
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Update note ───────────────────────────────────────────────
  // Same shape as handleCreate: both awaits carry their own .catch so a
  // failure is classified where it happens, never surfaced as a raw
  // err.message ("Failed to fetch" / an unparseable body's SyntaxError).

  async function handleUpdate(note: NoteWithContext) {
    if (!editDraft || isSavingEdit) return;
    const blocker = noteDraftBlocker(editDraft, note);
    if (blocker) {
      toast(blocker, "error");
      return;
    }
    const body = buildNoteUpdateBody(note, editDraft, securities);
    if (!body) return;

    setIsSavingEdit(true);
    try {
      const res = await apiFetch("/api/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res) {
        toast(describeNoteSaveFailure({ kind: "network", action: "update" }), "error");
        return;
      }

      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: unknown; data?: unknown }
        | null;
      if (!res.ok || !data?.success) {
        toast(
          describeNoteSaveFailure({
            kind: "server",
            status: res.status,
            error: data?.error,
            action: "update",
          }),
          "error",
        );
        return;
      }

      setEditingId(null);
      setEditDraft(null);
      // Read the saved row back rather than assuming every field landed.
      const unapplied = unappliedNoteEdits(body, data.data);
      if (unapplied.length > 0) {
        toast(
          `The note was saved, but its ${unapplied.join(" and ")} did not change. The rest of your edit is in place.`,
          "error",
        );
      } else {
        toast("Note updated", "success");
      }
      startTransition(() => {
        router.refresh();
      });
    } catch {
      // Safety net only — every await above is already guarded.
      toast(describeNoteSaveFailure({ kind: "unknown", action: "update" }), "error");
    } finally {
      setIsSavingEdit(false);
    }
  }

  // ─── Delete note ───────────────────────────────────────────────

  async function handleDelete(id: number) {
    try {
      const res = await apiFetch(`/api/notes?id=${id}`, { method: "DELETE" }).catch(
        () => null,
      );
      if (!res) {
        toast(describeNoteSaveFailure({ kind: "network", action: "delete" }), "error");
        return;
      }

      const data = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: unknown }
        | null;
      if (!res.ok || !data?.success) {
        toast(
          describeNoteSaveFailure({
            kind: "server",
            status: res.status,
            error: data?.error,
            action: "delete",
          }),
          "error",
        );
        return;
      }

      toast("Note deleted", "success");
      startTransition(() => {
        router.refresh();
      });
    } catch {
      // Safety net only — every await above is already guarded.
      toast(describeNoteSaveFailure({ kind: "unknown", action: "delete" }), "error");
    }
  }

  // ─── Render ────────────────────────────────────────────────────

  const showEarningsView = currentType === "earnings";
  // The security filter the server actually applied (?security_id=, or
  // ?security= from the Security-detail links). NOT ?symbol=, which only
  // prefills the add-note dropdown.
  const securityFilterParam =
    searchParams.get("security_id") ?? searchParams.get("security");
  const securityFilterId = parseSecurityFilterId(securityFilterParam);
  const securityFilterSymbol =
    securityFilterId == null
      ? null
      : resolveSecurityFilterSymbol(securityFilterId, securities, initialNotes);
  const searchActive = Boolean(searchParams.get("search")?.trim());
  const listIsFiltered = notesListIsFiltered({
    search: searchParams.get("search"),
    security: securityFilterParam,
    type: searchParams.get("type"),
  });
  const filterEmptyCopy = securityFilterEmptyCopy({
    filterActive: securityFilterId != null,
    filterSymbol: securityFilterSymbol,
    searchActive,
    earnings: showEarningsView,
  });

  function clearSecurityFilter() {
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("security");
      params.delete("security_id");
      router.push(`?${params.toString()}`);
    });
  }

  const edit: NoteEditController = {
    editingId,
    draft: editDraft,
    saving: isSavingEdit,
    securities,
    onStart: (note) => {
      setEditingId(note.id);
      setEditDraft(draftFromNote(note));
    },
    onChange: (patch) => setEditDraft((d) => (d ? { ...d, ...patch } : d)),
    onCancel: () => {
      setEditingId(null);
      setEditDraft(null);
    },
    onSave: handleUpdate,
    onDelete: handleDelete,
  };

  return (
    <div className="space-y-6">
      {/* ─── Type filter pills ───────────────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Note type filter">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter("type", opt.value)}
            aria-pressed={(opt.value || null) === currentType}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap focus-ring ${
              (opt.value || null) === currentType
                ? CHIP_TONE_CLASSES.gold
                : "text-ink-faint hover:text-ink hover:bg-panel"
            }`}
          >
            {opt.label}
          </button>
        ))}
        {/* The security filter arrives by link (?security=) and has no other
            control on this page: without this chip it is invisible and
            cannot be cleared. */}
        {securityFilterId != null && (
          <button
            type="button"
            onClick={clearSecurityFilter}
            className={`inline-flex items-center gap-1.5 rounded-full ${CHIP_TONE_CLASSES.gold} px-3 py-1.5 text-sm font-medium hover:brightness-110 transition-colors focus-ring`}
            aria-label={
              securityFilterSymbol
                ? `Clear filter — showing only ${securityFilterSymbol}`
                : "Clear filter — showing only one security"
            }
            title="Clear filter"
          >
            {securityFilterChipText(securityFilterSymbol)}
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>

      {/* ─── Unsaved ambient draft ───────────────────────────────── */}
      {/* The ambient overlay is keyboard-only, so a draft it stored cannot be
          reached on a phone. This row hands it to the composer below; nothing
          is saved until Save Note is pressed. */}
      <NotesDraftRecovery
        onOpenInEditor={(text) => {
          setFormContent((prev) => mergeDraftIntoComposer(prev, text));
          setSaveError(null);
          textareaRef.current?.focus();
        }}
      />

      {/* ─── Quick-add form ──────────────────────────────────────── */}
      <form onSubmit={handleCreate} className="bg-panel border border-edge rounded-xl p-4 space-y-3">
        <NoteComposerFields
          type={formType}
          onTypeChange={(next) => {
            setFormType(next);
            // Third reset point (belt-and-suspenders-and-belt): clearing
            // formSymbol on type-switch prevents a residual ticker from
            // an Earnings/Trade-Thesis draft from leaking into a
            // subsequent Journal entry's hidden state. The build-time
            // gate in handleCreate already prevents the leak from
            // reaching the API; this just removes the latent state.
            if (next === "journal") setFormSymbol("");
            setSaveError(null);
          }}
          symbol={formSymbol}
          onSymbolChange={(next) => {
            setFormSymbol(next);
            setSaveError(null);
          }}
          date={formDate}
          onDateChange={setFormDate}
          sentiment={formSentiment}
          onSentimentChange={setFormSentiment}
          content={formContent}
          onContentChange={setFormContent}
          tags={formTags}
          onTagsChange={setFormTags}
          securities={securities}
          viaOption={searchParams.get("via") === "option"}
          textareaRef={textareaRef}
          tagsHintId="tags-hint"
        >
          {saveError && (
            <span className="text-xs text-down">{saveError}</span>
          )}
          <button
            type="submit"
            disabled={!formContent.trim() || isSaving}
            className={`px-4 py-1.5 ${GOLD_FILL_CLASSES} rounded-lg text-sm font-medium hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
          >
            {isSaving ? "Saving..." : "Save Note"}
          </button>
        </NoteComposerFields>
      </form>

      {/* ─── Search ──────────────────────────────────────────────── */}
      <div>
        <input
          type="text"
          value={searchDraft}
          placeholder="Search notes..."
          aria-label="Search notes"
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setFilter("search", (e.target as HTMLInputElement).value);
            }
          }}
          className="w-full bg-panel border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>

      {/* ─── Notes list / Earnings timeline ──────────────────────── */}
      {isPending && (
        <div className="text-center text-ink-faint text-sm py-4">Loading...</div>
      )}

      {showEarningsView ? (
        <EarningsView
          timeline={earningsTimeline}
          transcriptSummaries={transcriptSummaries}
          transcriptTickers={transcriptTickers}
          securities={securities}
          filtered={listIsFiltered}
          filterEmptyCopy={filterEmptyCopy}
          edit={edit}
          onRefresh={() => startTransition(() => router.refresh())}
        />
      ) : (
        <NotesList
          notes={initialNotes}
          filtered={listIsFiltered}
          filterEmptyCopy={filterEmptyCopy}
          edit={edit}
        />
      )}
    </div>
  );
}

// ─── Composer fields ─────────────────────────────────────────────
//
// The ONE set of note fields (type, security, date, sentiment, text, tags).
// The quick-add form and the note editor both render it, so a field the
// composer collects is always a field the editor can correct (owner ruling
// 2026-09-14). `children` is the action area: Save Note for the composer,
// Save / Cancel for the editor.

/**
 * Two-tier security picker. The select lists what the user holds or
 * watches; the search box below it reaches every other security. Defined at
 * module level (a component inside another remounts on each render).
 */
function SecurityPicker({
  symbol,
  onSymbolChange,
  securities,
  keep,
}: {
  symbol: string;
  onSymbolChange: (next: string) => void;
  securities: PickerSecurity[];
  keep?: { id: number | null; symbol: string | null } | null;
}) {
  const [query, setQuery] = useState("");
  const tiered: TieredPickerSecurity[] = securities.map((s) => ({ ...s, tier: s.tier ?? "held" }));
  const base = defaultPickerSecurities(tiered, keep);
  // A security picked through the search stays selectable in the select.
  const options =
    symbol && !base.some((s) => s.symbol === symbol)
      ? [tiered.find((s) => s.symbol === symbol) ?? { id: -1, symbol, name: null, tier: "other" as const }, ...base]
      : base;
  const matches = searchPickerSecurities(tiered, query);
  const listId = "note-security-search-list";
  return (
    <>
      <select
        value={symbol}
        aria-label="Security"
        onChange={(e) => onSymbolChange(e.target.value)}
        // min-w-0 + max-w-full: a <select> sizes to its longest <option>,
        // and securities.symbol holds 80+-char prediction-market names —
        // unconstrained it blew the Notes page to 613px at a 390px
        // viewport (deep-QA 2026-07-28).
        className="min-w-0 max-w-full truncate bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
      >
        <option value="">Select security...</option>
        {options.map((s) => (
          <option key={s.id} value={s.symbol}>
            {s.symbol}
          </option>
        ))}
      </select>
      <input
        type="search"
        value={query}
        list={listId}
        aria-label="Search all securities"
        placeholder="Search all securities"
        onChange={(e) => {
          const v = e.target.value;
          const hit = searchPickerSecurities(tiered, v).find(
            (s) => s.symbol.toLowerCase() === v.trim().toLowerCase(),
          );
          // Exact symbol (a datalist pick or a typed symbol) selects it.
          if (hit && v.trim().length > 0 && v === hit.symbol) {
            onSymbolChange(hit.symbol);
            setQuery("");
          } else {
            setQuery(v);
          }
        }}
        className="min-w-0 w-44 max-w-full bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:border-gold"
      />
      <datalist id={listId}>
        {matches.map((s) => (
          <option key={s.id} value={s.symbol}>
            {s.name ?? ""}
          </option>
        ))}
      </datalist>
    </>
  );
}

function NoteComposerFields({
  type,
  onTypeChange,
  symbol,
  onSymbolChange,
  date,
  onDateChange,
  sentiment,
  onSentimentChange,
  content,
  onContentChange,
  tags,
  onTagsChange,
  securities,
  keepSecurity = null,
  viaOption = false,
  textareaRef,
  autoFocus = false,
  tagsHintId,
  children,
}: {
  type: NoteType;
  onTypeChange: (next: NoteType) => void;
  symbol: string;
  onSymbolChange: (next: string) => void;
  date: string;
  onDateChange: (next: string) => void;
  sentiment: NoteSentiment | "";
  onSentimentChange: (next: NoteSentiment | "") => void;
  content: string;
  onContentChange: (next: string) => void;
  tags: string;
  onTagsChange: (next: string) => void;
  securities: PickerSecurity[];
  keepSecurity?: { id: number | null; symbol: string | null } | null;
  viaOption?: boolean;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  autoFocus?: boolean;
  tagsHintId: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={type}
          aria-label="Note type"
          onChange={(e) => {
            const next = coerceNoteType(e.target.value);
            if (next) onTypeChange(next);
          }}
          className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
        >
          {NOTE_TYPES.map((value) => (
            <option key={value} value={value}>
              {NOTE_TYPE_LABELS[value]}
            </option>
          ))}
        </select>

        {viaOption && type !== "journal" && (
          <p className="basis-full text-xs text-ink-dim">
            {symbol
              ? `Notes on an option are filed under ${symbol}.`
              : "Pick the underlying security for this option note."}
          </p>
        )}

        {(type === "earnings" || type === "trade_thesis") && (
          <SecurityPicker
            symbol={symbol}
            onSymbolChange={onSymbolChange}
            securities={securities}
            keep={keepSecurity}
          />
        )}

        <input
          type="date"
          value={date}
          aria-label="Note date"
          onChange={(e) => onDateChange(e.target.value)}
          className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
        />

        <div className="flex gap-1">
          {SENTIMENT_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={sentiment === s.value}
              onClick={() => onSentimentChange(sentiment === s.value ? "" : s.value)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors focus-ring ${
                sentiment === s.value
                  ? SENTIMENT_STYLES[s.value]
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <textarea
        ref={textareaRef}
        value={content}
        autoFocus={autoFocus}
        aria-label="Note text"
        onChange={(e) => onContentChange(e.target.value)}
        placeholder={
          type === "journal"
            ? "Market & trading psychology — how you feel about the market, how you're trading..."
            : type === "earnings"
              ? "Earnings call notes, guidance thoughts..."
              : "Position notes, thesis updates, why you're watching this name..."
        }
        rows={3}
        className="w-full bg-raised border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint resize-none focus:outline-none focus:border-gold"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col">
          <input
            type="text"
            value={tags}
            onChange={(e) => onTagsChange(e.target.value)}
            placeholder="Tags (comma-separated)"
            aria-label="Tags"
            aria-describedby={tagsHintId}
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint w-60"
          />
          <span id={tagsHintId} className="text-[10px] text-ink-faint mt-0.5">e.g. tech, earnings, Q4</span>
        </div>

        <div className="flex items-center gap-3">{children}</div>
      </div>
    </>
  );
}

// ─── Notes List ──────────────────────────────────────────────────

// Keys on EXACTLY the params the server filtered by: ?search= and
// ?security= / ?security_id=. A tab selection (?type=) is navigation, not a
// user filter — a bare Stock Note tab on an empty journal must read "No
// notes yet", not blame a search the user never typed.
//
// ?symbol= is the add-note prefill (it preselects the security dropdown and
// filters nothing), and keying on it got the copy wrong in both directions:
// a search that filtered the earnings timeline to empty read "No earnings
// notes yet" (hiding that a filter was active), while arriving from a
// Security page with only ?symbol= claimed a filter was active that "clear
// it" could not clear.
/**
 * Domain-language copy for a note create/update/delete that did not succeed
 * (QA 2026-09-07, finding research-notes-composer--raw-failed-to-fetch-error-text).
 *
 * Moved to `lib/notes/save-failure-copy.ts` 2026-09-15 so the NotesAmbient
 * overlay (rendered globally from the dashboard layout) can reuse the same
 * copy without pulling this file's whole component graph (TranscriptCard,
 * ConfirmDialog, EmptyState, Toast, PrivateText, …) into every page's client
 * bundle. Re-exported here (imported above) so existing imports — this
 * file's own handlers, and `tests/dashboard/notes-composer-save-failure-copy.test.ts`
 * — keep working unchanged.
 */
export { describeNoteSaveFailure };

export function notesListIsFiltered(params: {
  search?: string | null;
  security?: string | number | null;
  type?: string | null;
}): boolean {
  const hasSearch = Boolean(params.search?.trim());
  // Mirror the server's gate exactly — see parseSecurityFilterId.
  const hasSecurity = parseSecurityFilterId(params.security) != null;
  return hasSearch || hasSecurity;
}

function NotesList({
  notes,
  filtered = false,
  filterEmptyCopy = null,
  edit,
}: {
  notes: NoteWithContext[];
  filtered?: boolean;
  filterEmptyCopy?: { title: string; description: string } | null;
  edit: NoteEditController;
}) {
  if (notes.length === 0) {
    // A filtered zero-result is not "no notes yet" — say what actually happened
    // (deep-QA finding: search with no matches read as an empty journal).
    return (
      <EmptyState
        icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>}
        title={filterEmptyCopy?.title ?? (filtered ? "No matching notes" : "No notes yet")}
        description={
          filterEmptyCopy?.description ??
          (filtered
            ? "Nothing matches the current search or filter — clear it to see all notes."
            : "Start writing to build your investment journal.")
        }
      />
    );
  }

  // Group by date
  const grouped = new Map<string, NoteWithContext[]>();
  for (const note of notes) {
    const dateKey = note.event_date;
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey)!.push(note);
  }

  return (
    <div className="space-y-6">
      {Array.from(grouped.entries()).map(([date, dateNotes]) => (
        <div key={date} className="space-y-2">
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
            {formatDate(date)}
          </h3>
          <div className="space-y-2">
            {dateNotes.map((note) => (
              <NoteCard key={note.id} note={note} edit={edit} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Earnings Timeline ───────────────────────────────────────────

function EarningsView({
  timeline,
  transcriptSummaries,
  transcriptTickers,
  securities,
  filtered = false,
  filterEmptyCopy = null,
  edit,
  onRefresh,
}: {
  timeline: EarningsTimelineEntry[];
  transcriptSummaries: TranscriptSummaryEntry[];
  transcriptTickers: string[];
  securities: PickerSecurity[];
  filtered?: boolean;
  filterEmptyCopy?: { title: string; description: string } | null;
  edit: NoteEditController;
  onRefresh: () => void;
}) {
  // The server hands over a capped page of the transcript wall. "Load more"
  // re-reads a longer page; a fresh server page (after a refresh or a new
  // filter) always replaces it.
  const [loadedTranscripts, setLoadedTranscripts] = useState<
    TranscriptSummaryEntry[] | null
  >(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  useEffect(() => {
    setLoadedTranscripts(null);
    setLoadMoreError(null);
  }, [transcriptSummaries]);
  const shownTranscripts = loadedTranscripts ?? transcriptSummaries;
  const transcriptTotal = shownTranscripts.reduce(
    (max, t) => Math.max(max, t.total_count ?? 0),
    shownTranscripts.length,
  );
  const transcriptsWithheld = transcriptTotal - shownTranscripts.length;

  async function loadMoreTranscripts() {
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const res = await apiFetch(
        `/api/transcripts?limit=${shownTranscripts.length + TRANSCRIPT_PAGE_SIZE}`,
      );
      const result = await readMutationResult<{ data?: unknown }>(res);
      if (!result.ok) {
        setLoadMoreError(`Couldn't load more transcripts: ${result.message}`);
        return;
      }
      const rows = result.data.data;
      if (!Array.isArray(rows)) {
        setLoadMoreError("Couldn't load more transcripts: the server's reply was unreadable.");
        return;
      }
      setLoadedTranscripts(rows as TranscriptSummaryEntry[]);
    } catch {
      setLoadMoreError(networkFailureMessage("load more transcripts"));
    } finally {
      setLoadingMore(false);
    }
  }

  // Group transcripts by ticker for interleaving with notes
  const transcriptsByTicker = new Map<string, TranscriptSummaryEntry[]>();
  for (const t of shownTranscripts) {
    if (!transcriptsByTicker.has(t.ticker)) transcriptsByTicker.set(t.ticker, []);
    transcriptsByTicker.get(t.ticker)!.push(t);
  }

  // Collect all tickers that have transcripts but no notes timeline entry
  const timelineTickers = new Set(timeline.map((e) => e.symbol));
  const extraTranscriptTickers = [...transcriptsByTicker.keys()].filter(
    (ticker) => !timelineTickers.has(ticker)
  );

  // Tickers that already have cached transcripts — from the UNFILTERED
  // server set, never from `transcriptSummaries` (the search-filtered wall).
  // Subtracting the filtered wall from the unfiltered securities list made
  // already-cached tickers reappear as "Fetch <TICKER> Transcript" buttons
  // whenever a filter was active: most clicks no-op into cache, but an
  // edgar_8k-only name spends a real Alpha Vantage call per click.
  const tickersWithTranscripts = new Set(
    transcriptTickers.map((t) => t.toUpperCase())
  );
  // Belt and braces: anything on the current wall is cached by definition.
  for (const t of shownTranscripts) {
    tickersWithTranscripts.add(t.ticker.toUpperCase());
  }

  // Stocks with a real ticker and no cached transcript — see
  // transcriptFetchCandidates for what is left out and why.
  const fetchableTickers = transcriptFetchCandidates(securities, tickersWithTranscripts);

  if (timeline.length === 0 && shownTranscripts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-panel border border-edge rounded-xl p-8 text-center">
          <p className="text-ink-faint text-sm">
            {filterEmptyCopy
              ? `${filterEmptyCopy.title}. ${filterEmptyCopy.description}`
              : filtered
                ? "No matching notes — nothing matches the current search or filter. Clear it to see all earnings notes."
                : "No earnings notes yet. Add notes during earnings calls to track your thoughts quarter over quarter."}
          </p>
        </div>
        {fetchableTickers.length > 0 && (
          <FetchTickersSection tickers={fetchableTickers} onRefresh={onRefresh} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Securities with user notes (+ their transcripts interleaved) */}
      {timeline.map((entry) => {
        const tickerTranscripts = transcriptsByTicker.get(entry.symbol) ?? [];
        return (
          <div key={entry.security_id}>
            <div className="flex items-baseline gap-2 mb-3">
              <SymbolLink
                securityId={entry.security_id}
                symbol={entry.symbol}
                className="font-mono font-semibold text-ink text-sm"
              />
              {entry.security_name && (
                <span className="text-ink-faint text-xs truncate">
                  {entry.security_name}
                </span>
              )}
              <span className="text-ink-faint text-xs">
                ({entry.notes.length} note{entry.notes.length !== 1 ? "s" : ""}
                {tickerTranscripts.length > 0 &&
                  `, ${transcriptCountLabel(tickerCountRows(tickerTranscripts))}`}
                )
              </span>
            </div>
            <div className="space-y-2 pl-3 border-l-2 border-blue/30">
              {/* Transcript cards first (most recent quarter at top) */}
              {tickerTranscripts.map((t) => (
                <TranscriptCard
                  key={`transcript-${t.ticker}-${t.year}-${t.quarter}`}
                  transcript={t}
                />
              ))}
              {/* Then user notes */}
              {entry.notes.map((note) => (
                <NoteCard key={note.id} note={note} edit={edit} compact />
              ))}
            </div>
          </div>
        );
      })}

      {/* Securities with transcripts only (no user notes) */}
      {extraTranscriptTickers.map((ticker) => {
        const transcripts = transcriptsByTicker.get(ticker)!;
        return (
          <div key={`transcript-only-${ticker}`}>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="font-mono font-semibold text-ink text-sm">
                {ticker}
              </span>
              <span className="text-ink-faint text-xs">
                ({transcriptCountLabel(tickerCountRows(transcripts))})
              </span>
            </div>
            <div className="space-y-2 pl-3 border-l-2 border-[#818CF8]/30">
              {transcripts.map((t) => (
                <TranscriptCard
                  key={`transcript-${t.ticker}-${t.year}-${t.quarter}`}
                  transcript={t}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* The wall is a capped page: say how much of it is on screen, and
          offer the rest. */}
      {transcriptsWithheld > 0 && (
        <div className="flex items-center gap-3 flex-wrap text-xs text-ink-dim">
          <span>
            Showing {shownTranscripts.length} of {transcriptTotal} transcripts and filings.
          </span>
          {filtered ? (
            // The longer page is read unfiltered, so it cannot extend a
            // filtered wall honestly.
            <span>Narrow the search to bring the rest into view.</span>
          ) : (
            <button
              type="button"
              onClick={loadMoreTranscripts}
              disabled={loadingMore}
              className="px-3 py-1.5 rounded-lg border border-edge text-ink hover:bg-panel disabled:opacity-40 focus-ring"
            >
              {loadingMore
                ? "Loading..."
                : `Load more (${transcriptsWithheld} remaining)`}
            </button>
          )}
          {loadMoreError && (
            <span role="alert" className="text-down">
              {loadMoreError}
            </span>
          )}
        </div>
      )}

      {/* Fetch transcripts for portfolio tickers without cached data */}
      {fetchableTickers.length > 0 && (
        <FetchTickersSection tickers={fetchableTickers} onRefresh={onRefresh} />
      )}
    </div>
  );
}

// ─── Fetch Tickers Section ────────────────────────────────────────

function FetchTickersSection({
  tickers,
  onRefresh,
}: {
  tickers: string[];
  onRefresh: () => void;
}) {
  return (
    <div className="bg-panel border border-edge rounded-xl p-4">
      <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-3">
        Fetch Earnings Transcripts
      </h4>
      <div className="flex flex-wrap gap-2">
        {tickers.map((ticker) => (
          <FetchTranscriptButton
            key={ticker}
            ticker={ticker}
            onFetched={onRefresh}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Note Card ───────────────────────────────────────────────────

function NoteCard({
  note,
  edit,
  compact = false,
}: {
  note: NoteWithContext;
  edit: NoteEditController;
  compact?: boolean;
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const borderClass = TYPE_BORDER[note.note_type] ?? "border-l-edge";
  const tags = parseNoteTags(note.tags);
  const draft = edit.editingId === note.id ? edit.draft : null;
  const isEditing = draft !== null;

  return (
    <div
      className={`bg-panel border rounded-xl border-l-2 ${compact ? "p-3" : "p-4"} group ${
        isEditing
          ? "border-gold/40 border-l-gold bg-gold/[0.02]"
          : `border-edge ${borderClass}`
      }`}
    >
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete note"
        message="Are you sure you want to delete this note? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          edit.onDelete(note.id);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
      {draft ? (
        // The composer's own fields, filled from this note. Opening a note
        // to edit is an explicit reveal, so the text is shown unmasked.
        <div className="space-y-3">
          <NoteComposerFields
            type={draft.type}
            onTypeChange={(type) => edit.onChange({ type })}
            symbol={draft.symbol}
            onSymbolChange={(symbol) => edit.onChange({ symbol })}
            date={draft.date}
            onDateChange={(date) => edit.onChange({ date })}
            sentiment={draft.sentiment}
            onSentimentChange={(sentiment) => edit.onChange({ sentiment })}
            content={draft.content}
            onContentChange={(content) => edit.onChange({ content })}
            tags={draft.tags}
            onTagsChange={(tags) => edit.onChange({ tags })}
            securities={edit.securities}
            keepSecurity={{ id: note.security_id, symbol: note.symbol }}
            autoFocus
            tagsHintId={`tags-hint-${note.id}`}
          >
            <button
              type="button"
              onClick={() => edit.onSave(note)}
              disabled={!draft.content.trim() || edit.saving}
              className={`px-3 py-1 ${GOLD_FILL_CLASSES} rounded text-xs font-medium hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {edit.saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={edit.onCancel}
              disabled={edit.saving}
              className="px-3 py-1 text-ink-faint hover:text-ink text-xs disabled:opacity-40"
            >
              Cancel
            </button>
          </NoteComposerFields>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {/* Header: type badge + symbol + date */}
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              {!compact && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint bg-muted px-1.5 py-0.5 rounded">
                  {noteTypeLabel(note.note_type)}
                </span>
              )}
              {note.symbol &&
                (note.security_id ? (
                  <SymbolLink
                    securityId={note.security_id}
                    symbol={note.symbol}
                    className="font-mono text-xs font-semibold text-blue"
                  />
                ) : (
                  <span className="font-mono text-xs font-semibold text-blue">
                    {note.symbol}
                  </span>
                ))}
              {compact && (
                <span className="text-xs text-ink-faint">
                  {formatDate(note.event_date)}
                </span>
              )}
              {note.sentiment && (
                <span
                  className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${SENTIMENT_STYLES[note.sentiment] ?? ""}`}
                >
                  {note.sentiment}
                </span>
              )}
            </div>

            {/* Content. [overflow-wrap:anywhere]: a long URL is one unbreakable
                token and otherwise runs out of the card. */}
            <p className="text-sm text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">
              {/* Note prose carries share counts / P&L in the clear (e.g.
                  "sold 35 of my 50 shares at 352") — portfolio-derived, mask
                  it like every other such surface. Edit mode above keeps the
                  raw value: opening a note to edit is an explicit reveal. */}
              <PrivateText>{note.content}</PrivateText>
            </p>

            {/* Tags */}
            {tags.length > 0 && (
              <div className="flex gap-1 mt-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] text-ink-faint bg-muted px-1.5 py-0.5 rounded"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            {/* Transaction link */}
            {note.transaction_type && note.transaction_date && (
              <div className="text-xs text-ink-faint mt-1.5">
                Linked to {note.transaction_type} on {formatDate(note.transaction_date)}
              </div>
            )}
          </div>

          {/* Action buttons — always rendered. A hover gate left a phone with
              no sign the controls exist; the ::after extends the tap target
              on touch pointers only. */}
          <div className="flex gap-1 pointer-coarse:gap-4 shrink-0">
            <button
              type="button"
              onClick={() => edit.onStart(note)}
              className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2 p-1 text-ink-faint hover:text-ink rounded transition-colors focus-ring"
              aria-label="Edit note"
              title="Edit note"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2 p-1 text-ink-faint hover:text-down rounded transition-colors focus-ring"
              aria-label="Delete note"
              title="Delete note"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${year}`;
}
