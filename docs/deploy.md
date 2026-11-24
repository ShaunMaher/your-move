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

The database is one SQLite file, `DATABASE_PATH` (default `/data/app.sqlite`), in WAL mode. At
every start the server first applies any new migrations (all in one transaction), then refuses to
start if a `lobby` or `active` game needs a game type or rules version this image doesn't install
(02 §7.3); finish or cancel those games first, or start **once** with `ALLOW_ORPHAN_GAMES=true` to
accept that the sweep cancels them. It also refuses a database that a newer image has migrated:
roll forward, or restore a backup. Run one container per database file.

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

The database is the D1 binding `DB`: set its `database_id` in your copy, and apply the shared
migrations (`packages/server/migrations`, the same files the Node server applies) before each
deploy with `wrangler d1 migrations apply DB --remote --config apps/worker/wrangler.toml`, then
check for orphaned games with `pnpm games:check-db --d1 <database>`.

There is no CI deploy job for Workers yet. It arrives with the first Workers deployment
(09 §6, 10), built to deploy the build artifact (`dist/worker`, `--no-bundle`) with a
lockfile-pinned wrangler and configuration generated from CI variables, without installing
anything or running game code while the deploy token is present.

## CI runners

The amd64 runner's CPU must offer **x86-64-v2 (SSE4.2)**: workerd's linux-64 build, which the
Worker contract tests run, fails at startup without it (an empty `jsg.Error` at isolate
bootstrap). A VM on the generic `qemu64` CPU model doesn't qualify; use the `host` CPU type, or at
least an x86-64-v2 model. Until the shared amd64 runner offers it, the Worker contract tests run
in the `test:worker` job on the arm64 runner (`arch-arm64`); when it does, delete that job and the
`--exclude` in `test`. Caches are kept per architecture (`CACHE_ARCH`).

The game kit's CPU budget (08 T25) is measured on the host running the kit, and the shared amd64
runner (a `qemu64` VM, 2–3× slower than a developer laptop, often running several pipelines at
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
host), not engine cost. Revisit the value when the runner changes.

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
