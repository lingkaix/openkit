FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder

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

RUN pnpm --filter @openkit/nanocore... --filter @openkit/web... build

# The workspace does not enable injected workspace packages, so pnpm v10 needs legacy deploy for a production nanocore tree.
RUN pnpm --filter @openkit/nanocore deploy --prod --legacy /deploy/nanocore

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

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
    git \
    libsqlite3-0 \
    tini \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

COPY --from=builder /deploy/nanocore/ /app/nanocore/
COPY --from=builder /build/apps/web/dist/ /srv/web/
COPY Caddyfile /etc/caddy/Caddyfile
COPY containers/app/entrypoint.sh /usr/local/bin/openkit-app-entrypoint
COPY containers/app/smoke.sh /usr/local/bin/openkit-app-smoke

RUN chmod +x /app/nanocore/dist/openkit-operator.js \
    /usr/local/bin/openkit-app-entrypoint \
    /usr/local/bin/openkit-app-smoke \
  && ln -s /app/nanocore/dist/openkit-operator.js /usr/local/bin/openkit-operator \
  && mkdir -p /data/openkit /srv/web

EXPOSE 8080

ENTRYPOINT ["tini", "--", "/usr/local/bin/openkit-app-entrypoint"]
