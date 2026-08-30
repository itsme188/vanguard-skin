import { describe, it, expect } from "vitest";
import { isExternalUrlAllowed } from "@/electron/external-url";

/**
 * Code-review finding on commit 97a4524: a second, un-allowlisted path to
 * `shell.openExternal` existed at electron/ipc-handlers.ts's "open-external"
 * IPC handler, while electron/main.ts's setWindowOpenHandler already
 * allow-listed http/https/mailto. This is the shared, pure decision both
 * call sites now use.
 */
describe("isExternalUrlAllowed", () => {
  it("allows https URLs", () => {
    expect(isExternalUrlAllowed("https://www.investing.com/news/x")).toBe(true);
  });

  it("allows http URLs", () => {
    expect(isExternalUrlAllowed("http://example.test/page")).toBe(true);
  });

  it("allows mailto URLs", () => {
    expect(isExternalUrlAllowed("mailto:unsubscribe@example.test")).toBe(true);
  });

  it("denies file: URLs", () => {
    expect(isExternalUrlAllowed("file:///etc/passwd")).toBe(false);
  });

  it("denies javascript: URLs", () => {
    expect(isExternalUrlAllowed("javascript:alert(1)")).toBe(false);
  });

  it("denies data: URLs", () => {
    expect(isExternalUrlAllowed("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("denies a custom/registered scheme", () => {
    expect(isExternalUrlAllowed("myapp://open?x=1")).toBe(false);
  });

  it("denies an unparseable URL", () => {
    expect(isExternalUrlAllowed("not a url")).toBe(false);
  });

  it("denies the app's own localhost origin regardless of port", () => {
    expect(isExternalUrlAllowed("http://localhost:3099/dashboard/today")).toBe(false);
    expect(isExternalUrlAllowed("http://localhost:3000/")).toBe(false);
    expect(isExternalUrlAllowed("https://localhost/x")).toBe(false);
  });

  it("denies the app's own 127.0.0.1 origin regardless of port", () => {
    expect(isExternalUrlAllowed("http://127.0.0.1:3000/x")).toBe(false);
    expect(isExternalUrlAllowed("http://127.0.0.1/x")).toBe(false);
  });

  it("is case-insensitive on the loopback hostname", () => {
    expect(isExternalUrlAllowed("http://LOCALHOST:3099/x")).toBe(false);
  });

  it("denies an extra origin passed via ownOrigins, without affecting others", () => {
    expect(isExternalUrlAllowed("https://myportfoliodesk.example/x", ["myportfoliodesk.example"])).toBe(
      false,
    );
    expect(isExternalUrlAllowed("https://www.investing.com/x", ["myportfoliodesk.example"])).toBe(true);
  });

  it("still allows real remote https/http/mailto when ownOrigins is omitted", () => {
    expect(isExternalUrlAllowed("https://www.investing.com/news/x")).toBe(true);
    expect(isExternalUrlAllowed("mailto:someone@example.test")).toBe(true);
  });
});
