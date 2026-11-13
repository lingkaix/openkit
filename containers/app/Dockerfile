FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS retrieval-builder

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
  && case "${TARGETARCH}" in \
       amd64) rustup_target=x86_64-unknown-linux-gnu; rustup_sha256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 ;; \
       arm64) rustup_target=aarch64-unknown-linux-gnu; rustup_sha256=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282 ;; \
       *) exit 1 ;; \
     esac \
  && curl --proto '=https' --tlsv1.2 -fsSL "https://static.rust-lang.org/rustup/archive/1.29.3/${rustup_target}/rustup-init" -o /tmp/rustup-init \
  && echo "${rustup_sha256}  /tmp/rustup-init" | sha256sum -c - \
  && chmod 0755 /tmp/rustup-init \
  && /tmp/rustup-init -y --no-modify-path --default-toolchain "${RUST_VERSION}" --profile minimal \
  && rm /tmp/rustup-init \
  && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY packages/retrieval-kernel/ packages/retrieval-kernel/
COPY scripts/retrieval-dictionary.py scripts/retrieval-notices.py scripts/
RUN --mount=type=cache,target=/usr/local/cargo/registry,id=openkit-retrieval-registry-${TARGETARCH} \
    --mount=type=cache,target=/build/target,id=openkit-retrieval-target-${TARGETARCH} \
    python3 scripts/retrieval-dictionary.py --cache "${LINDERA_BUILD_DICTIONARY_CACHE_DIR}" --notice /out/licenses/IPADIC-COPYING \
  && cargo fetch --locked \
  && cargo build --locked --offline --release -p retrieval-kernel \
  && strip target/release/retrieval-kernel \
  && cp target/release/retrieval-kernel /out/retrieval-kernel \
  && python3 scripts/retrieval-notices.py --output /out/licenses/crates

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS builder

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

RUN node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz"); if(!r.ok) throw Error("Corepack download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha512").update(b).digest("hex")!=="4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff") throw Error("Corepack checksum mismatch"); fs.writeFileSync("/tmp/corepack.tgz",b);' \
  && npm install -g --offline --ignore-scripts --no-audit --no-fund /tmp/corepack.tgz \
  && rm /tmp/corepack.tgz \
  && corepack enable \
  && corepack prepare pnpm@10.33.3+sha512.a19744364a7e248b92657a4ca5973f9354d21caf982579674b1c539f32c7420c47138ad8b1254df07aba9bc782d9b3029e3db34d5dbff974326eb74dac8ff489 --activate \
  && pnpm --version

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @openkit/nanocore... --filter @openkit/web... build

# The workspace does not enable injected workspace packages, so pnpm v10 needs legacy deploy for a production nanocore tree.
# Pin Zod exactly across the workspace because legacy deploy re-resolves schema-package ranges independently of NanoCore's locked converter; remove the pin once App deploy uses the shared lockfile.
RUN pnpm --filter @openkit/nanocore deploy --prod --legacy /deploy/nanocore

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime

ARG TARGETARCH

LABEL org.openkit.image="app"
LABEL org.openkit.smoke="/usr/local/bin/openkit-app-smoke"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV UV_THREADPOOL_SIZE="16"
ENV PNPM_HOME="/pnpm"
ENV PATH="${PNPM_HOME}:${PATH}"
ENV CADDY_HTTP_PORT="8080"
ENV OPENKIT_CORE_MODE="server"
ENV OPENKIT_BIND_HOST="127.0.0.1"
ENV OPENKIT_DATA_ROOT="/data/openkit"

WORKDIR /app/nanocore

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    libsqlite3-0 \
    openssh-client \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Keep Caddy independent of the older Bookworm package; verify each target's release archive.
RUN case "${TARGETARCH}" in \
      amd64) caddy_sha256=5b8cb7faf8726a2028ad96a66e54e6e81e8f361bc6175e5d22bbd997cc5177fb ;; \
      arm64) caddy_sha256=5e377cff994fc9362a6fcf695c53f226cfca3a3ef85bd3a3687cf252d6310165 ;; \
      *) echo "Unsupported Caddy architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_${TARGETARCH}.tar.gz" \
    -o /tmp/caddy.tar.gz \
  && echo "${caddy_sha256}  /tmp/caddy.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/caddy.tar.gz -C /usr/bin caddy \
  && mkdir -p /usr/share/licenses/caddy \
  && tar -xzf /tmp/caddy.tar.gz -C /usr/share/licenses/caddy LICENSE \
  && rm /tmp/caddy.tar.gz

RUN node --input-type=module -e 'import fs from "node:fs"; import {createHash} from "node:crypto"; const r=await fetch("https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz"); if(!r.ok) throw Error("Corepack download failed"); const b=Buffer.from(await r.arrayBuffer()); if(createHash("sha512").update(b).digest("hex")!=="4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff") throw Error("Corepack checksum mismatch"); fs.writeFileSync("/tmp/corepack.tgz",b);' \
  && npm install -g --offline --ignore-scripts --no-audit --no-fund /tmp/corepack.tgz \
  && rm /tmp/corepack.tgz \
  && corepack enable \
  && corepack prepare pnpm@10.33.3+sha512.a19744364a7e248b92657a4ca5973f9354d21caf982579674b1c539f32c7420c47138ad8b1254df07aba9bc782d9b3029e3db34d5dbff974326eb74dac8ff489 --activate \
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
