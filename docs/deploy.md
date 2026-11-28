# Deploying

This page grows with the milestones; today it covers the Docker image, the `gmail` email provider and the Cloudflare Tunnel deployment (the proof of concept). The specification is
[`docs/spec/09-operations.md`](spec/09-operations.md).

## Configuration

Every variable is listed, with its rules, in [`.env.example`](../.env.example) and
[09 §1](spec/09-operations.md). The server refuses to start on invalid configuration, naming each
variable and rule but never a secret's value.

**On Docker, give secrets as files:** `NAME_FILE=/run/secrets/name` (Docker secrets) wins over
`NAME`, so secrets don't show up in `docker inspect`. The server also removes secrets from
`process.env` after reading them, before any game code loads. That guards against accidental
leaks (a library logging its environment, say), **not** against code that goes looking for
secrets: the process's original environment stays readable from `/proc/self/environ`. Secrets
given as files never enter the environment at all, which is why `*_FILE` is the recommended way.

Generate `APP_SECRET` with `openssl rand -base64 32`. **Rotating `APP_SECRET` is unsupported**
until the re-keying job described in 09 §1.1 exists: changing it silently empties the email
suppression list.

If you remove an installed game, also remove its `GAMES_<TYPE>_*` variables: a variable for a
game type that isn't installed refuses to start the server (09 §1.3).

## Docker

Images are built by CI for `linux/amd64` and `linux/arm64` and pushed to this project's container
registry from `main` and `v*` tags only. **Deploy by digest**, never by tag:

```yaml
image: registry.example.org/group/your-move/server@sha256:<digest from the pipeline>
```

Tags (`<commit>`, `v*`) are for humans; images aren't signed yet (08 §6), so the digest is what
ties a deployment to the pipeline that built it. Each image's labels name the commit
(`org.opencontainers.image.revision`) and the pipeline (`com.gitlab.ci.pipeline.id`,
`com.gitlab.ci.pipeline.url`), and a CycloneDX SBOM of each image is kept with the pipeline's
artifacts. Release notes recording digests arrive in M1.

The container runs as an unprivileged user, serves on port 8080, keeps its data in `/data`, and
works with a read-only root filesystem (`read_only: true` in compose, or `docker run --read-only`).
It starts with `node --disallow-code-generation-from-strings` and refuses to start if code
generation from strings turns out to be allowed. Its health check calls `/api/health`.

The database is one SQLite file, `DATABASE_PATH` (default `/data/app.sqlite`; an absolute path), in WAL
mode. At every start the server first validates its whole configuration, then takes the
single-instance lock, applies any new migrations (all in one transaction), and refuses to start if
a `lobby` or `active` game needs a game type or rules version this image doesn't install (02 §7.3).
Finish or cancel those games first; or, to accept that exactly those games become orphaned, start
with `ALLOW_ORPHAN_GAMES` set to the 12-character digest the refusal printed (a value left set
matches no later set, so it is safe to leave, though you should remove it). **Until M3 nothing
cancels an orphaned game**: it keeps its state, and M3 adds the `409 GAME_UNAVAILABLE` answer and the
sweep that cancels it. The server also refuses a database that a newer image has migrated (or
whose applied migration was edited): roll forward, or restore a backup.

Run one container per database file: a second one on the same file refuses to start (it finds the
first one's lock on `<DATABASE_PATH>.lock`, which the operating system releases when that process
exits, even after a crash).

The database, its `-wal`/`-shm` files and the lock file are created readable by the server's user
only (0600), and the image makes `/data` 0700. A named Docker volume inherits that. With a **bind
mount** the host directory's own permissions apply: make it owned by the image's `node` user (UID 1000) and mode 0700, and don't put it where other host users can read it. The server logs a warning at startup while the database directory has any group or other permission bits.

To build and try it locally:

```sh
docker build -f apps/node/Dockerfile -t your-move-server .
docker run --rm --read-only -p 127.0.0.1:8080:8080 \
  -e PUBLIC_URL=https://play.example.org -e APP_SECRET="$(openssl rand -base64 32)" \
  -e EMAIL_PROVIDER=smtp -e SMTP_URL=smtp://mail.example.org:587 \
  -e EMAIL_FROM=no-reply@example.org -e OPERATOR_CONTACT=ops@example.org \
  your-move-server
curl http://127.0.0.1:8080/api/health
```

