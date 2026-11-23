# Deploying

This page grows with the milestones; today it covers what M0 delivers. The specification is
[`docs/spec/09-operations.md`](spec/09-operations.md).

## Configuration

Every variable is listed, with its rules, in [`.env.example`](../.env.example) and
[09 §1](spec/09-operations.md). The server refuses to start on invalid configuration, naming each
variable and rule but never a secret's value. On Docker, give secrets as files:
`NAME_FILE=/run/secrets/name` (Docker secrets) wins over `NAME`, so secrets don't show up in
`docker inspect`.

Generate `APP_SECRET` with `openssl rand -base64 32`. **Rotating `APP_SECRET` is unsupported**
until the re-keying job described in 09 §1.1 exists: changing it silently empties the email
suppression list.

## Docker

Images are built by CI for `linux/amd64` and `linux/arm64` and pushed to this project's container
registry from `main` and `v*` tags only. **Deploy by digest**, never by tag:

```yaml
image: registry.example.org/group/your-move/server@sha256:<digest from the release notes>
```

Tags (`<commit>`, `v*`) are for humans; images aren't signed yet (08 §6), so the digest recorded
in the release notes is what ties a deployment to the pipeline that built it.

The container runs as an unprivileged user, serves on port 8080, keeps its data in `/data`, and
works with a read-only root filesystem (`read_only: true` in compose, or `docker run --read-only`).
It starts with `node --disallow-code-generation-from-strings`. Its health check calls
`/api/health`.

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

The compose files for the Cloudflare Tunnel and Caddy deployments arrive in M4 (09 §4).

## Cloudflare Workers

Copy [`apps/worker/wrangler.example.toml`](../apps/worker/wrangler.example.toml) to
`apps/worker/wrangler.toml` (git-ignored) and set secrets with `wrangler secret put`. The build
(`pnpm build`) copies the web app into `apps/worker/dist/assets` together with a `_headers` file
generated from the same security-header definition the Node server uses; set `PUBLIC_URL` (and
`TURNSTILE_ENABLED=true` if you use Turnstile) when building so the static headers match.

The CI deploy job (manual, `production` environment) runs `pnpm games:check-db` against D1 from
the build artifact, then applies migrations and deploys, without installing dependencies or
running game code. It is completed when D1 arrives (M2–M3).

## CI secrets

Our GitLab is Community Edition (no protected environments), so each secret is a variable that is
both **protected** (only `main` and protected `v*` tags receive it) and **scoped to one
environment**:

| Variable                                      | Environment  | Used by                                                                                            |
| --------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `RENOVATE_TOKEN`                              | `renovate`   | the scheduled Renovate job (schedule variable `SCHEDULE_TASK=renovate`)                            |
| `RELEASE_DEPLOY_USER`, `RELEASE_DEPLOY_TOKEN` | `release`    | publishing packages and images (a deploy token with `write_package_registry` and `write_registry`) |
| `CLOUDFLARE_API_TOKEN`, `D1_DATABASE`         | `production` | the manual Cloudflare deploy                                                                       |

The nightly OSV scan is a schedule with `SCHEDULE_TASK=nightly`. Every merge request pipeline runs
a job that prints whether each of these is set and fails if any is.
