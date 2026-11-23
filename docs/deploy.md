# Deploying

This page grows with the milestones; today it covers what M0 delivers. The specification is
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

There is no CI deploy job for Workers yet. It arrives with the first Workers deployment
(09 §6, 10), built to deploy the build artifact (`dist/worker`, `--no-bundle`) with a
lockfile-pinned wrangler and configuration generated from CI variables, without installing
anything or running game code while the deploy token is present.

## CI settings and secrets

Our GitLab is Community Edition (no protected environments), so each secret is a variable that is
**masked, protected** (only `main` and protected `v*` tags receive it) **and scoped to one
environment**:

| Variable                                      | Environment  | Used by                                                                                                    |
| --------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `RENOVATE_TOKEN`                              | `renovate`   | the scheduled Renovate job (schedule variable `SCHEDULE_TASK=renovate`)                                    |
| `GITHUB_COM_TOKEN`                            | `renovate`   | Renovate's lookups of GitHub releases (mise tools, mise itself): a read-only token for public repositories |
| `RELEASE_DEPLOY_USER`, `RELEASE_DEPLOY_TOKEN` | `release`    | publishing packages and images (a deploy token with `write_package_registry` and `write_registry`)         |
| `CLOUDFLARE_API_TOKEN`, `D1_DATABASE`         | `production` | the Workers deploy job, once it exists                                                                     |

The nightly OSV scan is a schedule with `SCHEDULE_TASK=nightly`. Every merge request pipeline runs
one job per environment that declares that environment, prints whether each of these variables is
set, and fails if any is.

The project setting **"Use separate caches for protected branches" must stay on**: it keeps caches
written by merge-request pipelines out of the pipelines that hold the release credentials.