The server also runs the scheduled sweep itself, every 15 minutes (03 §8). It expires lobbies
nobody started within 14 days (clearing the addresses typed into them), gives an emailed invitation
to anyone who finished signing up with that address while the game was being created, and sends
the "It's your turn" email nudges: off by default, each person turns them on in Settings, and every
nudge carries a one-click unsubscribe link (05 §Email links). It sends at most 100 per run, 150 a
day across the instance (`LIMIT_NUDGE_EMAILS_PER_DAY`, so nudges can't use up the sender's daily
quota that sign-in codes need) and 10 a day to any one person
(`LIMIT_NUDGE_EMAILS_PER_USER_PER_DAY`); at the instance cap it stops with one
`NUDGE_EMAILS_PER_DAY` alert in the log per day and the rest wait.

Inviting an address with no account sends it an invitation email from the configured provider,
with a one-click unsubscribe. Those emails are capped too (06 §6.6, 08 §4): per inviter 5 a day
and 20 in 30 days (2 a day for an account under a week old with no finished game against anyone),
where every typed address counts, existing players' included; 3 in 30 days to any one address; and
100 a day across the instance (`LIMIT_INVITE_EMAILS_*`). Over a cap the seat is still created and
nothing is sent, and the instance cap logs one `INVITE_EMAILS_GLOBAL_DAY` alert a day while it is
reached.

A lobby's creator can also make a join link, `PUBLIC_URL/join#<token>`, to share in a group chat
(06 §6.8). The token is in the URL's fragment, which browsers never send, so it reaches no proxy,
tunnel or server log; the server stores only its SHA-256, and the sweep deletes links once they
expire (7 days at most). Nothing needs configuring. Lookups and joins are limited to 30 an hour per
person and 60 an hour per client address (`LIMIT_JOIN_LINK_USER_HOUR`, `LIMIT_JOIN_LINK_IP_HOUR`),
and a creator makes at most 20 links a day (`LIMIT_JOIN_LINKS_CREATED_USER_DAY`). The per-address
limit needs the real client address, as sign-in does (`TRUST_PROXY`, 08 §4.1).

The Cloudflare Tunnel compose file is below; the Caddy one arrives in M4 (09 §4).

## Email through Gmail

The proof of concept sends sign-in codes with the `gmail` provider (09 §2, Q2): a dedicated user
in your Google Workspace domain, an OAuth client that is **Internal** to the domain, and a refresh
token that can do one thing, send mail as that user. There is no domain-wide delegation and no app
password. You do the steps below once. `<your Workspace domain>` stands for your domain; use your
own wherever you see `example.org`.

1. **The sender user.** In the Google Admin console create a user such as
   `no-reply@example.org`, used for nothing else and never signed in to after step 3. Turn on
   2-Step Verification for it, turn off IMAP and POP for it, and set up a regular purge of its
   _Sent_ folder (Gmail keeps a copy of every message it sends; purged messages stay in Trash for
   30 days, and a Vault hold keeps them longer, so the privacy page's retention statement,
   `PRIVACY_RETENTION`, must allow for both, 08 §5).
2. **DNS.** The sending domain must have SPF, DKIM and DMARC. For a Workspace domain they usually
   exist; check them before go-live (an Admin console "Authenticate email" page, or
   `dig TXT example.org`, `dig TXT google._domainkey.example.org`, `dig TXT _dmarc.example.org`).
   Without them sign-in codes land in spam.
3. **The OAuth client.** In a Google Cloud project owned by the Workspace organisation, enable the
   **Gmail API**. Under _Google Auth platform_ set the audience to **Internal**, and add the single
   scope `https://www.googleapis.com/auth/gmail.send` (plus the default `openid` and `email`). Create an
   OAuth client of type **Desktop app**: a Web client wants every redirect address registered in
   advance, and the helper in the next step listens on a random loopback port. Download its client
   id and client secret.
