import { describe, expect, it } from "vitest";

import { type ClientIpSource, inCidr, ipBuckets, parseIp, resolveClientIp } from "./client-ip.js";

const source = (overrides: Partial<ClientIpSource>): ClientIpSource => ({
  mode: "xff",
  socketAddress: "10.0.0.5",
  hops: 1,
  trustedPeers: ["10.0.0.0/8"],
  ...overrides,
});

const headers = (values: Record<string, string>) => new Headers(values);

describe("parseIp", () => {
  it.each([
    ["192.0.2.1", 4, "c0000201"],
    ["::ffff:192.0.2.1", 4, "c0000201"],
    ["::FFFF:c000:0201", 4, "c0000201"],
    ["2001:db8::1", 6, "20010db8000000000000000000000001"],
    ["::1", 6, "00000000000000000000000000000001"],
    ["::", 6, "00000000000000000000000000000000"],
    ["64:ff9b::192.0.2.1", 6, "0064ff9b0000000000000000c0000201"],
  ])("parses %s", (text, version, hex) => {
    const ip = parseIp(text);
    expect(ip?.version).toBe(version);
    expect(Array.from(ip?.bytes ?? [], (b) => b.toString(16).padStart(2, "0")).join("")).toBe(hex);
  });

  it.each([
    "",
    "256.0.0.1",
    "1.2.3",
    "01.2.3.4",
    "1.2.3.4.5",
    "2001:db8::1::2",
    "1:2:3:4:5:6:7:8:9",
    "[::1]",
    "fe80::1%eth0",
    "example.org",
    "1.2.3.4:80",
  ])("refuses %j", (text) => {
    expect(parseIp(text)).toBeNull();
  });
});

describe("ipBuckets (08 §4.1)", () => {
  it("IPv4: the /32", () => {
    const ip = parseIp("198.51.100.7");
    expect(ip && ipBuckets(ip)).toEqual([{ bucket: "4/c6336407", multiplier: 1 }]);
  });

  it("IPv6: /64 at 1×, /56 at 4×, /48 at 10×", () => {
    const ip = parseIp("2001:db8:aaaa:bbcc:1:2:3:4");
    expect(ip && ipBuckets(ip)).toEqual([
      { bucket: "6/64/20010db8aaaabbcc", multiplier: 1 },
      { bucket: "6/56/20010db8aaaabb", multiplier: 4 },
      { bucket: "6/48/20010db8aaaa", multiplier: 10 },
    ]);
  });

  it("a mapped IPv4 address buckets as IPv4", () => {
    const a = parseIp("::ffff:198.51.100.7");
    const b = parseIp("198.51.100.7");
    expect(a && ipBuckets(a)).toEqual(b && ipBuckets(b));
  });
});

describe("inCidr", () => {
  it.each([
    ["10.1.2.3", "10.0.0.0/8", true],
    ["11.1.2.3", "10.0.0.0/8", false],
    ["172.31.0.1", "172.16.0.0/12", true],
    ["172.32.0.1", "172.16.0.0/12", false],
    ["fd12::1", "fc00::/7", true],
    ["fe80::1", "fc00::/7", false],
    ["127.0.0.1", "::1/128", false],
    ["1.2.3.4", "0.0.0.0/0", true],
  ])("%s in %s: %s", (ip, cidr, expected) => {
    const parsed = parseIp(ip);
    expect(parsed !== null && inCidr(parsed, cidr)).toBe(expected);
  });
});

describe("resolveClientIp (08 §4.1)", () => {
  it("TRUST_PROXY=false: the socket address, whatever the headers say", () => {
    const result = resolveClientIp(
      headers({ "X-Forwarded-For": "1.1.1.1", "CF-Connecting-IP": "2.2.2.2" }),
      source({ mode: "false", socketAddress: "::ffff:203.0.113.9" }),
    );
    expect(result.ok && result.ip.version).toBe(4);
    expect(result.ok && Array.from(result.ip.bytes)).toEqual([203, 0, 113, 9]);
  });

  it("xff: the entry `hops` from the right; spoofed left entries are ignored", () => {
    const xff = "6.6.6.6, 7.7.7.7, 198.51.100.1, 10.0.0.9";
    const one = resolveClientIp(headers({ "X-Forwarded-For": xff }), source({ hops: 1 }));
    const two = resolveClientIp(headers({ "X-Forwarded-For": xff }), source({ hops: 2 }));
    expect(one.ok && Array.from(one.ip.bytes)).toEqual([10, 0, 0, 9]);
    expect(two.ok && Array.from(two.ip.bytes)).toEqual([198, 51, 100, 1]);
  });

  it("xff with fewer entries than hops, or none, is missing (400)", () => {
    expect(resolveClientIp(headers({ "X-Forwarded-For": "1.2.3.4" }), source({ hops: 2 }))).toEqual(
      {
        ok: false,
        reason: "missing",
      },
    );
    expect(resolveClientIp(headers({}), source({}))).toEqual({ ok: false, reason: "missing" });
  });

  it("a peer outside TRUST_PROXY_PEERS is refused in xff and cloudflare modes", () => {
    for (const mode of ["xff", "cloudflare"] as const) {
      expect(
        resolveClientIp(
          headers({ "X-Forwarded-For": "1.2.3.4", "CF-Connecting-IP": "1.2.3.4" }),
          source({ mode, socketAddress: "203.0.113.50" }),
        ),
      ).toEqual({ ok: false, reason: "untrusted-peer" });
    }
  });

  it("cloudflare: CF-Connecting-IP; missing or invalid is missing (400)", () => {
    const ok = resolveClientIp(
      headers({ "CF-Connecting-IP": "2001:db8::7" }),
      source({ mode: "cloudflare" }),
    );
    expect(ok.ok && ok.ip.version).toBe(6);
    for (const value of [undefined, "", "not-an-ip", "1.2.3.4, 5.6.7.8"]) {
      const result = resolveClientIp(
        headers(value === undefined ? {} : { "CF-Connecting-IP": value }),
        source({ mode: "cloudflare" }),
      );
      expect(result).toEqual({ ok: false, reason: "missing" });
    }
  });

  it("Workers (no socket): CF-Connecting-IP without a peer check", () => {
    const result = resolveClientIp(
      headers({ "CF-Connecting-IP": "203.0.113.1" }),
      source({ mode: "cloudflare", socketAddress: null, trustedPeers: [] }),
    );
    expect(result.ok).toBe(true);
  });
});
