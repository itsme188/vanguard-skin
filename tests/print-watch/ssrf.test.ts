import { describe, it, expect } from "vitest";
import { validatePublicUrl, isGloballyRoutable, resolvePinnedAddress } from "@/lib/print-watch/ssrf";

describe("validatePublicUrl", () => {
  it("accepts a plain https URL on the default port", () => {
    expect(validatePublicUrl("https://ir.example.com/news/q2")).toEqual({ ok: true, hostname: "ir.example.com" });
  });
  it.each([
    ["http://ir.example.com/x", /https/],
    ["ftp://ir.example.com/x", /https/],
    ["https://user:pw@ir.example.com/x", /credentials/],
    ["https://ir.example.com:8443/x", /port 443/],
    ["https://localhost/x", /local/],
    ["https://foo.localhost/x", /local/],
    ["https://localhost./x", /local/],
    ["https://foo.localhost./x", /local/],
    ["https://127.0.0.1/x", /routable/],
    ["https://[::1]/x", /routable/],
    ["https://169.254.169.254/latest/meta-data", /routable/],
    ["not a url", /valid URL/],
  ])("refuses %s", (url, reason) => {
    const v = validatePublicUrl(url);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(reason);
  });
  it("accepts an explicit :443", () => {
    expect(validatePublicUrl("https://ir.example.com:443/x").ok).toBe(true);
  });
  it("strips a trailing-dot FQDN and returns the canonical hostname", () => {
    expect(validatePublicUrl("https://ir.example.com./release")).toEqual({
      ok: true,
      hostname: "ir.example.com",
    });
  });
  // Task 3 minor, ruled in: ONE stripped dot let "localhost.." past the local
  // -name check (only the resolver's routability gate caught it afterwards).
  it("strips EVERY trailing dot, so a doubled dot cannot smuggle a local name past the string check", () => {
    expect(validatePublicUrl("https://localhost../x")).toEqual({
      ok: false,
      reason: "local hostnames are refused",
    });
    expect(validatePublicUrl("https://LOCALHOST.../x").ok).toBe(false);
    expect(validatePublicUrl("https://ir.example.com.../release")).toEqual({
      ok: true,
      hostname: "ir.example.com",
    });
  });
});

describe("isGloballyRoutable — IPv4 blocked ranges", () => {
  it.each([
    "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "127.255.255.255", "169.254.1.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "192.168.255.255", "198.18.0.1",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1",
    "255.255.255.255",
  ])("blocks %s", (ip) => {
    expect(isGloballyRoutable(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "192.0.3.1", "198.20.0.1", "223.255.255.254"])(
    "allows %s",
    (ip) => {
      expect(isGloballyRoutable(ip)).toBe(true);
    },
  );
});

describe("isGloballyRoutable — IPv6 blocked ranges", () => {
  it.each([
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1",
    "2001:db8::1",
    // Codex #9 — the forms that embed or tunnel an otherwise-forbidden IPv4 address
    "::7f00:1", "::10.0.0.1",            // IPv4-compatible (::/96) → v4 rules
    "64:ff9b:1::1", "64:ff9b:1:ffff::1", // local-use NAT64 64:ff9b:1::/48
    "100::1", "100::ffff:ffff:ffff:ffff", // discard-only 100::/64
    "2002:7f00:1::1", "2002:0a00:1::1", "2002:c0a8:101::1", // 6to4 of 127.0.0.1, 10.0.0.1, 192.168.1.1
    "2001::1", "2001:0:abcd::1",         // Teredo 2001::/32
    "2001:10::1", "2001:1f::1",          // ORCHID 2001:10::/28
  ])("blocks %s", (ip) => {
    expect(isGloballyRoutable(ip)).toBe(false);
  });
  it.each(["2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "::8.8.8.8", "2002:808:808::1", "2001:20::1"])("allows %s", (ip) => {
    expect(isGloballyRoutable(ip)).toBe(true);
  });
  it("treats garbage as not routable", () => {
    expect(isGloballyRoutable("nope")).toBe(false);
    expect(isGloballyRoutable("1:2:3:4:5:6:7:8:9")).toBe(false);
  });
});

describe("resolvePinnedAddress", () => {
  it("returns the first address when every resolved address is routable", async () => {
    const lookup = async () => [
      { address: "2606:4700::1111", family: 6 as const },
      { address: "104.16.0.1", family: 4 as const },
    ];
    await expect(resolvePinnedAddress("ir.example.com", lookup)).resolves.toEqual({
      address: "2606:4700::1111",
      family: 6,
    });
  });
  it("refuses when ANY resolved address is not routable (A and AAAA both checked)", async () => {
    const lookup = async () => [
      { address: "104.16.0.1", family: 4 as const },
      { address: "fd00::1", family: 6 as const },
    ];
    await expect(resolvePinnedAddress("ir.example.com", lookup)).rejects.toThrow(/non-routable/);
  });
  it("refuses an empty answer", async () => {
    await expect(resolvePinnedAddress("ir.example.com", async () => [])).rejects.toThrow(/no address/);
  });
  it("never calls lookup for a literal IP and validates it directly", async () => {
    let called = false;
    const lookup = async () => {
      called = true;
      return [];
    };
    await expect(resolvePinnedAddress("8.8.8.8", lookup)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expect(resolvePinnedAddress("10.0.0.1", lookup)).rejects.toThrow(/non-routable/);
    expect(called).toBe(false);
  });
});
