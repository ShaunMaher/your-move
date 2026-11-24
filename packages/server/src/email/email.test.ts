import { describe, expect, it } from "vitest";

import { normaliseAddress, type NormalisedEmail } from "../accounts/email.js";
import { createJsonLogger } from "../log.js";
import {
  assertSafeHeaders,
  createConsoleEmailSender,
  createUnavailableEmailSender,
  EmailHeaderError,
} from "./sender.js";
import {
  accountDeletedEmail,
  deleteAccountCodeEmail,
  escapeHtml,
  signInCodeEmail,
  suspendedNoticeEmail,
} from "./templates.js";

const to = normaliseAddress("sam@example.org") as NormalisedEmail;
const context = {
  appName: 'Games <b>&</b> "Co"',
  publicUrl: "https://play.example.org",
  requestedAt: "2026-01-01 09:00 UTC",
};

function logger() {
  const lines: Record<string, unknown>[] = [];
  const now = () => new Date(0);
  return {
    lines,
    now,
    log: createJsonLogger({
      level: "debug",
      now,
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
}

describe("templates (06 §3.3, §7)", () => {
  it("the sign-in email: subject, grouped code, expiry, warnings, time, and no link with the code", () => {
    const message = signInCodeEmail(to, "12345678", context);
    expect(message.subject).toBe(`12345678 is your ${context.appName} sign-in code`);
    expect(message.text).toContain("1234 5678");
    expect(message.text).toContain("It expires in 10 minutes.");
    expect(message.text).toContain("We will never ask you for this code");
    expect(message.text).toContain("If you didn't request this, ignore this email.");
    expect(message.text).toContain("2026-01-01 09:00 UTC");
    expect(message.text).toContain("https://play.example.org");
    expect(message.text).not.toContain("https://play.example.org/?");
    expect(message.html).not.toContain("href");
  });

  it("escapes every interpolated value in the HTML part", () => {
    for (const message of [
      signInCodeEmail(to, "12345678", context),
      suspendedNoticeEmail(to, context),
      deleteAccountCodeEmail(to, "12345678", context),
      accountDeletedEmail(to, context),
    ]) {
      expect(message.html).not.toContain("<b>");
      expect(message.html).toContain("&lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;");
    }
    expect(escapeHtml(`<'&">`)).toBe("&lt;&#39;&amp;&quot;&gt;");
  });

  it("each purpose has its own subject naming the action", () => {
    const subjects = [
      signInCodeEmail(to, "12345678", context).subject,
      suspendedNoticeEmail(to, context).subject,
      deleteAccountCodeEmail(to, "12345678", context).subject,
      accountDeletedEmail(to, context).subject,
    ];
    expect(new Set(subjects).size).toBe(4);
    expect(subjects[2]).toContain("delete your");
  });
});

describe("header safety (08 T14)", () => {
  it.each([
    "Hello\r\nBcc: victim@example.org",
    "Hello\nBcc: x",
    "Hello\rX",
    "Tab\there",
    "Nul\u0000",
  ])("refuses a subject with a control character: %j", (subject) => {
    expect(() => {
      assertSafeHeaders({ to, subject, text: "", html: "" });
    }).toThrow(EmailHeaderError);
  });

  it("accepts long and non-ASCII subjects", () => {
    expect(() => {
      assertSafeHeaders({ to, subject: `Zoë ${"é".repeat(300)} 李`, text: "", html: "" });
    }).not.toThrow();
  });
});

describe("console provider (local-dev only)", () => {
  it("captures messages and logs no contents", async () => {
    const { log, lines, now } = logger();
    const sender = createConsoleEmailSender(log, now);
    await sender.send(signInCodeEmail(to, "12345678", context));
    expect(sender.captured()).toHaveLength(1);
    expect(sender.captured()[0]?.sentAt).toBe("1970-01-01T00:00:00.000Z");
    expect(JSON.stringify(lines)).not.toContain("12345678");
    expect(JSON.stringify(lines)).not.toContain("sam@example.org");
  });

  it("refuses a message with an injected header", async () => {
    const { log, now } = logger();
    const sender = createConsoleEmailSender(log, now);
    await expect(sender.send({ to, subject: "x\r\nBcc: y", text: "", html: "" })).rejects.toThrow(
      EmailHeaderError,
    );
    expect(sender.captured()).toHaveLength(0);
  });

  it("keeps at most 200 messages", async () => {
    const { log, now } = logger();
    const sender = createConsoleEmailSender(log, now);
    for (let i = 0; i < 205; i++) await sender.send(accountDeletedEmail(to, context));
    expect(sender.captured()).toHaveLength(200);
  });
});

describe("unavailable provider", () => {
  it("fails every send with an alert in the log", async () => {
    const { log, lines } = logger();
    const sender = createUnavailableEmailSender("resend", log);
    await expect(sender.send(accountDeletedEmail(to, context))).rejects.toThrow(/resend/u);
    expect(lines.at(-1)).toMatchObject({ alert: "email_provider_unavailable", provider: "resend" });
  });
});
