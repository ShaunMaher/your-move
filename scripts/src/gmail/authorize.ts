/**
 * `pnpm gmail:authorize` (docs/spec/09-operations.md §2, operator setup step 3): the one-time
 * OAuth flow that gives the server a refresh token for the dedicated sender user.
 *
 * Authorization code flow with PKCE and a random `state`, on a loopback redirect bound to
 * 127.0.0.1 (a random port), `login_hint` set to the sender, exactly the scopes
 * `openid email gmail.send` and never `include_granted_scopes`. The result is refused (and the
 * token revoked) unless the granted scopes are exactly those and the `id_token` is the sender's
 * own, for this client. The refresh token is written to a new 0600 file and never printed.
 */
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  GMAIL_SEND_SCOPE,
  grantedScopes,
  idTokenClaims,
  isExpectedScopes,
  toBase64Url,
} from "@your-move/server";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REQUESTED_SCOPE = `openid email ${GMAIL_SEND_SCOPE}`;

export interface AuthorizeOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `GMAIL_SENDER`: the address the token must belong to. */
  readonly sender: string;
  /** Where the refresh token goes: a new file, created 0600. */
  readonly outFile: string;
  readonly fetch: typeof fetch;
  /** Prints a line for the operator. Never receives a secret. */
  readonly print: (line: string) => void;
  readonly now: () => Date;
  /** Fills the array with random bytes. */
  readonly random: (bytes: Uint8Array<ArrayBuffer>) => void;
  readonly timeoutMs: number;
}

/** A refusal with a message that is safe to print. */
export class AuthorizeError extends Error {
  override readonly name = "AuthorizeError";
}

/** Waits for the one redirect to `/callback` that carries our `state`, then answers it. */
function waitForCode(server: Server, state: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuthorizeError("timed out waiting for the browser to return; run it again"));
    }, timeoutMs);
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      settle();
    };
    server.on("request", (request, response) => {
      const port = (server.address() as AddressInfo).port;
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port.toString()}`);
      const text = (status: number, body: string): void => {
        response.writeHead(status, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(body);
      };
      // Anything but our own redirect (another page, another Host, a stale or forged state) is
      // answered and ignored; only the right `state` can finish the flow.
      if (
        request.method !== "GET" ||
        url.pathname !== "/callback" ||
        request.headers.host !== `127.0.0.1:${port.toString()}` ||
        url.searchParams.get("state") !== state
      ) {
        text(400, "Not the expected request.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error !== null || code === null) {
        text(400, "Authorization was not granted. You can close this tab.");
        finish(() => {
          reject(new AuthorizeError("the authorization was denied or incomplete"));
        });
        return;
      }
      text(200, "Authorization received. You can close this tab and return to the terminal.");
      finish(() => {
        resolve(code);
      });
    });
  });
}

/** Revokes `token`; true only when Google answered success. */
async function revoke(options: AuthorizeOptions, token: string): Promise<boolean> {
  try {
    const response = await options.fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** The sentence for the operator after a revoke attempt. */
async function revokeAndDescribe(options: AuthorizeOptions, token: string): Promise<string> {
  return (await revoke(options, token))
    ? "The token was discarded and revoked"
    : "The token was discarded, but revocation failed: remove the app's access in the account's security settings";
}

/** Runs the flow; throws {@link AuthorizeError} when the result can't be used. */
export async function authorize(options: AuthorizeOptions): Promise<void> {
  const verifierBytes = new Uint8Array(32);
  const stateBytes = new Uint8Array(24);
  options.random(verifierBytes);
  options.random(stateBytes);
  const verifier = toBase64Url(verifierBytes);
  const state = toBase64Url(stateBytes);
  const challenge = toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port.toString()}/callback`;
    const authorizationUrl = new URL(AUTH_URL);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: options.clientId,
      redirect_uri: redirectUri,
      scope: REQUESTED_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      login_hint: options.sender,
    })) {
      authorizationUrl.searchParams.set(name, value);
    }
    options.print(`Open this address in a browser on this machine, signed in as ${options.sender}`);
    options.print("(the dedicated sender user, not an administrator account):");
    options.print("");
    options.print(authorizationUrl.toString());
    options.print("");
    options.print("Waiting for Google to redirect back to this machine...");

    const code = await waitForCode(server, state, options.timeoutMs);
    const response = await options.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      refresh_token?: unknown;
      scope?: unknown;
      id_token?: unknown;
    } | null;
    if (!response.ok) {
      throw new AuthorizeError(
        `Google refused the authorization code (HTTP ${response.status.toString()})`,
      );
    }
    const refreshToken = body?.refresh_token;
    if (typeof refreshToken !== "string" || refreshToken === "") {
      throw new AuthorizeError(
        "Google returned no refresh token: remove this app's access in the sender's Google account and run it again",
      );
    }

    const problem = ((): string | null => {
      if (!isExpectedScopes(grantedScopes(body?.scope))) {
        return "the granted scopes are not exactly openid, email and gmail.send";
      }
      const claims = typeof body?.id_token === "string" ? idTokenClaims(body.id_token) : null;
      if (claims === null) return "Google returned no usable id_token";
      const issuer = claims["iss"];
      if (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") {
        return "the id_token has an unexpected issuer";
      }
      if (claims["aud"] !== options.clientId) return "the id_token is for another client";
      const expires = claims["exp"];
      if (typeof expires !== "number" || expires * 1000 <= options.now().getTime()) {
        return "the id_token has expired";
      }
      if (claims["email_verified"] !== true && claims["email_verified"] !== "true") {
        return "the account's email address is not verified";
      }
      const email = claims["email"];
      if (typeof email !== "string" || email.toLowerCase() !== options.sender.toLowerCase()) {
        return "you authorised as a different account than GMAIL_SENDER";
      }
      return null;
    })();
    if (problem !== null) {
      throw new AuthorizeError(
        `refused: ${problem}. ${await revokeAndDescribe(options, refreshToken)}; nothing was written`,
      );
    }

    try {
      await writeFile(options.outFile, `${refreshToken}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      throw new AuthorizeError(
        `could not create the output file (it must not exist yet). ${await revokeAndDescribe(options, refreshToken)}; run it again`,
      );
    }
    options.print(`Refresh token written to ${options.outFile} (mode 0600).`);
    options.print("Give it to the server as the secret GMAIL_REFRESH_TOKEN (docs/deploy.md).");
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
