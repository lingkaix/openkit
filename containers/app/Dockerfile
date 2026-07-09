FROM node:24-bookworm-slim AS builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"

WORKDIR /build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    g++ \
    libsqlite3-dev \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @openkit/protocol build \
  && pnpm --filter @openkit/app-api-schemas build \
  && pnpm --filter @openkit/core-client build \
  && pnpm --filter @openkit/config-schema build \
  && pnpm --filter @openkit/nanocore build \
  && pnpm --filter @openkit/web build

# The workspace does not enable injected workspace packages, so pnpm v10 needs legacy deploy for a production nanocore tree.
RUN pnpm --filter @openkit/nanocore deploy --prod --legacy /deploy/nanocore

FROM node:24-bookworm-slim AS runtime

LABEL org.openkit.image="app"
LABEL org.openkit.smoke="/usr/local/bin/openkit-app-smoke"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV CADDY_HTTP_PORT="8080"
ENV OPENKIT_CORE_MODE="local"
ENV OPENKIT_BIND_HOST="127.0.0.1"
ENV OPENKIT_DATA_ROOT="/data/openkit"

WORKDIR /app/nanocore

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    caddy \
    ca-certificates \
    curl \
    libsqlite3-0 \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

COPY --from=builder /deploy/nanocore/ /app/nanocore/
COPY --from=builder /build/apps/web/dist/ /srv/web/
COPY Caddyfile /etc/caddy/Caddyfile
COPY containers/app/entrypoint.sh /usr/local/bin/openkit-app-entrypoint
COPY containers/app/smoke.sh /usr/local/bin/openkit-app-smoke

RUN chmod +x /usr/local/bin/openkit-app-entrypoint /usr/local/bin/openkit-app-smoke \
  && mkdir -p /data/openkit /srv/web

EXPOSE 8080

ENTRYPOINT ["tini", "-g", "--", "/usr/local/bin/openkit-app-entrypoint"]
