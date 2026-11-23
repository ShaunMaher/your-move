import { describe, expect, it } from "vitest";

import {
  contentSecurityPolicy,
  renderHeadersFile,
  securityHeaders,
  staticCacheControl,
} from "./security-headers.js";

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'";

describe("contentSecurityPolicy", () => {
  it("is exactly the policy in 08 §3", () => {
    expect(contentSecurityPolicy({ turnstile: false })).toBe(EXPECTED_CSP);
  });

  it("adds the Turnstile origin to script-src and frame-src only when enabled", () => {
    const csp = contentSecurityPolicy({ turnstile: true });
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com;");
    expect(csp).toMatch(/; frame-src https:\/\/challenges\.cloudflare\.com$/u);
  });

  it.each([false, true])(
    "never allows unsafe-inline or unsafe-eval (turnstile %s)",
    (turnstile) => {
      expect(contentSecurityPolicy({ turnstile })).not.toMatch(/unsafe-/u);
    },
  );
});

describe("securityHeaders", () => {
  it("sends HSTS only for https deployments", () => {
    expect(securityHeaders({ hsts: true, turnstile: false })).toHaveProperty(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
    expect(securityHeaders({ hsts: false, turnstile: false })).not.toHaveProperty(
      "Strict-Transport-Security",
    );
  });

  it("includes every other header from 08 §3", () => {
    expect(securityHeaders({ hsts: false, turnstile: false })).toEqual({
      "Content-Security-Policy": EXPECTED_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });
});

describe("staticCacheControl", () => {
  it.each([
    ["/assets/index-abc123.js", "public, max-age=31536000, immutable"],
    ["/", "no-cache"],
    ["/index.html", "no-cache"],
    ["/sw.js", "no-cache"],
    ["/manifest.webmanifest", "no-cache"],
    ["/g/123", "no-cache"],
  ])("%s → %s", (path, expected) => {
    expect(staticCacheControl(path)).toBe(expected);
  });
});

describe("renderHeadersFile", () => {
  /** Parses a `_headers` file into path → headers. */
  function parse(file: string): Map<string, Record<string, string>> {
    const rules = new Map<string, Record<string, string>>();
    let current: Record<string, string> | null = null;
    for (const line of file.split("\n")) {
      if (line === "" || line.startsWith("#")) continue;
      if (line.startsWith("  ")) {
        const [name, ...rest] = line.trim().split(": ");
        if (current && name) current[name] = rest.join(": ");
      } else {
        current = {};
        rules.set(line, current);
      }
    }
    return rules;
  }

  it("carries exactly the shared security headers for every static path", () => {
    for (const options of [
      { hsts: true, turnstile: false },
      { hsts: false, turnstile: true },
    ]) {
      expect(parse(renderHeadersFile(options)).get("/*")).toEqual(securityHeaders(options));
    }
  });

  it("caches hashed assets forever and revalidates the shell", () => {
    const rules = parse(renderHeadersFile({ hsts: true, turnstile: false }));
    expect(rules.get("/assets/*")).toEqual({ "Cache-Control": staticCacheControl("/assets/x.js") });
    for (const path of ["/", "/index.html", "/sw.js"]) {
      expect(rules.get(path)).toEqual({ "Cache-Control": "no-cache" });
    }
  });

  it("sets Cache-Control on non-overlapping rules only (Cloudflare joins repeated headers)", () => {
    const rules = parse(renderHeadersFile({ hsts: true, turnstile: false }));
    expect(rules.get("/*")).not.toHaveProperty("Cache-Control");
  });
});
