import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

// No component-rendering harness in this repo: source-pin test.
//
// QA finding `dashboard-research-view-feeds-digest-preview-modal-under-privacy-mode-...`:
// under Hide amounts the Preview modal showed the outbound email unmasked.
// Owner ruling (option 2): under privacy mode the Preview says it shows the
// email exactly as sent and asks before rendering it. Composer/API untouched.

const source = fs.readFileSync(
  path.join(process.cwd(), "app/dashboard/components/DigestEmailViewer.tsx"),
  "utf8",
);

describe("DigestEmailViewer privacy gate", () => {
  it("reads privacy mode from usePrivacy", () => {
    expect(source).toMatch(/import \{[^}]*usePrivacy[^}]*\} from "@\/lib\/privacy\/context"/);
    expect(source).toMatch(/const \{ isPrivate \} = usePrivacy\(\)/);
  });

  it("resets the reveal choice each time the modal opens", () => {
    expect(source).toMatch(/const \[revealed, setRevealed\] = useState\(false\)/);
    const effect = anchorIndex(source, "setRevealed(false)", 0, "reset on open");
    expect(source.slice(Math.max(0, effect - 200), effect)).toMatch(/\[open\]|if \(!open\)|open/);
    expect(source).toMatch(/const gated = isPrivate && !revealed/);
  });

  it("renders the iframe only when not gated", () => {
    const iframe = anchorIndex(source, "<iframe", 0, "iframe");
    const before = source.slice(Math.max(0, iframe - 200), iframe);
    expect(before).toMatch(/!gated/);
  });

  it("shows the notice and the two choices while gated", () => {
    const gate = anchorIndex(source, "data-digest-privacy-gate", 0, "gate notice");
    const block = source.slice(gate, gate + 1800);
    expect(block).toContain("Hide amounts");
    expect(block).toContain("as it is sent");
    expect(block).toMatch(/onClick=\{\(\) => setRevealed\(true\)\}[\s\S]*Show the preview anyway/);
    expect(block).toMatch(/onClick=\{onClose\}[\s\S]*Keep it closed/);
  });

  it("hides the preview again when Hide amounts turns on while it is revealed", () => {
    const effect = anchorIndex(source, "if (isPrivate) setRevealed(false)", 0, "re-hide on privacy on");
    expect(source.slice(effect, effect + 120)).toMatch(/\[isPrivate\]/);
  });
});
