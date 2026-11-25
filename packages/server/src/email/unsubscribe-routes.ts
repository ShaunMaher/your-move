/**
 * The unsubscribe route (docs/spec/05-api.md §Email links, 08 T6, T17): a server-rendered page
 * under `/api/` so it is always server-handled (03 §9). GET shows the page and never changes
 * state; POST (RFC 8058 one-click from a mail client, or the page's button) acts on the token.
 * Both answer `200` with the same page whatever the token, and are exempt from the Origin and JSON
 * rules (`http/request-rules.ts`). Not an OpenAPI operation: it serves HTML, not the JSON API.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { Subkeys } from "../crypto/subkeys.js";
import type { AppEnv, Platform } from "../platform.js";
import { escapeHtml } from "./templates.js";
import {
  UNSUBSCRIBE_PATH,
  type UnsubscribePurpose,
  verifyUnsubscribeToken,
} from "./unsubscribe-token.js";

interface PageText {
  readonly heading: string;
  readonly message: string;
}

const INVALID: PageText = {
  heading: "This link isn't valid",
  message:
    "It may have been copied incompletely. If you have an account, you can choose which emails you get in Settings.",
};

const CONFIRM: Readonly<Record<UnsubscribePurpose, PageText & { readonly button: string }>> = {
  nudges: {
    heading: 'Stop "It\'s your turn" emails?',
    message:
      "You'll no longer get an email when a game has been waiting for you. You can turn them back on in Settings.",
    button: "Turn off email nudges",
  },
  invites: {
    heading: "Stop invitation emails?",
    message: "This address won't get any more emails inviting it to play.",
    button: "Don't send me invites again",
  },
};

const DONE: Readonly<Record<UnsubscribePurpose, PageText>> = {
  nudges: {
    heading: "Email nudges are off",
    message:
      "You won't get \"It's your turn\" emails any more. You can turn them back on in Settings.",
  },
  invites: {
    heading: "No more invitation emails",
    message: "This address won't get any more emails inviting it to play.",
  },
};

interface PageOptions {
  readonly appName: string;
  readonly publicUrl: string;
  readonly text: PageText;
  /** The confirm form: its button and the (already verified) token it posts back. */
  readonly form?: { readonly button: string; readonly token: string };
}

/** The page: plain HTML, no scripts or styles (the CSP allows neither inline), every value escaped. */
function unsubscribePage(options: PageOptions): string {
  const { appName, text, form } = options;
  const formHtml =
    form === undefined
      ? ""
      : `<form method="post" action="${escapeHtml(`${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(form.token)}`)}">` +
        `<input type="hidden" name="List-Unsubscribe" value="One-Click">` +
        `<button type="submit">${escapeHtml(form.button)}</button></form>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(`${text.heading} · ${appName}`)}</title></head>` +
    `<body><main><h1>${escapeHtml(text.heading)}</h1><p>${escapeHtml(text.message)}</p>${formHtml}` +
    `<p><a href="${escapeHtml(new URL("/", options.publicUrl).toString())}">Go to ${escapeHtml(appName)}</a></p>` +
    `</main></body></html>`
  );
}

export interface UnsubscribeRouteOptions {
  readonly platform: Platform;
  readonly keys: () => Promise<Subkeys>;
}

export function registerUnsubscribeRoutes(
  app: OpenAPIHono<AppEnv>,
  options: UnsubscribeRouteOptions,
): void {
  const { platform } = options;
  const { config, repos } = platform;
  const page = (text: PageText, form?: PageOptions["form"]): string =>
    unsubscribePage({
      appName: config.appName,
      publicUrl: config.publicUrl,
      text,
      ...(form === undefined ? {} : { form }),
    });

  // Never changes state (08 T6): a link scanner fetching it does nothing.
  app.get(UNSUBSCRIBE_PATH, async (c) => {
    const token = c.req.query("t");
    const claim = await verifyUnsubscribeToken(await options.keys(), token);
    if (claim === null || token === undefined) return c.html(page(INVALID), 200);
    const confirm = CONFIRM[claim.purpose];
    return c.html(page(confirm, { button: confirm.button, token }), 200);
  });

  // The token is the authority; the form body (`List-Unsubscribe=One-Click`) isn't needed or read.
  app.post(UNSUBSCRIBE_PATH, async (c) => {
    const claim = await verifyUnsubscribeToken(await options.keys(), c.req.query("t"));
    if (claim === null) return c.html(page(INVALID), 200);
    const at = platform.now().getTime();
    if (claim.purpose === "invites") {
      await repos.emailSuppressions.suppress(claim.emailId, "unsubscribed", at);
    } else {
      await repos.users.disableNudgesByEmailId(claim.emailId, at);
    }
    platform.log.info("unsubscribed", { purpose: claim.purpose });
    return c.html(page(DONE[claim.purpose]), 200);
  });
}
