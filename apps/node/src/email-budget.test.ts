/**
 * The outbound email budget's guard (docs/spec/08-security.md §4.2): every email the server sends
 * counts toward one of the instance-wide day caps. A tripwire, not a proof: a source scan of the
 * server and both runtimes finds the usual shapes of a send (`email.send(`, `email?.send(`, or
 * `.send(` on the next line) and every call of an exported email template, and each file must be
 * listed here with the counting it goes through. A send written some other way gets past it;
 * review covers that. The behaviour of each listed path is tested where it lives (auth, invites,
 * nudges).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCANNED = ["packages/server/src", "apps/node/src", "apps/worker/src"];
const TEMPLATES = "packages/server/src/email/templates.ts";

/**
 * Every file that sends or builds an email: the number of `….email.send(` calls in it, and for
 * each template it calls, the function that counts that email toward its cap (which must appear
 * in the same file).
 */
const COUNTED: Readonly<
  Record<string, { readonly sends: number; readonly templates: Readonly<Record<string, string>> }>
> = {
  // OTP_EMAIL_GLOBAL_HOUR and _DAY: the code or notice of /otp/request, step-up codes and the
  // account-deleted confirmation.
  "packages/server/src/auth/routes.ts": {
    sends: 2,
    templates: {
      signInCodeEmail: "issueSignInCode",
      suspendedNoticeEmail: "issueSignInCode",
      deleteAccountCodeEmail: "issueStepUpCode",
      accountDeletedEmail: "takeOtpEmailRoom",
    },
  },
  // INVITE_EMAILS_GLOBAL_DAY: the invite email and, since alpha A20, the invitation email to a
  // user with email nudges on (06 §6.2), through the same tiers.
  "packages/server/src/games/invite-mail.ts": {
    sends: 1,
    templates: {
      invitationEmail: '"INVITE_EMAILS_GLOBAL_DAY"',
      invitationNudgeEmail: '"INVITE_EMAILS_GLOBAL_DAY"',
    },
  },
  // NUDGE_EMAILS_PER_DAY.
  "packages/server/src/sweep/nudges.ts": {
    sends: 1,
    templates: { nudgeEmail: '"NUDGE_EMAILS_PER_DAY"' },
  },
};

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)))
    .filter(
      (path) => !/\.test\.ts$|-contract\.ts$|test-support\.ts$|test-harness\.ts$/u.test(path),
    );
}

const templateNames = [
  ...readFileSync(join(ROOT, TEMPLATES), "utf8").matchAll(/^export function (\w+Email)\(/gmu),
].map((match) => match[1] ?? "");

/** What each scanned file sends and builds. */
function found(): Record<string, { sends: number; templates: Record<string, number> }> {
  const result: Record<string, { sends: number; templates: Record<string, number> }> = {};
  for (const path of SCANNED.flatMap(sources)) {
    if (path === TEMPLATES) continue;
    const text = readFileSync(join(ROOT, path), "utf8");
    const sends = text.match(/\bemail\??\s*\.\s*send\(/gu)?.length ?? 0;
    const templates: Record<string, number> = {};
    for (const name of templateNames) {
      const uses = text.match(new RegExp(`\\b${name}\\(`, "gu"))?.length ?? 0;
      if (uses > 0) templates[name] = uses;
    }
    if (sends > 0 || Object.keys(templates).length > 0) result[path] = { sends, templates };
  }
  return result;
}

describe("the outbound email budget's guard (08 §4.2)", () => {
  it("finds the templates", () => {
    expect(templateNames).toEqual(
      expect.arrayContaining([
        "signInCodeEmail",
        "invitationEmail",
        "invitationNudgeEmail",
        "nudgeEmail",
      ]),
    );
  });

  it("every email sent is one listed with the cap it counts toward", () => {
    const expected = Object.fromEntries(
      Object.entries(COUNTED).map(([path, { sends, templates }]) => [
        path,
        { sends, templates: Object.fromEntries(Object.keys(templates).map((name) => [name, 1])) },
      ]),
    );
    expect(found()).toEqual(expected);
  });

  it("each listed file goes through the counting named for its templates", () => {
    for (const [path, { templates }] of Object.entries(COUNTED)) {
      const text = readFileSync(join(ROOT, path), "utf8");
      for (const counting of Object.values(templates)) {
        expect({ path, counting, present: text.includes(counting) }).toMatchObject({
          present: true,
        });
      }
    }
  });
});
