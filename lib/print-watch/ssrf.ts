// The SSRF contract for the pasted-URL road (spec §4.2 "URL"). Pure except
// `systemLookup`. Every rule is a named test in tests/print-watch/ssrf.test.ts.
import net from "node:net";
import dns from "node:dns";

export type SsrfVerdict = { ok: true; hostname: string } | { ok: false; reason: string };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

export function validatePublicUrl(raw: string): SsrfVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "only https:// links are accepted" };
  if (url.username || url.password) return { ok: false, reason: "links with embedded credentials are refused" };
  if (url.port && url.port !== "443") return { ok: false, reason: "only port 443 is accepted" };
  // Strip a trailing-dot FQDN (Node's WHATWG URL keeps it: "localhost."
  // survives to url.hostname) and lower-case before any local-name or
  // literal-IP check, so a trailing dot can't smuggle a local host past
  // the guard below. IPv4 literals are already dotted-quad-normalized by
  // the URL parser itself, so this is a no-op for them.
  const hostname = stripBrackets(url.hostname).replace(/\.$/, "").toLowerCase();
  if (!hostname) return { ok: false, reason: "not a valid URL" };
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "local hostnames are refused" };
  }
  if (net.isIP(hostname) !== 0 && !isGloballyRoutable(hostname)) {
    return { ok: false, reason: "address is not globally routable" };
  }
  return { ok: true, hostname };
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** [base, prefix bits] — spec §4.2: loopback, RFC1918, link-local (incl. the
 *  cloud-metadata address), CGNAT, benchmarking, documentation, multicast,
 *  reserved, broadcast, and "this network". */
const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function inV4Block(ip: number, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

/** Eight 16-bit words, or null when the text is not an IPv6 address. Handles
 *  `::` compression and an embedded dotted-quad tail (`::ffff:1.2.3.4`). */
function expandIpv6(ip: string): number[] | null {
  let s = ip;
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (net.isIP(tail[1]) !== 4) return null;
    const n = ipv4ToInt(tail[1]);
    s = `${s.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
  return parts.map((p) => Number.parseInt(p, 16));
}

export function isGloballyRoutable(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return !IPV4_BLOCKED.some((block) => inV4Block(n, block));
  }
  if (family !== 6) return false;
  const w = expandIpv6(ip);
  if (!w) return false;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroPrefix = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (w.every((x) => x === 0)) return false;                        // ::
  if (zeroPrefix(7) && w[7] === 1) return false;                    // ::1
  if (zeroPrefix(5) && w[5] === 0xffff) return isGloballyRoutable(embeddedV4(w[6], w[7]));   // ::ffff:0:0/96 mapped
  if (zeroPrefix(6)) return isGloballyRoutable(embeddedV4(w[6], w[7]));                     // ::/96 IPv4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return false;                         // 64:ff9b:1::/48 local NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    return isGloballyRoutable(embeddedV4(w[6], w[7]));                                      // 64:ff9b::/96 NAT64
  }
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return false;               // 100::/64 discard
  if (w[0] === 0x2002) return isGloballyRoutable(embeddedV4(w[1], w[2]));                    // 2002::/16 6to4
  if (w[0] === 0x2001 && w[1] === 0) return false;                                          // 2001::/32 Teredo
  if (w[0] === 0x2001 && (w[1] & 0xfff0) === 0x0010) return false;                         // 2001:10::/28 ORCHID
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false;                                     // 2001:db8::/32 documentation
  if ((w[0] & 0xfe00) === 0xfc00) return false;                                             // fc00::/7 ULA
  if ((w[0] & 0xffc0) === 0xfe80) return false;                                             // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return false;                                             // fec0::/10 site-local
  if ((w[0] & 0xff00) === 0xff00) return false;                                             // ff00::/8 multicast
  return true;
}

export const systemLookup: LookupFn = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((r) => ({
    address: r.address,
    family: r.family as 4 | 6,
  }));

/** Resolve A and AAAA; EVERY address must be globally routable. Returns the
 *  first, which the caller pins into the socket's `lookup`. */
export async function resolvePinnedAddress(
  hostname: string,
  lookup: LookupFn = systemLookup,
): Promise<ResolvedAddress> {
  const literal = net.isIP(hostname);
  const results: ResolvedAddress[] =
    literal !== 0 ? [{ address: hostname, family: literal as 4 | 6 }] : await lookup(hostname);
  if (results.length === 0) throw new Error(`${hostname}: no address`);
  for (const r of results) {
    if (!isGloballyRoutable(r.address)) throw new Error(`${hostname}: resolves to a non-routable address`);
  }
  return results[0];
}
