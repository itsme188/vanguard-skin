import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * QA chat--send-401-csrf-token-never-attached-raw-envelope-rendered.
 *
 * `useChat`'s DefaultChatTransport uses its OWN fetch, which never attaches
 * the `X-CSRF-Token` header the #35 trust boundary requires on unsafe methods
 * (lib/auth/verify-request.ts decideHumanSession) — so every send 401'd and
 * the raw deny envelope rendered as the assistant reply. The transport must
 * be given the CSRF-aware `apiFetch` wrapper.
 *
 * This repo has no React component-rendering harness (no jsdom / testing-
 * library — see the precedent note in
 * tests/dashboard/data-confidence-indicator-privacy.test.ts), so this scans
 * the component source for the wiring instead of rendering it.
 */

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ChatInterface.tsx",
);

describe("ChatInterface transport attaches the CSRF token", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");

  it("imports the apiFetch wrapper", () => {
    expect(source).toMatch(
      /import\s+apiFetch\b[^;]*\bfrom\s+["']@\/lib\/http\/apiFetch["']/,
    );
  });

  // The transport's fetch is `chatFetch`, a thin wrapper that calls apiFetch
  // and then reads the response's conversation id. The CSRF guarantee is that
  // the ONLY network call inside it is apiFetch, with the SDK's own arguments.
  it("hands DefaultChatTransport a fetch that goes through apiFetch", () => {
    const start = anchorIndex(source, "new DefaultChatTransport(");
    const construction = source.slice(start, anchorIndex(source, ")", start) + 1);
    expect(construction).toMatch(/fetch:\s*chatFetch/);
    const wrapper = sliceBetween(source, "const chatFetch", "new DefaultChatTransport(");
    anchorIndex(wrapper, "await apiFetch(input, init)");
    expect(wrapper).not.toMatch(/(?<![A-Za-z])fetch\(/);
  });

  it("resolves the token per request (apiFetch reads the cookie at call time)", () => {
    // The known useChat gotcha: the transport is frozen at FIRST render, so a
    // token captured at construction would be stale/absent forever. apiFetch's
    // reader runs inside the call, so the wrapper never holds a token itself.
    const start = anchorIndex(source, "new DefaultChatTransport(");
    const construction = source.slice(start, anchorIndex(source, ")", start) + 1);
    expect(construction).not.toMatch(/X-CSRF-Token/);
    const wrapper = sliceBetween(source, "const chatFetch", "new DefaultChatTransport(");
    expect(wrapper).not.toMatch(/X-CSRF-Token/);
  });

  it("renders the humanized error, not the raw response envelope", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*humanizeChatError[^}]*\}\s*from\s*["']@\/lib\/chat\/error-message["']/,
    );
    expect(source).toMatch(/humanizeChatError\(error\.message\)/);
  });
});