4. **Keep the secrets in files.** Choose a directory only you can enter, outside the repository
   (the same one the tunnel deployment uses, `SECRETS_DIR` below), and put the client id and
   secret in their own files. Create the directory as yourself, mode 0700 (with `sudo`, make it
   yours, never root's):

   ```sh
   umask 077
   sudo install -d -o "$USER" -m 0700 /srv/secrets   # or: install -d -m 0700 "$HOME/secrets"
   printf '%s' '<client id>' > /srv/secrets/gmail_client_id
   printf '%s' '<client secret>' > /srv/secrets/gmail_client_secret
   ```

5. **Get the refresh token** with the helper, on a machine that has this repository checked out
   (`mise install`, `pnpm install`) and a browser:

   ```sh
   GMAIL_SENDER=no-reply@example.org \
   GMAIL_CLIENT_ID_FILE=/srv/secrets/gmail_client_id \
   GMAIL_CLIENT_SECRET_FILE=/srv/secrets/gmail_client_secret \
   pnpm gmail:authorize --out /srv/secrets/gmail_refresh_token
   ```

   It prints an address. Open it in a browser and **sign in as the sender user** (not as an
   administrator: the helper refuses a token for any other account, and revokes it). Accept the
   request to send email. The browser is redirected to `http://127.0.0.1:<port>/callback`, which the
   helper is listening on, so run it on the machine where you open the browser. It then checks
   that the granted scopes are exactly `openid`, `email` and `gmail.send` and that the sign-in
   was the sender's own, and writes the refresh token to the `--out` file (mode 0600, which must not
   exist yet and must be outside the repository and any Git working tree). It never prints the token. If it fails,
   nothing is written and the token is revoked; if the revocation itself fails it says so, and you must
   remove the app's access in the sender account's security settings.

6. **Give the server the values** as the secrets `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
   and `GMAIL_REFRESH_TOKEN` (files, below), and set `GMAIL_SENDER` (the sender's address) and
   `EMAIL_FROM` (`"Example Games" <no-reply@example.org>`; the address must be the same one as
   `GMAIL_SENDER`, or the server refuses to start). On Cloudflare Workers they are Worker
   secrets (`wrangler secret put GMAIL_REFRESH_TOKEN`).

To **revoke** (a leaked file, a retired instance), remove the app's access in the sender user's
Google account (Security, _Third-party apps with account access_) or delete the OAuth client, then
repeat steps 5 and 6. A stolen refresh token can only send mail as the sender user: it can't read
any mailbox and it can't act as anyone else. A stolen client secret additionally lets someone start
consent flows for users in your domain, so keep it as secret as the token.

At startup the Node server refreshes the token once and refuses to start if its scope is anything
but `gmail.send` or it belongs to another account. It still starts when Google is unreachable or
has revoked the token (sign-in can't succeed then, but the rest of the app works), and says so in
the log. The logs name these alerts (each an `error`-level line with an `alert` field; none ever
holds an address, a code or a token):

| `alert`                      | Meaning and what to do                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `email_credentials_rejected` | Google refused the refresh token (revoked, or the OAuth client was deleted): redo steps 5 and 6                                |
| `email_token_failed`         | Google couldn't be reached or answered unexpectedly: check outbound access and Google's status                                 |
| `email_token_scope`          | The token's scopes aren't exactly `openid`, `email` and `gmail.send`: revoke it and redo step 5                                |
| `email_token_account`        | The token isn't `GMAIL_SENDER`'s verified account for this client (or has no `id_token`): revoke it, redo step 5 as the sender |
| `email_send_failed`          | One message wasn't sent (`status` is Gmail's HTTP status where there is one)                                                   |
| `email_provider_unavailable` | `EMAIL_PROVIDER` names a provider that isn't built: nothing is sent                                                            |

Gmail allows a paid Workspace user 2,000 messages in any 24 hours (500 on a trial). The instance's
email caps (sign-in codes 500 a day, invite emails 100, nudges 150) can each send up to twice their
figure in the 24 hours around midnight UTC, so together at most 1,500, and the server refuses to
start if `LIMIT_*` overrides could take that past `EMAIL_DAILY_QUOTA` (2,000 for `gmail`). On a
trial set `EMAIL_DAILY_QUOTA=500` and lower the caps to fit, e.g. `LIMIT_OTP_EMAIL_GLOBAL_DAY=150`,
`LIMIT_INVITE_EMAILS_GLOBAL_DAY=50` and `LIMIT_NUDGE_EMAILS_PER_DAY=50` (2 × 250 = 500); the tunnel
compose file passes these four through from its env file, empty meaning the defaults. Use the sender
user for this instance only. The `smtp` provider pointed at Google's SMTP relay with the same
Workspace user shares its quota but has no default one, so set `EMAIL_DAILY_QUOTA` there too. Move
to a transactional provider before the instance grows beyond friends and family.

## Web Push

"It's your turn" notifications on phones and browsers (Web Push, [03 §7](spec/03-architecture.md))
need a VAPID key pair, made once with

```sh
pnpm gen:vapid --out /srv/secrets
```

It writes `vapid_public_key` and `vapid_private_key` as new 0600 files in that directory, which
must be outside the repository and any Git working tree; it never overwrites a file and never
prints the private key. Give them to the server as `VAPID_PUBLIC_KEY_FILE` and
`VAPID_PRIVATE_KEY_FILE`, with `VAPID_SUBJECT` set to a `mailto:` address (or `https://` URL) push
services can use to reach you. Without all three the server sends no pushes and the app says
so in Settings. The Node server refuses to start if the private key isn't the public key's.

