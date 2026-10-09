/**
 * A failure line is often "<what the server said> <what that means for you>".
 * The server's text does not always end in a full stop, which printed lines
 * like "...already exists for this security on 2026-07-01 Nothing was
 * changed." `joinSentences` adds the full stop only when one is missing.
 */
import { describe, it, expect } from "vitest";
import { joinSentences } from "@/lib/ui/join-sentences";

describe("joinSentences", () => {
  it("adds a full stop when the first part has no closing punctuation", () => {
    expect(joinSentences("A split already exists on 2026-07-01", "Nothing was changed.")).toBe(
      "A split already exists on 2026-07-01. Nothing was changed.",
    );
  });

  it("adds nothing after a full stop, an exclamation mark or a question mark", () => {
    expect(joinSentences("Already applied.", "Nothing was changed.")).toBe(
      "Already applied. Nothing was changed.",
    );
    expect(joinSentences("Stop!", "Nothing was changed.")).toBe("Stop! Nothing was changed.");
    expect(joinSentences("Is the server up?", "Try again.")).toBe("Is the server up? Try again.");
  });

  it("a closing bracket with no full stop gets one", () => {
    expect(joinSentences("The server returned an error (HTTP 500)", "Try again.")).toBe(
      "The server returned an error (HTTP 500). Try again.",
    );
  });

  it("a full stop before or after a closing bracket counts", () => {
    expect(joinSentences("Refused (see the log.)", "Try again.")).toBe(
      "Refused (see the log.) Try again.",
    );
    expect(joinSentences("The server returned an error (HTTP 500).", "Try again.")).toBe(
      "The server returned an error (HTTP 500). Try again.",
    );
  });

  it("a closing quote with no full stop gets one; a full stop inside the quote counts", () => {
    expect(joinSentences('No account named "Roth"', "Nothing was changed.")).toBe(
      'No account named "Roth". Nothing was changed.',
    );
    expect(joinSentences("The broker said 'not found'", "Try again.")).toBe(
      "The broker said 'not found'. Try again.",
    );
    expect(joinSentences('The broker said "try later."', "Nothing was changed.")).toBe(
      'The broker said "try later." Nothing was changed.',
    );
  });

  it("an empty or blank first part leaves only the second", () => {
    expect(joinSentences("", "Nothing was changed.")).toBe("Nothing was changed.");
    expect(joinSentences("   ", "Nothing was changed.")).toBe("Nothing was changed.");
  });

  it("an empty second part leaves only the first, unchanged", () => {
    expect(joinSentences("A split already exists", "")).toBe("A split already exists");
  });

  it("trailing spaces on the first part are not kept before the full stop", () => {
    expect(joinSentences("A split already exists  ", "Nothing was changed.")).toBe(
      "A split already exists. Nothing was changed.",
    );
  });
});
