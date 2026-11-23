import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { resolveSecretFiles, scrubSecrets, SecretFileError } from "./env.js";

const files = (contents: Record<string, string>) => (path: string) => {
  const content = contents[path];
  if (content === undefined) throw new Error(`ENOENT: ${path}`);
  return content;
};

describe("resolveSecretFiles", () => {
  it("reads <NAME>_FILE into <NAME>, trimming exactly one trailing newline", () => {
    const env = resolveSecretFiles(
      { APP_SECRET_FILE: "/run/secrets/a", SMTP_URL_FILE: "/run/secrets/b", PORT: "8080" },
      files({ "/run/secrets/a": "secret\n\n", "/run/secrets/b": "smtp://x\r\n" }),
    );
    expect(env["APP_SECRET"]).toBe("secret\n");
    expect(env["SMTP_URL"]).toBe("smtp://x");
    expect(env["PORT"]).toBe("8080");
  });

  it("allows <NAME> and <NAME>_FILE together only when equal", () => {
    expect(
      resolveSecretFiles({ APP_SECRET: "same", APP_SECRET_FILE: "/s" }, files({ "/s": "same\n" }))[
        "APP_SECRET"
      ],
    ).toBe("same");
    expect(() =>
      resolveSecretFiles({ APP_SECRET: "one", APP_SECRET_FILE: "/s" }, files({ "/s": "two" })),
    ).toThrow(
      new SecretFileError(
        "Invalid configuration:\n  - APP_SECRET, APP_SECRET_FILE: both are set and they differ",
      ),
    );
  });

  it("names an unreadable file without its path or contents", () => {
    expect(() => resolveSecretFiles({ EMAIL_API_KEY_FILE: "/missing" }, files({}))).toThrow(
      /EMAIL_API_KEY_FILE: cannot read the file it names$/u,
    );
  });

  it("ignores _FILE for variables that are not secrets", () => {
    expect(resolveSecretFiles({ PORT_FILE: "/p" }, files({ "/p": "1" }))["PORT"]).toBeUndefined();
  });

  it("never puts a secret value in an error", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        fc.pre(a !== b && a.replace(/\r?\n$/u, "") !== b);
        try {
          resolveSecretFiles({ APP_SECRET: b, APP_SECRET_FILE: "/s" }, files({ "/s": a }));
        } catch (error) {
          const message = (error as Error).message;
          expect(message.includes(a) && a.length > 3).toBe(false);
          expect(message.includes(b) && b.length > 3).toBe(false);
        }
      }),
    );
  });
});

describe("scrubSecrets", () => {
  it("removes secrets and their _FILE variables, leaving the rest", () => {
    const env: Record<string, string | undefined> = {
      APP_SECRET: "s",
      APP_SECRET_FILE: "/s",
      GMAIL_REFRESH_TOKEN: "t",
      PUBLIC_URL: "https://example.org",
    };
    scrubSecrets(env);
    expect(env).toEqual({ PUBLIC_URL: "https://example.org" });
  });
});