**Keep the pair.** A new one makes every device's subscription unusable until the app replaces it
on its next launch. Outbound pushes go only to the browsers' push services (Apple, Google,
Microsoft, Mozilla), over the `egress` network.

On iPhone and iPad, notifications work only for the app added to the Home Screen (iOS 16.4 or
later); the app's Settings explain this and link to the install guide.

## Behind a Cloudflare Tunnel

[`apps/node/docker-compose.tunnel.yml`](../apps/node/docker-compose.tunnel.yml) is the
proof-of-concept deployment (09 §4, Q6): the app and `cloudflared`, with nothing published on the
host and no inbound firewall rule. TLS ends at Cloudflare, which forwards `CF-Connecting-IP`, and
the app trusts it only from the tunnel's own address.

- `front` is an **internal** network (no route out) holding only the app and `cloudflared`; its
  subnet is pinned to `172.30.99.0/28`, `cloudflared` has the pinned address `172.30.99.2` and the
  app `172.30.99.3`. The Docker host has an address on `front` too (the bridge gateway,
  `172.30.99.1`), so the app's `TRUST_PROXY_PEERS` is exactly `172.30.99.2/32` (the
  container's own health check needs no client address, so loopback is not trusted), not the subnet. A request from any other address, or without a
  valid `CF-Connecting-IP`, is answered `400` on every route that needs the client's address, and
  `X-Forwarded-For` is never read. If you change an address, change `TRUST_PROXY_PEERS` and the
  tunnel's route to match.
- The app is reachable on `front` as **`app-front`**, an alias that exists only there. The
  tunnel's route must use it (`http://app-front:8080`): Docker also resolves the service name
  `app` to the app's `egress` address, so `cloudflared` would reach the app from an address
  outside `TRUST_PROXY_PEERS`, and every request would be answered `400` (the health check still
  passes, since it needs no client address).
- Each container's log is capped (`json-file`, 3 files of 10 MB) and each has a process and memory
  limit, so a fault can't fill the host's disk or take the host down.
- Keep `cloudflared` at its default log level: at `debug` it logs request URLs, and the unsubscribe
  link's `?t=` token (which never expires) would land in its log (09 §5). The same goes for any
  log in front of the server: it must not keep the query string of `/api/v1/email/unsubscribe`.
  The server itself logs the route pattern only.
- `egress` is an ordinary bridge for outbound calls: Gmail, and the tunnel to Cloudflare.
- Every secret is a Docker secret read through `<NAME>_FILE`; the tunnel token is read with
  `--token-file`. None appears in `docker inspect`.

**Prepare**

