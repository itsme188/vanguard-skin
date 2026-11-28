import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";
import {
  noRecipientMessage,
  type NoRecipientKind,
} from "@/lib/email/no-recipient-message";

const KINDS: NoRecipientKind[] = ["earnings", "briefing", "evening", "digest"];

function expectOwnerWording(text: string) {
  expect(text).toContain("nothing was sent");
  expect(text).not.toContain("BRIEFING_EMAIL_TO");
  expect(text).not.toContain("env");
  expect(text).not.toContain("'recipient'");
}

describe("no-recipient refusal wording", () => {
  for (const kind of KINDS) {
    it(`${kind}: owner wording`, () => {
      expectOwnerWording(noRecipientMessage(kind));
    });
  }

  // Source pins: each sender's no-recipient branch uses the shared message.
  const SENDERS: Array<[string, NoRecipientKind]> = [
    ["lib/earnings/send-service.ts", "earnings"],
    ["lib/digest/send-briefing.ts", "briefing"],
    ["lib/digest/send-evening.ts", "evening"],
    ["lib/digest/send-digest.ts", "digest"],
  ];
  for (const [file, kind] of SENDERS) {
    it(`${file} refuses with the shared ${kind} message`, () => {
      const src = readFileSync(file, "utf8");
      const start = anchorIndex(src, "if (!recipient) {", 0, file);
      const region = src.slice(start, start + 300);
      expect(region).toContain(`noRecipientMessage("${kind}")`);
      expect(region).not.toContain("BRIEFING_EMAIL_TO");
      expect(region).not.toContain("'recipient'");
    });
  }
});
