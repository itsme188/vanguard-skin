/**
 * The Alerts "Emails" tab marks an email whose calendar entry was later
 * replaced, and links to the email of the current entry for the same print
 * (owner ruling 2026-10-06,
 * qa:earnings-email-viewer--second-recap-sent-on-superseded-twin-listed-as-valid-opposite-reaction).
 * Source-pin test (no DOM harness); the data side is
 * tests/queries/earnings-emails-superseded.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/alerts/page.tsx", "utf8");

/** The list component, up to the next section of the file. */
const list = sliceBetween(
  src,
  "function SentEmailsList({ emails }",
  "// ─── Earnings date conflicts view",
);
/** The note under a marked row. */
const note = sliceBetween(src, "function SupersededEmailNote({", "function SentEmailsList({ emails }");

describe("Alerts Emails tab: an email sent for a replaced calendar entry", () => {
  it("renders the chip off the query flag, inside the row", () => {
    const at = anchorIndex(list, "{e.event_superseded === 1 && (");
    const chip = list.slice(at, anchorIndex(list, "</Chip>", at));
    expect(chip).toContain("<Chip");
    expect(chip).toContain("entry replaced");
    // The row stays openable: the chip sits before the sent-time cell of the
    // same row button, not in place of it.
    const sentCell = anchorIndex(list, "sent {fmtSentAt(e.sent_at)}", at);
    expect(anchorIndex(list, "</button>", at)).toBeGreaterThan(sentCell);
  });

  it("renders the note for a marked row only, as a sibling of the row button", () => {
    const rowEnd = anchorIndex(list, "</button>");
    const after = list.slice(rowEnd, anchorIndex(list, "</div>", rowEnd));
    expect(after).toContain("e.event_superseded === 1");
    expect(after).toContain("<SupersededEmailNote email={e} onOpen={setViewing} />");
    // A button inside a button is invalid markup: the link must not be
    // nested in the row button.
    expect(list.slice(0, rowEnd)).not.toContain("SupersededEmailNote");
  });

  it("says it in visible words, not only in a hover title", () => {
    expect(note).toContain("was later replaced");
    expect(note).not.toContain("title=");
  });

  it("links to the current entry's email of the same kind", () => {
    const at = anchorIndex(note, "<button");
    const link = note.slice(at, anchorIndex(note, "</button>", at));
    expect(link).toContain("onOpen({ event_id: live.event_id, phase: email.phase })");
    expect(link).toContain("for the current entry");
    expect(link).toContain("live.event_date");
  });

  it("offers no link when the current entry has no such email, or there is no current entry", () => {
    const linkAt = anchorIndex(note, "<button");
    const before = note.slice(0, linkAt);
    expect(before).toContain("live == null");
    expect(before).toContain("No current entry for this report was found.");
    expect(before).toContain("live.email_sent_at == null");
    expect(before).toContain("was sent for it.");
  });

  it("opens the linked email in the same viewer the rows use", () => {
    const at = anchorIndex(list, "{viewing && (");
    const viewer = list.slice(at, anchorIndex(list, "/>", at));
    expect(viewer).toContain("<EarningsEmailViewer");
    expect(viewer).toContain("eventId={viewing.event_id}");
    expect(viewer).toContain("phase={viewing.phase}");
  });

  it("uses readable text and no caret glyph", () => {
    expect(note).toContain("text-ink-dim");
    expect(note).not.toMatch(/text-ink-(dim|faint)\/\d/);
    expect(note).not.toMatch(/[▾▸▼▲›»]/);
  });
});
