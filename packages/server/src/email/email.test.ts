import { describe, expect, it } from "vitest";

import { normaliseAddress } from "../accounts/email.js";
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
  invitationEmail,
  nudgeEmail,
  signInCodeEmail,
  suspendedNoticeEmail,
} from "./templates.js";

const address = normaliseAddress("sam@example.org");
if (address === null) throw new Error("test address is invalid");
const to = address;
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

describe("the email nudge (03 §7, 08 T18)", () => {
  const nudge = {
    appName: context.appName,
    gameName: "Words",
    opponents: ['Ann <img src=x onerror="y">', "Bo\r\nBcc: x@example.org", "Cy"],
    lastMove: "Ann <b>played</b> QUIZ for 64",
    gameUrl: "https://play.example.org/g/g1",
    settingsUrl: "https://play.example.org/settings",
    unsubscribeUrl: 'https://play.example.org/api/v1/email/unsubscribe?t=a"b',
  };

  it("names the game and the others, links the game, and carries the unsubscribe link", () => {
    const message = nudgeEmail(to, nudge);
    expect(message.subject).toBe(`It's your turn in Words on ${context.appName}`);
    expect(message.listUnsubscribe).toBe(nudge.unsubscribeUrl);
    expect(message.text).toContain(
      `in your Words game with ${nudge.opponents[0] ?? ""}, ${nudge.opponents[1] ?? ""} and Cy.`,
    );
    expect(message.text).toContain(`Last move: ${nudge.lastMove}`);
    expect(message.text).toContain(`Play now: ${nudge.gameUrl}`);
    expect(message.text).toContain(`Or unsubscribe with one click: ${nudge.unsubscribeUrl}`);
  });

  it("escapes every value in the HTML, links included", () => {
    const { html } = nudgeEmail(to, nudge);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;y&quot;&gt;");
    expect(html).toContain('<a href="https://play.example.org/g/g1">');
    expect(html).toContain('href="https://play.example.org/api/v1/email/unsubscribe?t=a&quot;b"');
  });

  it("leaves out what it doesn't have", () => {
    const message = nudgeEmail(to, { ...nudge, opponents: [], lastMove: null });
    expect(message.text).toContain("in your Words game. It has been");
    expect(message.text).not.toContain("Last move");
    expect(nudgeEmail(to, { ...nudge, opponents: ["Ann"] }).text).toContain("game with Ann.");
  });
});

describe("the invite email (06 §6.3, alpha A17)", () => {
  const invitation = {
    appName: context.appName,
    publicUrl: "https://play.example.org",
    inviterName: 'Ann <img src=x onerror="y">',
    inviterEmail: "ann@example.org",
    gameName: "Words",
    openDays: 14,
    unsubscribeUrl: 'https://play.example.org/api/v1/email/unsubscribe?t=a"b',
  };

  it("names the inviter and the game, says how to join, and carries the unsubscribe link", () => {
    const message = invitationEmail(to, invitation);
    expect(message.to).toBe(to);
    expect(message.subject).toBe(
      `${invitation.inviterName} invited you to play Words on ${context.appName}`,
    );
    expect(message.listUnsubscribe).toBe(invitation.unsubscribeUrl);
    expect(message.text).toContain(
      `${invitation.inviterName} (ann@example.org) has invited you to play Words on ${context.appName}.`,
    );
    expect(message.text).toContain("The invitation stays open for 14 days.");
    // No per-move limit until turn timeouts exist (06 §6.3).
    expect(message.text).not.toContain("each move");
    // One day is singular.
    expect(invitationEmail(to, { ...invitation, openDays: 1 }).text).toContain("open for 1 day.");
    expect(message.text).toContain(
      "To join, sign in with this email address at https://play.example.org",
    );
    expect(message.text).toContain(`Don't send me invites again: ${invitation.unsubscribeUrl}`);
  });

  it("escapes every value in the HTML, links included", () => {
    const { html } = invitationEmail(to, invitation);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=&quot;y&quot;&gt;");
    expect(html).toContain('<a href="https://play.example.org">');
    expect(html).toContain('href="https://play.example.org/api/v1/email/unsubscribe?t=a&quot;b"');
  });

  it("is refused by the header check when the inviter's name would break the subject (08 T14)", () => {
    const message = invitationEmail(to, {
      ...invitation,
      inviterName: "Ann\r\nBcc: x@example.org",
    });
    expect(() => {
      assertSafeHeaders(message);
    }).toThrow(EmailHeaderError);
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

  it("refuses an unsubscribe URL with a control character", () => {
    expect(() => {
      assertSafeHeaders({
        to,
        subject: "x",
        text: "",
        html: "",
        listUnsubscribe: "https://a\r\nB: c",
      });
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
  it("drops every send with one error-level alert in the log", async () => {
    const { log, lines } = logger();
    const sender = createUnavailableEmailSender("resend", log);
    await expect(sender.send(accountDeletedEmail(to, context))).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({
      level: "error",
      alert: "email_provider_unavailable",
      provider: "resend",
    });
  });
});
