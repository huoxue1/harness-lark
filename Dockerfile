# harness-lark — DeepSeek Harness Docker images
#
# Two targets share one npm-installed dsh CLI base:
#   - plain: the stock `dsh web` image (no Feishu plugin).
#   - lark:  the same image plus the harness-lark Feishu/Lark channel plugin.
#
# Both boot the web UI on port 3080 (dsh refuses --host 0.0.0.0, so the
# container binds loopback and the host publishes the port). All user data
# lives under $DSH_HOME (/root/.dsh) and persists on a mounted volume.
#
# Build:  docker build --target plain -t deepseek-harness:latest .
#         docker build --target lark   -t deepseek-harness-lark:latest .

# ── base: stock dsh CLI installed from npm ────────────────────────────────
FROM node:22-slim AS base
ENV NODE_ENV=production
ENV DSH_TELEMETRY_DISABLED=1
# pnpm is needed at runtime by `dsh plugin` for out-of-tree bundle installs.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# The published @deepseek-ai/dsh CLI bundles the web app and every profile
# package; override with --build-arg DSH_VERSION=<npm version>.
ARG DSH_VERSION=0.1.0-rc.6
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} --no-audit --no-fund

ENV DSH_HOME=/root/.dsh
VOLUME /root/.dsh
EXPOSE 3080

HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3080').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dsh", "--profile", "web"]

# ── plugin-build: compile harness-lark + prod deps ────────────────────────
FROM node:22-slim AS plugin-build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /plugin
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsdown.config.ts ./
COPY src ./src
COPY cordis.patch.yml ./
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# Prune to runtime dependencies only (dev toolchain is not shipped).
RUN pnpm install --frozen-lockfile --prod && rm -rf src

# ── lark: base + pre-built harness-lark plugin + first-run installer ──────
FROM base AS lark
COPY --from=plugin-build /plugin /plugins/harness-lark
COPY docker-entrypoint.sh /usr/local/bin/dsh-entrypoint
RUN chmod +x /usr/local/bin/dsh-entrypoint
ENTRYPOINT ["dsh-entrypoint"]
