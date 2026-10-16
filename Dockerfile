# ==============================================================================
# Reeva Multi-Stage Production Dockerfile
# Supported Target Platform: linux/amd64 (x86-64) ONLY
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Fetch, verify, and unpack pinned external runtime binaries (linux/amd64)
# ------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS binary-fetcher

# Fail-closed architecture guard: external yt-dlp and FFmpeg artifacts are Linux x86-64 builds.
# Executes before installing packages or downloading/executing architecture-specific binaries.
ARG TARGETARCH
RUN if [ "${TARGETARCH}" != "amd64" ] || [ "$(uname -m)" != "x86_64" ]; then \
        echo "ERROR: Unsupported target architecture (TARGETARCH='${TARGETARCH}', uname='$(uname -m)'). Reeva container builds only support linux/amd64." >&2; \
        exit 1; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# 1. Fetch and verify standalone Linux x64 yt-dlp binary
# Authoritative source: https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux"
ARG YTDLP_SHA256="58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a"

RUN curl -fsSL -o /tmp/yt-dlp "${YTDLP_URL}" \
    && echo "${YTDLP_SHA256}  /tmp/yt-dlp" | sha256sum -c - \
    && chmod 0755 /tmp/yt-dlp \
    && /tmp/yt-dlp --version

# 2. Fetch and verify static Linux x64 FFmpeg 7.1 build
# Authoritative source: https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/checksums.sha256
ARG FFMPEG_RELEASE="autobuild-2026-07-31-14-10"
ARG FFMPEG_ARCHIVE="ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz"
ARG FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_ARCHIVE}"
ARG FFMPEG_SHA256="c1e6caf48923dd8e6bc5e54d51ba70c321175b8162ae9c414c392990e72f0e79"

RUN curl -fsSL -o /tmp/ffmpeg.tar.xz "${FFMPEG_URL}" \
    && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
    && mv /tmp/ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1/bin/ffmpeg /tmp/ffmpeg \
    && mv /tmp/ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1/bin/ffprobe /tmp/ffprobe \
    && chmod 0755 /tmp/ffmpeg /tmp/ffprobe \
    && /tmp/ffmpeg -version

# ------------------------------------------------------------------------------
# Stage 2: Minimal Production Runtime Image (Node.js 24 LTS, linux/amd64)
# ------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ARG TARGETARCH
RUN if [ "${TARGETARCH}" != "amd64" ] || [ "$(uname -m)" != "x86_64" ]; then \
        echo "ERROR: Unsupported target architecture (TARGETARCH='${TARGETARCH}', uname='$(uname -m)'). Reeva container builds only support linux/amd64." >&2; \
        exit 1; \
    fi

# Install only CA certificates for outbound TLS verification
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy verified external binaries from fetcher stage
COPY --from=binary-fetcher /tmp/yt-dlp /usr/local/bin/yt-dlp
COPY --from=binary-fetcher /tmp/ffmpeg /usr/local/bin/ffmpeg
COPY --from=binary-fetcher /tmp/ffprobe /usr/local/bin/ffprobe

# Install reproducible production dependencies from lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source and static assets (protected by .dockerignore)
COPY server.cjs ./
COPY lib/ ./lib/
COPY public/ ./public/

# Create isolated writable temporary storage for non-root execution
RUN mkdir -p /var/reeva/media \
    && chown -R node:node /app /var/reeva/media \
    && chmod 0700 /var/reeva/media

# Run as unprivileged user
USER node

# Production runtime environment contract
ENV NODE_ENV=production \
    PORT=3000 \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    REEVA_TEMP_DIR=/var/reeva/media

EXPOSE 3000

# Container readiness probe using Reeva's /ready lifecycle endpoint
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/ready', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

# Direct exec form so node is PID 1 and receives SIGTERM directly for graceful shutdown
CMD ["node", "server.cjs"]
