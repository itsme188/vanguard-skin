/**
 * Notes and transcripts view — QA units A21 and B34.
 *
 * This repo has no DOM test harness, so each behaviour is tested through
 * the pure function the component calls, plus a source pin (anchored with
 * `anchorIndex`, which throws when an anchor vanishes) where the behaviour
 * is markup.
 *
 * Findings covered:
 *   research-notes--one-note-type-three-labels-stock-note-trade-thesis
 *   research-notes-edit--body-only-security-type-date-tags-uneditable
 *   research-earnings-transcripts--fetch-wall-290-buttons-non-earnings-instruments
 *   research-notes-picker--unfiltered-garbage-securities-selectable
 *   security-detail-notes-view-all--invisible-unclearable-security-filter-regression-1
 *   research-notes--edit-delete-hover-gated-absent-from-dom-regression-2
 *   research-notes-card--long-url-overflows-card-and-page-horizontal-scroll
 *   research-notes-cards--symbol-chips-not-links
 *   research-transcripts-group-header--count-derived-from-50-row-page-undercounts
 *   research-transcripts-list--caps-at-50-of-86-no-pagination-no-count
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  NOTE_TYPE_LABELS,
  noteTypeLabel,
  parseNoteTags,
  draftFromNote,
  buildNoteUpdateBody,
  unappliedNoteEdits,
  isSelectableNoteSecurity,
  notePickerSecurities,
  transcriptFetchCandidates,
  parseSecurityFilterId,
  resolveSecurityFilterSymbol,
  securityFilterChipText,
  securityFilterEmptyCopy,
  tickerCountRows,
  type NoteDraft,
  type PickerSecurity,
} from "@/app/dashboard/components/NotesView";
import type { NoteWithContext } from "@/lib/queries/notes";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";
import { NOTE_TYPES } from "@/lib/types";
import { transcriptCountLabel } from "@/lib/transcripts/presentation";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");

function note(overrides: Partial<NoteWithContext> = {}): NoteWithContext {
  return {
    id: 7,
    note_type: "earnings",
    content: "Margins held up.",
    event_date: "2026-05-01",
    tags: JSON.stringify(["guidance", "margins"]),
    sentiment: "bullish",
    created_at: "2026-05-01 10:00:00",
    updated_at: "2026-05-01 10:00:00",
    security_id: 11,
    transaction_id: null,
    symbol: "AAA",
    security_name: "AAA Corp",
    transaction_type: null,
    transaction_date: null,
    ...overrides,
  };
}

const SECURITIES: PickerSecurity[] = [
  { id: 11, symbol: "AAA", name: "AAA Corp", security_type: "Stock" },
  { id: 12, symbol: "ZZZ", name: "ZZZ Corp", security_type: "Stock" },
  { id: 13, symbol: "FUND", name: "A Fund", security_type: "ETF" },
];

// ─── A21: one label per note type ─────────────────────────────────

describe("note type labels (one name per type)", () => {
  it("every note type has exactly one label and trade_thesis is 'Stock Note'", () => {
    expect(Object.keys(NOTE_TYPE_LABELS).sort()).toEqual([...NOTE_TYPES].sort());
    expect(NOTE_TYPE_LABELS.trade_thesis).toBe("Stock Note");
  });

  it("the card badge label is the composer's label, not the stored token", () => {
    expect(noteTypeLabel("trade_thesis")).toBe("Stock Note");
    expect(noteTypeLabel("journal")).toBe("Journal");
    expect(noteTypeLabel("earnings")).toBe("Earnings");
  });

  it("the tab, the composer option and the badge all read the one map", () => {
    // Tab row.
    expect(sliceBetween(src, "const TYPE_OPTIONS", "];")).toContain(
      "NOTE_TYPES.map((value) => ({ label: NOTE_TYPE_LABELS[value], value }))",
    );
    // Composer option list.
    const fields = sliceBetween(src, "function NoteComposerFields(", "// ─── Notes List");
    expect(fields).toContain("{NOTE_TYPE_LABELS[value]}");
    // Card badge.
    const card = src.slice(anchorIndex(src, "function NoteCard("));
    expect(card).toContain("{noteTypeLabel(note.note_type)}");
    expect(card).not.toContain('note.note_type.replace("_", " ")');
    // No second spelling anywhere in the file.
    expect(src).not.toMatch(/Stock Notes|Trade Thesis/);
  });
});

// ─── A21: the composer is the editor ──────────────────────────────

describe("note editor (the composer's fields, filled from the note)", () => {
  it("the draft carries every field the composer collects", () => {
    expect(draftFromNote(note())).toEqual<NoteDraft>({
      type: "earnings",
      content: "Margins held up.",
      symbol: "AAA",
      date: "2026-05-01",
      sentiment: "bullish",
      tags: "guidance, margins",
    });
  });

  it("malformed or non-array tags read as no tags instead of throwing", () => {
    expect(parseNoteTags(null)).toEqual([]);
    expect(parseNoteTags("not json")).toEqual([]);
    expect(parseNoteTags('{"a":1}')).toEqual([]);
    expect(parseNoteTags('["x", 3, "y"]')).toEqual(["x", "y"]);
  });

  it("a body-only edit never sends a type or a security", () => {
    const n = note();
    const body = buildNoteUpdateBody(n, { ...draftFromNote(n), content: "  New text. " }, SECURITIES);
    expect(body).toEqual({
      id: 7,
      content: "New text.",
      event_date: "2026-05-01",
      tags: ["guidance", "margins"],
      sentiment: "bullish",
    });
  });

  it("date, sentiment and tags are editable; cleared ones are sent as null", () => {
    const n = note();
    const body = buildNoteUpdateBody(
      n,
      { ...draftFromNote(n), date: "2026-04-28", sentiment: "", tags: " , " },
      SECURITIES,
    );
    expect(body).toMatchObject({ event_date: "2026-04-28", sentiment: null, tags: null });
  });

  it("an emptied date is left out so the server keeps the stored one", () => {
    const n = note();
    const body = buildNoteUpdateBody(n, { ...draftFromNote(n), date: "" }, SECURITIES);
    expect(body).not.toBeNull();
    expect(body && "event_date" in body).toBe(false);
  });

  it("a changed type and a changed security are sent by id", () => {
    const n = note();
    const body = buildNoteUpdateBody(
      n,
      { ...draftFromNote(n), type: "trade_thesis", symbol: "ZZZ" },
      SECURITIES,
    );
    expect(body).toMatchObject({ note_type: "trade_thesis", security_id: 12 });
  });

  it("clearing the security sends null", () => {
    const n = note();
    const body = buildNoteUpdateBody(n, { ...draftFromNote(n), symbol: "" }, SECURITIES);
    expect(body).toMatchObject({ security_id: null });
  });

  it("switching to Journal clears the security; an existing journal link is untouched", () => {
    const n = note();
    expect(
      buildNoteUpdateBody(n, { ...draftFromNote(n), type: "journal" }, SECURITIES),
    ).toMatchObject({ note_type: "journal", security_id: null });

    const linkedJournal = note({ note_type: "journal" });
    const body = buildNoteUpdateBody(
      linkedJournal,
      { ...draftFromNote(linkedJournal), content: "Edited." },
      SECURITIES,
    );
    expect(body && "security_id" in body).toBe(false);
    expect(body && "note_type" in body).toBe(false);
  });

  it("empty text builds no request", () => {
    const n = note();
    expect(buildNoteUpdateBody(n, { ...draftFromNote(n), content: "   " }, SECURITIES)).toBeNull();
  });

  it("reports a type or security change the saved row does not show", () => {
    const body = { id: 7, content: "x", tags: null, sentiment: null, note_type: "journal", security_id: null } as const;
    expect(unappliedNoteEdits(body, { note_type: "journal", security_id: null })).toEqual([]);
    expect(unappliedNoteEdits(body, { note_type: "earnings", security_id: 11 })).toEqual([
      "type",
      "security",
    ]);
    // A body that asked for neither change is never flagged.
    expect(
      unappliedNoteEdits({ id: 7, content: "x", tags: null, sentiment: null }, { note_type: "earnings" }),
    ).toEqual([]);
    expect(unappliedNoteEdits(body, null)).toEqual(["type"]);
  });

  it("the card's edit mode renders the composer's fields, not a bare textarea", () => {
    const card = src.slice(anchorIndex(src, "function NoteCard("));
    expect(card).toContain("<NoteComposerFields");
    expect(card).not.toContain("<textarea");
    // The quick-add form renders the same component.
    const form = sliceBetween(src, "<form onSubmit={handleCreate}", "</form>");
    expect(form).toContain("<NoteComposerFields");
  });

  it("the update handler reads the saved row back before claiming success", () => {
    const handler = sliceBetween(src, "async function handleUpdate", "// ─── Delete note ───");
    expect(handler).toContain("buildNoteUpdateBody(note, editDraft, securities)");
    expect(handler).toContain("unappliedNoteEdits(body, data.data)");
    expect(handler).toContain("!res.ok || !data?.success");
    expect(handler).toContain('describeNoteSaveFailure({ kind: "network", action: "update" })');
  });
});

// ─── B34: security picker and fetch wall ──────────────────────────

describe("security picker leaves out rows that are not securities", () => {
  it("drops the placeholder, bare CUSIPs and raw OCC strings", () => {
    expect(isSelectableNoteSecurity("-")).toBe(false);
    expect(isSelectableNoteSecurity("  ")).toBe(false);
    expect(isSelectableNoteSecurity("000000AB1")).toBe(false);
    expect(isSelectableNoteSecurity("AAA 300117P00100000")).toBe(false);
    expect(isSelectableNoteSecurity("AAA   300117C00100000")).toBe(false);
  });

  it("keeps real tickers, including class shares and numeric foreign tickers", () => {
    for (const sym of ["AAA", "ZZZ", "AB.C", "AB/C", "0000", "000000"]) {
      expect(isSelectableNoteSecurity(sym)).toBe(true);
    }
  });

  it("keeps the edited note's own security selectable even when filtered out", () => {
    const list: PickerSecurity[] = [
      { id: 1, symbol: "-", name: null },
      { id: 2, symbol: "AAA", name: null },
    ];
    expect(notePickerSecurities(list).map((s) => s.symbol)).toEqual(["AAA"]);
    expect(
      notePickerSecurities(list, { id: 9, symbol: "000000AB1" }).map((s) => s.symbol),
    ).toEqual(["000000AB1", "AAA"]);
    // Already present: not added twice.
    expect(notePickerSecurities(list, { id: 2, symbol: "AAA" })).toHaveLength(1);
  });

  // D8 (2026-10-08): the composer and the editor hand the picker the FULL
  // tiered list; the two-tier picker filters it (held + watch by default,
  // garbage hidden, search over the rest).
  it("both the composer and the editor pass the full list to the two-tier picker", () => {
    const form = sliceBetween(src, "<form onSubmit={handleCreate}", "</form>");
    expect(form).toContain("securities={securities}");
    const card = src.slice(anchorIndex(src, "function NoteCard("));
    expect(card).toContain("securities={edit.securities}");
    expect(card).toContain("keepSecurity={{ id: note.security_id, symbol: note.symbol }}");
    const picker = src.slice(anchorIndex(src, "function SecurityPicker("));
    expect(picker).toContain("defaultPickerSecurities(tiered, keep)");
    expect(picker).toContain('aria-label="Search all securities"');
  });
});

describe("transcript fetch wall offers only names that can report", () => {
  it("drops the placeholder, numeric tickers, long symbols and cached tickers", () => {
    const list: PickerSecurity[] = [
      { id: 1, symbol: "-", name: null },
      { id: 2, symbol: "0000", name: null },
      { id: 3, symbol: "AAA", name: null },
      { id: 4, symbol: "ZZZ", name: null },
      { id: 5, symbol: "TOOLONG", name: null },
      { id: 6, symbol: "AA BB", name: null },
    ];
    expect(transcriptFetchCandidates(list, ["zzz"])).toEqual(["AAA"]);
  });

  it("drops funds and ETFs when the page supplies the security type", () => {
    expect(transcriptFetchCandidates(SECURITIES, [])).toEqual(["AAA", "ZZZ"]);
    expect(
      transcriptFetchCandidates(
        [
          { id: 1, symbol: "AAA", name: null, security_type: "stock" },
          { id: 2, symbol: "MMM", name: null, security_type: "Mutual Fund" },
        ],
        [],
      ),
    ).toEqual(["AAA"]);
  });

  it("offers each ticker once", () => {
    expect(
      transcriptFetchCandidates(
        [
          { id: 1, symbol: "AAA", name: null },
          { id: 2, symbol: "AAA", name: null },
        ],
        [],
      ),
    ).toEqual(["AAA"]);
  });
});

// ─── B34: visible, clearable security filter ──────────────────────

describe("security filter chip", () => {
  it("parses the filter id the way the server does", () => {
    expect(parseSecurityFilterId("42")).toBe(42);
    expect(parseSecurityFilterId(42)).toBe(42);
    expect(parseSecurityFilterId("AAA")).toBeNull();
    expect(parseSecurityFilterId("0")).toBeNull();
    expect(parseSecurityFilterId(null)).toBeNull();
  });

  it("names the security from the picker list, else from the notes on the page", () => {
    expect(resolveSecurityFilterSymbol(12, SECURITIES, [])).toBe("ZZZ");
    expect(
      resolveSecurityFilterSymbol(99, SECURITIES, [note({ security_id: 99, symbol: "QQQQ" })]),
    ).toBe("QQQQ");
    expect(resolveSecurityFilterSymbol(99, SECURITIES, [])).toBeNull();
  });

  it("chip text names the symbol, with an honest fallback", () => {
    expect(securityFilterChipText("AAA")).toBe("Filtered: AAA");
    expect(securityFilterChipText(null)).toBe("Filtered to one security");
  });

  it("the empty state names the security and the chip that clears it", () => {
    expect(
      securityFilterEmptyCopy({ filterActive: true, filterSymbol: "AAA", searchActive: false }),
    ).toEqual({
      title: "No notes for AAA",
      description: 'Clear the "Filtered: AAA" chip above to see every note.',
    });
    expect(
      securityFilterEmptyCopy({
        filterActive: true,
        filterSymbol: null,
        searchActive: false,
        earnings: true,
      })?.title,
    ).toBe("No earnings notes for this security");
  });

  it("stays out of the way without a security filter, or when a search is also on", () => {
    expect(
      securityFilterEmptyCopy({ filterActive: false, filterSymbol: null, searchActive: false }),
    ).toBeNull();
    expect(
      securityFilterEmptyCopy({ filterActive: true, filterSymbol: "AAA", searchActive: true }),
    ).toBeNull();
  });

  it("the chip is a real control that removes both filter params", () => {
    const clear = sliceBetween(src, "function clearSecurityFilter()", "const edit: NoteEditController");
    expect(clear).toContain('params.delete("security")');
    expect(clear).toContain('params.delete("security_id")');
    const chip = sliceBetween(src, "{securityFilterId != null && (", "{/* ─── Quick-add form");
    expect(chip).toContain("onClick={clearSecurityFilter}");
    expect(chip).toContain("{securityFilterChipText(securityFilterSymbol)}");
    expect(chip).toContain('title="Clear filter"');
  });
});

// ─── B34: note card markup ────────────────────────────────────────

describe("note card", () => {
  const card = src.slice(anchorIndex(src, "function NoteCard("));

  it("Edit and Delete are always rendered — no hover gate", () => {
    expect(card).not.toMatch(/onMouseEnter|onMouseLeave|showActions/);
    expect(card).toContain('aria-label="Edit note"');
    expect(card).toContain('aria-label="Delete note"');
    // Touch pointers get an extended tap target.
    expect(card.match(/pointer-coarse:after:-inset-2/g)).toHaveLength(2);
  });

  it("the note body wraps a long unbroken token inside the card", () => {
    const body = card.slice(anchorIndex(card, "whitespace-pre-wrap"), anchorIndex(card, "<PrivateText>{note.content}</PrivateText>"));
    expect(body).toContain("[overflow-wrap:anywhere]");
  });

  it("the symbol is a link to the security hub", () => {
    expect(card).toMatch(
      /<SymbolLink\s+securityId=\{note\.security_id\}\s+symbol=\{note\.symbol\}/,
    );
    // The Earnings tab's per-security header too.
    const earnings = sliceBetween(src, "function EarningsView(", "// ─── Fetch Tickers Section");
    expect(earnings).toMatch(
      /<SymbolLink\s+securityId=\{entry\.security_id\}\s+symbol=\{entry\.symbol\}/,
    );
  });
});

// ─── B34: transcript wall counts ──────────────────────────────────

function transcript(overrides: Partial<TranscriptSummaryEntry> = {}): TranscriptSummaryEntry {
  return {
    id: 1,
    ticker: "AAA",
    security_name: "AAA Corp",
    year: 2026,
    quarter: 2,
    call_date: null,
    source: "alpha_vantage",
    summary: null,
    guidance: null,
    risk_factors: null,
    sentiment_label: null,
    sentiment_score: null,
    has_full_transcript: true,
    fetched_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("transcript wall counts", () => {
  it("a ticker header counts every quarter held, not the rows on the page", () => {
    // One card survived the row cap; the app holds two calls and a filing.
    expect(
      transcriptCountLabel(
        tickerCountRows([transcript({ ticker_sources: "alpha_vantage,edgar_8k,alpha_vantage" })]),
      ),
    ).toBe("2 transcripts, 1 filing");
  });

  it("falls back to the rows in hand when the query supplied no count", () => {
    expect(
      transcriptCountLabel(tickerCountRows([transcript(), transcript({ source: "edgar_8k" })])),
    ).toBe("1 transcript, 1 filing");
  });

  it("the wall states 'showing N of M' and offers the rest", () => {
    const earnings = sliceBetween(src, "function EarningsView(", "// ─── Fetch Tickers Section");
    expect(earnings).toContain("{transcriptsWithheld > 0 && (");
    expect(earnings).toContain(
      "Showing {shownTranscripts.length} of {transcriptTotal} transcripts and filings.",
    );
    expect(earnings).toContain("`Load more (${transcriptsWithheld} remaining)`");
    // The longer page is read through the shared response reader.
    expect(earnings).toContain("readMutationResult");
    expect(earnings).toContain('networkFailureMessage("load more transcripts")');
    // Both headers count from the uncapped figure.
    expect(earnings).toContain("transcriptCountLabel(tickerCountRows(tickerTranscripts))");
    expect(earnings).toContain("transcriptCountLabel(tickerCountRows(transcripts))");
  });
});