1. **The tunnel.** In the Cloudflare dashboard (_Zero Trust_, _Networks_, _Tunnels_) create a
   tunnel of type Cloudflared and copy its token (the long string after `--token` in the command
   the page shows; keep only the token). Add one **public hostname**, `<hostname>` on a domain in
   your account, with service type HTTP and URL `app-front:8080` (not `app:8080`, see above). Add nothing else: no other hostname
   and no catch-all rule, so the tunnel can reach only the app.
2. **Pseudo IPv4.** In the zone's _Network_ settings turn **Pseudo IPv4 off**, or set it to "Add
   header" (never "Overwrite", which puts made-up addresses in `CF-Connecting-IP` and ruins the
   per-address limits, 08 §4.1). Optionally put a Cloudflare Access policy in front of the whole
   hostname while you test.
3. **The secrets files** (`SECRETS_DIR`, outside the repository). Create the directory as
   yourself with mode 0700 (the directory's mode is what keeps other users out). Docker mounts each
   file with its host permissions, and the app runs as UID 1000 and `cloudflared` as 65532,
   neither of whom is you, so the files must be world-readable (0444): the `chmod` is the **last**
   step, after every file exists, including `gmail_refresh_token` from the Gmail section and the
   two VAPID key files from `pnpm gen:vapid`.

   ```sh
   umask 077
   sudo install -d -o "$USER" -m 0700 /srv/secrets   # or: install -d -m 0700 "$HOME/secrets"
   openssl rand -base64 32 > /srv/secrets/app_secret      # never rotate it (below)
   printf '%s' '<tunnel token>' > /srv/secrets/tunnel_token
   # gmail_client_id, gmail_client_secret and gmail_refresh_token: "Email through Gmail" above
   pnpm gen:vapid --out /srv/secrets    # vapid_public_key, vapid_private_key ("Web Push" below)
   chmod 0444 /srv/secrets/*    # last step before `up`; run it again after adding or replacing a file
   ```

4. **The settings.** Copy [`apps/node/tunnel.env.example`](../apps/node/tunnel.env.example) to a
   file outside the repository and fill it in: `PUBLIC_URL=https://<hostname>`, `SECRETS_DIR`,
   `OPERATOR_CONTACT`, `EMAIL_FROM`, `GMAIL_SENDER`, `VAPID_SUBJECT`, `PRIVACY_RETENTION` (the
   privacy page's statement of how long logs, backups and the _Sent_ folder's copies are kept;
   allow for the 30 days purged mail stays in Trash) and optionally `APP_NAME` and `ADMIN_EMAILS`.
5. **The image**, by digest: the `publish:image` job of the pipeline that built the commit you
   want prints it. Put it in the settings file as `APP_IMAGE=<registry>/<project>/server@sha256:<digest>`,
   and `docker login` to the registry first if it is private.

**Upgrading a deployment from before Web Push** (alpha A8): run `pnpm gen:vapid --out <your
SECRETS_DIR>`, run `chmod 0444` on the secret files again, add `VAPID_SUBJECT` to your settings
file, then `docker compose … up -d`; the compose file refuses to start without them.

**Run**

```sh
docker compose -f apps/node/docker-compose.tunnel.yml --env-file /path/to/tunnel.env up -d
docker compose -f apps/node/docker-compose.tunnel.yml --env-file /path/to/tunnel.env ps    # both healthy
docker compose -f apps/node/docker-compose.tunnel.yml --env-file /path/to/tunnel.env logs app
```

The log shows `listening` and, with the gmail provider, no `email_*` alert. Then open
`https://<hostname>/api/health` from another machine, and sign in. To update, change `APP_IMAGE`
to the new digest and run `up -d` again; the app applies new migrations at start (and refuses to
start on a database a newer image has migrated, so keep a backup before an update).

**Measuring usage.** To see how many requests a game costs (the input to the Workers cost model,
roadmap "Workers cost model"), feed the app's request log to the usage report. It reads only the
JSON request lines (route, method, status, time; no personal data) and prints requests per route
and estimates per move, per game and per player per day, with its assumptions, and a comparison
with the Workers Free plan's daily request limit. It fetches nothing and logs nothing:

```sh
docker compose -f apps/node/docker-compose.tunnel.yml --env-file /path/to/tunnel.env logs --no-log-prefix app \
  | pnpm ops:usage --players 2        # or: pnpm ops:usage app.log; add --json for machine output
```

`--players` is the number of active players, which the log cannot tell. Retention is whatever
Docker keeps, so a short log gives rough rates.

**Check it** (the acceptance checks for this deployment; the settings they rely on are also tests in CI,
`apps/node/src/tunnel-compose.test.ts`):

- `docker compose ... config` shows no `ports:` on either service, and `docker inspect <app>`
  shows no port bindings;
- the routing, scripted: with the stack up, run
  `COMPOSE="docker compose -f apps/node/docker-compose.tunnel.yml --env-file /path/to/tunnel.env" PUBLIC_URL=https://<hostname> apps/node/scripts/check-tunnel-routing.sh`.
  It sends a sign-in request from `cloudflared`'s own network namespace to `http://app-front:8080`
  (must not be `400`), the same request to `http://app:8080` (must be `400`) and one from the
  Docker host (must be `400`). On rootless Docker the host cannot reach container networks
  directly (they live in rootlesskit's network namespace), so the host request goes through
  `nsenter -U --preserve-credentials -n -t <pid>`, the pid read from
  `$XDG_RUNTIME_DIR/dockerd-rootless/child_pid`; if that namespace cannot be entered the check
  fails, it is never skipped. It makes one email attempt, to an address that doesn't exist;
- a request to the app from any other address (for example from a container attached only to
  `egress`) gets `400` on `POST /api/v1/auth/otp/request`, and `200` on `GET /api/health`;
- a request on `front` without `CF-Connecting-IP`, or with only `X-Forwarded-For`, gets `400`;
- the container health check passes without `CF-Connecting-IP`;
- `docker inspect <app>` shows no secret value, and `docker exec <app> ls -l /run/secrets` lists
  the four files;
- the sign-in code arrives by email on a phone, with the code in the subject.

If every sign-in request is answered `400` while `/api/health` is fine, check that the tunnel's
route points at `app-front:8080`. If a container fails to start with a permission error on
`/run/secrets/...`, the final `chmod 0444` of step 3 was skipped, or a file was added after it.

**Things to know.** The app's port is reachable from the Docker host itself (a bridge network's
gateway is the host), but the host's address on `front` is not in `TRUST_PROXY_PEERS`, so a request
from it gets `400`. Anyone with Docker access on the host controls the whole stack anyway, so treat
the host as trusted and don't give other users Docker access: access to Docker on the host is
enough to impersonate the tunnel. Don't add private-network (CIDR) or WARP routes to this
tunnel: they would let other machines send requests from the tunnel's address, which the app
trusts to name the client. Data lives in the named volumes `data` and
`blobs`; backup documentation arrives with M4. Rotating `APP_SECRET` is unsupported (above).

## Cloudflare Workers

Copy [`apps/worker/wrangler.example.toml`](../apps/worker/wrangler.example.toml) to
`apps/worker/wrangler.toml` (git-ignored) and set secrets with `wrangler secret put`. The build
(`pnpm build`) copies the web app into `apps/worker/dist/assets` together with a `_headers` file
generated from the same security-header definition the Node server uses; set `PUBLIC_URL` (and
`TURNSTILE_ENABLED=true` if you use Turnstile) when building so the static headers match.

The database is the D1 binding `DB`: set its `database_id` in your copy, and apply the shared
migrations (`packages/server/migrations`, the same files the Node server applies) before each
deploy with `wrangler d1 migrations apply DB --remote --config apps/worker/wrangler.toml`, then
check for orphaned games with `pnpm games:check-db --d1 <database>`. The example configuration's
Cron Trigger (`*/15 * * * *`) runs the sweep (03 §8); keep it in your copy, or no email nudges go
out. One invocation has a small budget of subrequests and D1 queries, so the Worker sends at most
4 nudges per run (09 §3, which has the arithmetic against the per-invocation D1 query limit); a run with a failed step or nudge shows as a failed invocation in the
trigger's history. Check that Workers Logs and Logpush don't keep the query string of
`/api/v1/email/unsubscribe` (09 §5).

There is no CI deploy job for Workers yet. It arrives with the first Workers deployment
(09 §6, 10), built to deploy the build artifact (`dist/worker`, `--no-bundle`) with a
lockfile-pinned wrangler and configuration generated from CI variables, without installing
anything or running game code while the deploy token is present.

## CI runners

The amd64 runner's CPU must offer **x86-64-v2 (SSE4.2)**: workerd's linux-64 build, which the
workerd tests run, fails at startup without it (an empty `jsg.Error` at isolate bootstrap). A VM
on the generic `qemu64` CPU model doesn't qualify; use the `host` CPU type (`host-passthrough`),
or at least an x86-64-v2 model. The shared runner's VM now does (2026-11-28), so the workerd tests
(the Worker contract suite, the D1 repository contract suite and the gmail redirect test) run in
the ordinary `test` job; the separate arm64 `test:worker` job they needed while it didn't is gone.
Caches are kept per architecture (`CACHE_ARCH`); `test:timing` writes the arm64 ones.

`test:timing` (the statistical sign-in timing suite, ADR 0006) measures on the arm64 runner, after
this pipeline's other arm64 job (the arm64 image build). Jobs of other pipelines can still share that runner while it
measures unless the runner's concurrency is 1; that is the operator's runner setting (`concurrent`
in its `config.toml`), and the repository doesn't record it. A shifted measurement on a busy runner
is a reason to re-measure, not to retry (ADR 0006).

The game kit's CPU budget (08 T25) is measured on the host running the kit, and the shared amd64
runner (a VM 2–3× slower than a developer laptop, often running several pipelines at
once) can't hold the 5 ms reference budget reliably. CI therefore sets one calibrated budget,
`KIT_CPU_BUDGET_MS` (20 ms, 4× the reference; a whole number from 1 to 50), in `.gitlab-ci.yml`'s
global variables, and every kit run in CI uses it: the testkit's `runKit` reads it whenever it
isn't given a budget, so the game packages' own kit tests in `pnpm test`, `games:verify` in
`pnpm build` (`build:app`) and the full kit in `test` all do, and the image build receives it as a
`--build-arg`. In CI, installed third-party games are checked at the calibrated budget too.
Developer machines keep the real 5 ms budget, enforced by every local `pnpm test` and
`pnpm games:verify` (and local Docker builds), so a slow engine still fails there. Measured on a
developer laptop (2026-11-24), the words engine's worst cases take 0.02 ms median and under 0.1 ms
at the 99th percentile; budget failures on the runner are pauses (garbage collection, a busy
host), not engine cost. Since 2026-11-28 every Node kit run times in the thread's CPU time and
takes the median of five runs per sample (02 §6.6), so a busy host no longer counts against a
game; half of the calibration's reason is gone. (That clock's resolution is the kernel's:
microseconds where it accounts CPU time precisely, otherwise one scheduler tick of 1–4 ms, coarse
against a 5 ms budget but not biased; on a 20 ms budget it hardly matters.) The other half stands: CPU time on the runner
is still 2–3× a laptop's (re-measured after its CPU model changed to `host-passthrough`, pipelines
82752 and 82775, 2026-11-28: the speed is unchanged), so the 5 ms reference doesn't fit it, and inside a VM a vCPU the
hypervisor takes away may still be charged to the running thread. The value stays 20 ms;
revisit it when the runner changes.

