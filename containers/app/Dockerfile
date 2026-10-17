FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS retrieval-builder

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV RUST_VERSION=1.97.1
ENV CARGO_HOME="/usr/local/cargo"
ENV CARGO_BUILD_JOBS="1"
ENV RUSTUP_HOME="/usr/local/rustup"
ENV PATH="${CARGO_HOME}/bin:${PATH}"
# Keep generated dictionaries with Cargo artifacts so incremental cache hits retain their include_bytes! inputs.
ENV LINDERA_BUILD_DICTIONARY_CACHE_DIR="/build/target/lindera"
ARG TARGETARCH
WORKDIR /build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl g++ python3 pkg-config \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain "${RUST_VERSION}" --profile minimal \
  && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY apps/retrieval-kernel/ apps/retrieval-kernel/
COPY scripts/retrieval-dictionary.py scripts/retrieval-notices.py scripts/
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=openkit-retrieval-registry-${TARGETARCH} \
    --mount=type=cache,target=/build/target,id=openkit-retrieval-target-${TARGETARCH} \
    python3 scripts/retrieval-dictionary.py --cache "${LINDERA_BUILD_DICTIONARY_CACHE_DIR}" --notice /out/licenses/IPADIC-COPYING \
  && cargo fetch --locked \
  && cargo build --locked --offline --release -p retrieval-kernel \
  && strip target/release/retrieval-kernel \
  && cp target/release/retrieval-kernel /out/retrieval-kernel \
  && python3 scripts/retrieval-notices.py --output /out/licenses/crates

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
# Pin Zod exactly across the workspace because legacy deploy re-resolves schema-package ranges independently of NanoCore's locked converter; remove the pin once App deploy uses the shared lockfile.
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
    openssh-client \
    tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.33.3 --activate \
  && pnpm --version

COPY --from=retrieval-builder /out/retrieval-kernel /usr/local/bin/retrieval-kernel
COPY --from=retrieval-builder /out/licenses/ /usr/local/share/licenses/retrieval-kernel/
COPY --from=builder /deploy/nanocore/ /app/nanocore/
COPY --from=builder /build/apps/web/dist/ /srv/web/
COPY Caddyfile /etc/caddy/Caddyfile
COPY containers/app/entrypoint.sh /usr/local/bin/openkit-app-entrypoint
COPY containers/app/smoke.sh /usr/local/bin/openkit-app-smoke

RUN chmod +x /app/nanocore/dist/openkit-operator.js \
    /app/nanocore/dist/openkit-restore.js \
    /usr/local/bin/openkit-app-entrypoint \
    /usr/local/bin/openkit-app-smoke \
  && ln -s /app/nanocore/dist/openkit-operator.js /usr/local/bin/openkit-operator \
  && ln -s /app/nanocore/dist/openkit-restore.js /usr/local/bin/openkit-restore \
  && mkdir -p /data/openkit /srv/web

# Release identity is a file, not an image ENV. The App-update helper replays every old container Config.Env entry as --env, so an ENV identity from the previous image would override the new image after every update. See https://github.com/lingkaix/openkit/issues/239.
ARG OPENKIT_RELEASE_TAG
ARG OPENKIT_SOURCE_COMMIT
RUN node -e 'const fs=require("node:fs"); const releaseTag=process.env.OPENKIT_RELEASE_TAG||null; const sourceCommit=process.env.OPENKIT_SOURCE_COMMIT||null; if(releaseTag===null&&sourceCommit===null) process.exit(0); fs.mkdirSync("/usr/local/lib/openkit",{recursive:true}); fs.writeFileSync("/usr/local/lib/openkit/release-identity.json", JSON.stringify({releaseTag,sourceCommit})+"\n");'

EXPOSE 8080

ENTRYPOINT ["tini", "--", "/usr/local/bin/openkit-app-entrypoint"]
