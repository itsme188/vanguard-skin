import { describe, it, expect } from "vitest";
import { redactUrl } from "@/lib/print-watch/hardened-fetch";

describe("redactUrl", () => {
  it("strips the named secret-bearing query parameters and keeps the rest", () => {
    expect(redactUrl("https://ir.example.com/release?id=42&token=SECRET&sig=S&signature=X&key=K&auth=A&session=Z&access=Q")).toBe(
      "https://ir.example.com/release?id=42",
    );
  });
  it("matches parameter names case-insensitively", () => {
    expect(redactUrl("https://x.example/a?Token=1&ID=2")).toBe("https://x.example/a?ID=2");
  });
  it("strips the whole secret-bearing families, not just seven exact names (M19)", () => {
    expect(
      redactUrl("https://x.example/a?api_key=1&apikey=2&X-Amz-Signature=3&X-Amz-Credential=4&client_secret=5&password=6&access_token=7&sessionid=8&page=2&keyword=q"),
    ).toBe("https://x.example/a?page=2&keyword=q");
  });
  it("drops embedded credentials and the fragment", () => {
    expect(redactUrl("https://user:pw@x.example/a#frag")).toBe("https://x.example/a");
  });
  it("truncates to 200 characters", () => {
    const long = `https://x.example/${"a".repeat(400)}`;
    expect(redactUrl(long)).toHaveLength(200);
    expect(redactUrl(long).endsWith("…")).toBe(true);
  });
  it("still redacts something that does not parse as a URL", () => {
    expect(redactUrl("not a url ?token=abc")).toBe("not a url ");
  });
});
