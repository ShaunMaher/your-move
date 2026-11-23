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
# The fast game kit and import rules run in every image build (02 §7.3).
RUN pnpm games:generate \
 && pnpm games:verify --fast \
 && pnpm --filter @your-move/web build \
 && pnpm --filter @your-move/node build \
 && pnpm games:check-inputs --only web,node
# Production dependencies only (08 §6). The server bundle is self-contained today; this keeps the
# image right once native modules (the SQLite driver, M2) are external.
RUN pnpm --filter @your-move/node deploy --prod /deploy \
 && rm -rf /deploy/src /deploy/scripts /deploy/tsconfig.json /deploy/Dockerfile \
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
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disallow-code-generation-from-strings", "dist/main.js"]