The `test` job has an explicit `timeout` of 55 minutes (ADR 0004): on the shared amd64 runner it
took 1414 s with the workerd tests and 2048 s once the paths game's full kit joined `games:verify`
(2026-11-29). If it creeps past about 45 minutes, split the job rather than raise the timeout again.
The job's first step fails at once with a clear message if the runner's CPU lacks SSE4.2.

The `test` job keeps its scratch files (temporary SQLite databases,
bundles) on tmpfs: `TMPDIR` points into `/dev/shm`. On the shared amd64 runner the disk is shared
with other jobs' image builds, and an fsync there can stall for hundreds of ms: tests that open a
real database file (each committing a dozen or more times while migrating) took 4–19 s instead of
milliseconds and hit Vitest's 5 s timeout. The test command's scratch files peak at about 7 MB
(measured 2026-11-25); the jobs refuse to start when `/dev/shm` has under 32 MB free (Docker's
default is 64 MB), so raise the runner's `shm_size` if they ever need more. Durability on a real
disk isn't what these tests check; the file modes, locks and migrations behave the same on tmpfs.

## CI settings and secrets

Our GitLab is Community Edition (no protected environments), so each secret is a variable that is
**masked, protected** (only `main` and protected `v*` tags receive it) **and scoped to one
environment**:

