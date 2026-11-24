# syntax=docker/dockerfile:1
# The Node server image (docs/spec/09-operations.md §4). Build from the repository root:
#   docker build -f apps/node/Dockerfile -t <name> .
# Nothing product-specific is baked in: the name comes from APP_NAME at runtime, and the image
# title from the IMAGE_TITLE build argument.

# Node 26 LTS, slim, pinned by digest (Renovate updates both). Same version as mise.toml.
# renovate: datasource=docker depName=node
ARG NODE_IMAGE=node:26.13.1-trixie-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

FROM ${NODE_IMAGE} AS build
WORKDIR /src
# Node 26 ships without corepack. pnpm comes from mise at the version and SHA-256 in mise.lock,
# installed by a mise release whose SHA-256 is committed in scripts/ci/install-mise.sh.
ENV MISE_DATA_DIR=/opt/mise
ENV PATH=/opt/mise/bin:/opt/mise/shims:$PATH
COPY mise.toml mise.lock ./
COPY scripts/ci/ scripts/ci/
RUN scripts/ci/install-mise.sh pnpm
COPY . .
RUN pnpm install --frozen-lockfile
# The fast game kit and import rules run in every image build (02 §7.3). CI passes its calibrated
# CPU budget for the kit as a build argument (08 T25); unset, the kit's own 5 ms applies.
ARG KIT_CPU_BUDGET_MS=""
RUN pnpm games:generate \
 && pnpm games:verify --fast \
 && pnpm --filter @your-move/web build \
 && pnpm --filter @your-move/node build \
 && pnpm games:check-inputs --only web,node
# Production dependencies only (08 §6), so the image's SBOM lists them. The server bundle is
# self-contained (SQLite is Node's built-in node:sqlite, no native module), so nothing loads from
# node_modules at runtime: its type declarations and source maps are dropped to keep the image
# small.
RUN pnpm --filter @your-move/node deploy --prod /deploy \
 && rm -rf /deploy/src /deploy/scripts /deploy/tsconfig.json /deploy/Dockerfile \
 && find /deploy/node_modules -type f \
      \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -name '*.map' \) -delete \
 && cp -r apps/node/dist /deploy/dist

FROM ${NODE_IMAGE} AS runtime
ARG IMAGE_TITLE=app
ARG IMAGE_VERSION=dev
ARG IMAGE_REVISION=unknown
ARG IMAGE_SOURCE=""
ARG IMAGE_PIPELINE_ID=""
ARG IMAGE_PIPELINE_URL=""
# Provenance: the commit and the pipeline that built the image (08 §6).
LABEL org.opencontainers.image.title="${IMAGE_TITLE}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.licenses="BSD-2-Clause" \
      com.gitlab.ci.pipeline.id="${IMAGE_PIPELINE_ID}" \
      com.gitlab.ci.pipeline.url="${IMAGE_PIPELINE_URL}"
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /deploy/ /app/
# Run as the image's unprivileged user. Everything but /data can be mounted read-only
# (`docker run --read-only`, or `read_only: true` in compose).
# /data is the server user's alone (M2a review S-3); the database files inside are 0600.
RUN mkdir -p /data/blobs && chown -R node:node /data && chmod 0700 /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disallow-code-generation-from-strings", "dist/main.js"]
