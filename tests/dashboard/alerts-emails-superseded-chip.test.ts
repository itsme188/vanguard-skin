/**
 * Both lists of sent earnings emails (the Alerts "Emails" view and the
 * Security Detail section) mark an email whose calendar entry was later
 * replaced, and link to the email of the current entry for the same print
 * (owner ruling 2026-10-06,
 * qa:earnings-email-viewer--second-recap-sent-on-superseded-twin-listed-as-valid-opposite-reaction).
 * One implementation (app/dashboard/components/SupersededEmailNote.tsx), two
 * call sites. Source-pin test (no DOM harness); the data side is
 * tests/queries/earnings-emails-superseded.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const shared = readFileSync("app/dashboard/components/SupersededEmailNote.tsx", "utf8");
const alerts = readFileSync("app/dashboard/alerts/page.tsx", "utf8");
const security = readFileSync("app/dashboard/components/SecurityEarningsEmails.tsx", "utf8");

const chip = sliceBetween(
  shared,
  "export function SupersededEmailChip(",
  "export function SupersededEmailNote(",
);
const note = shared.slice(anchorIndex(shared, "export function SupersededEmailNote("));

describe("the shared chip and note", () => {
  it("the chip renders off the query flag and nothing for an ordinary email", () => {
    expect(chip).toContain("if (email.event_superseded !== 1) return null;");
    const at = anchorIndex(chip, "<Chip");
    expect(chip.slice(at, anchorIndex(chip, "</Chip>", at))).toContain("entry replaced");
  });

  it("the note renders nothing for an ordinary email", () => {
    const guard = anchorIndex(note, "if (email.event_superseded !== 1) return null;");
    expect(guard).toBeLessThan(anchorIndex(note, "<p "));
  });

  it("says it in visible words, not only in a hover title", () => {
    expect(note).toContain("was later replaced");
    expect(note).not.toContain("title=");
    expect(chip).not.toContain("title=");
  });

  it("links to the current entry's email of the same kind", () => {
    const at = anchorIndex(note, "<button");
    const link = note.slice(at, anchorIndex(note, "</button>", at));
    expect(link).toContain("onOpen({ event_id: live.event_id, phase: email.phase })");
    expect(link).toContain("for the current entry");
    expect(link).toContain("live.event_date");
    expect(link).toContain("formatSentAt(live.email_sent_at)");
  });

  it("offers no link when the current entry has no such email, or there is no current entry", () => {
    const before = note.slice(0, anchorIndex(note, "<button"));
    expect(before).toContain("live == null");
    expect(before).toContain("No current entry for this report was found.");
    expect(before).toContain("live.email_sent_at == null");
    expect(before).toContain("was sent for it.");
  });

  it("uses readable text and no caret glyph", () => {
    expect(note).toContain("text-ink-dim");
    expect(shared).not.toMatch(/text-ink-(dim|faint)\/\d/);
    expect(shared).not.toMatch(/[▾▸▼▲›»]/);
  });
});

/** The same wiring is required of each list. */
function pinCallSite(name: string, list: string) {
  describe(`${name}: an email sent for a replaced calendar entry`, () => {
    it("puts the chip inside the row button, before the sent time", () => {
      const rowStart = anchorIndex(list, "onClick={() => setViewing(e)}");
      const rowEnd = anchorIndex(list, "</button>", rowStart);
      const row = list.slice(rowStart, rowEnd);
      const chipAt = anchorIndex(row, "<SupersededEmailChip email={e} />");
      expect(chipAt).toBeLessThan(anchorIndex(row, "sent {fmtSentAt(e.sent_at)}"));
    });

    it("puts the note after the row button, never inside it", () => {
      const rowStart = anchorIndex(list, "onClick={() => setViewing(e)}");
      const rowEnd = anchorIndex(list, "</button>", rowStart);
      expect(list.slice(rowStart, rowEnd)).not.toContain("<SupersededEmailNote");
      const noteAt = anchorIndex(list, "<SupersededEmailNote", rowEnd);
      const call = list.slice(noteAt, anchorIndex(list, "/>", noteAt));
      expect(call).toContain("email={e}");
      expect(call).toContain("onOpen={setViewing}");
      expect(call).toContain("formatSentAt={fmtSentAt}");
    });

    it("opens the linked email in the same viewer the rows use", () => {
      const at = anchorIndex(list, "{viewing && (");
      const viewer = list.slice(at, anchorIndex(list, "/>", at));
      expect(viewer).toContain("<EarningsEmailViewer");
      expect(viewer).toContain("eventId={viewing.event_id}");
      expect(viewer).toContain("phase={viewing.phase}");
    });

    it("carries no copy of its own", () => {
      expect(list).not.toContain("entry replaced");
      expect(list).not.toContain("was later replaced");
    });
  });
}

pinCallSite(
  "Alerts Emails view",
  sliceBetween(alerts, "function SentEmailsList({ emails }", "// ─── Earnings date conflicts view"),
);
pinCallSite(
  "Security Detail emails",
  security.slice(anchorIndex(security, "export function SecurityEarningsEmails(")),
);

describe("both lists import the one implementation", () => {
  it("from SupersededEmailNote", () => {
    expect(alerts).toContain('from "../components/SupersededEmailNote"');
    expect(security).toContain('from "./SupersededEmailNote"');
  });
});