| Variable                                          | Environment  | Used by                                                                                                    |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `RENOVATE_TOKEN`                                  | `renovate`   | the scheduled Renovate job (schedule variable `SCHEDULE_TASK=renovate`)                                    |
| `GITHUB_COM_TOKEN`                                | `renovate`   | Renovate's lookups of GitHub releases (mise tools, mise itself): a read-only token for public repositories |
| `RELEASE_DEPLOY_USER`, `RELEASE_DEPLOY_TOKEN`     | `release`    | `publish:packages`: a deploy token; it needs only `write_package_registry`                                 |
| `RELEASE_REGISTRY_USER`, `RELEASE_REGISTRY_TOKEN` | `release`    | `publish:image`: a Maintainer-role project access token for the container registry only (below)            |
| `CLOUDFLARE_API_TOKEN`, `D1_DATABASE`             | `production` | the Workers deploy job, once it exists                                                                     |

**The release registry token** (`RELEASE_REGISTRY_TOKEN`, with the token's bot user name in
`RELEASE_REGISTRY_USER`) is a project access token with the **Maintainer** role and only the
`read_registry` and `write_registry` scopes (no `api`). It exists because the protected container
repository rule (`applications/your-move*`, push = Maintainer, delete = Owner) refuses deploy
tokens, which have no role. It can push or overwrite any image in this project's container registry
(including `v*` tags) and nothing else; deletion is reserved to Owner by the protection rule. It
can't call the API, push code or publish packages (findings.md F-9). Our CE version's npm package
protection rule takes no delete level. Both publish jobs share the `release` environment, so
`publish:packages` also receives this token until M1 gives them separate scopes (findings.md F-8).
To rotate it before the expiry date shown in the project's access-token settings, create a new token
with the same name, role and scopes, update both variables, then revoke the old one. The release
deploy token holds only `read_package_registry` and `write_package_registry`; rotate it the same
way.

`publish:packages` adds only the `@your-move` registry to the repository's `.npmrc`. pnpm ignores
credentials in a repository-controlled `.npmrc` that name an environment variable, so the job
writes the deploy token to a user-level npm config in the job container's `/tmp` (outside the
checkout, so no artifact or cache can include it) with the `printf` builtin and mode 0600, points
pnpm at it with `NPM_CONFIG_USERCONFIG`, and deletes it in `after_script`. A test
(`scripts/src/ci/npm-credentials.test.ts`) fails if any job writes a credential into the
repository's `.npmrc`.

**`publish:packages` is manual for now** (issue #12). GitLab's protected npm packages refuse the
deploy token (`Package protected`): deploy tokens have no role, and project access tokens can't be
scoped to the package registry. Nothing is published until the release-path decision in M1.

The nightly OSV scan is a schedule with `SCHEDULE_TASK=nightly`. Every merge request pipeline runs
one job per environment that declares that environment, prints whether each of these variables is
set, and fails if any is. Its list of variables and environments is kept equal to this table by a
test (`scripts/src/ci/no-secrets-on-mr.test.ts`), so add a new secret to both.

So that check can't pass just because a job never received its environment's variables, each
environment also has an **`ENV_SCOPE_CANARY`** variable: **not** protected, not secret, scoped to
that environment, with the environment's name as its value (`release`, `renovate`,
`production`). Each job first requires `ENV_SCOPE_CANARY` to equal its environment's name, and
fails otherwise. Keep all three; add one for any new environment.

The project setting **"Use separate caches for protected branches" must stay on**: it keeps caches
written by merge-request pipelines out of the pipelines that hold the release credentials.
