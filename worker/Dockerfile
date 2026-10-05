# Worker image: Node + iptables. Build context = repository root.
# Layout inside the image mirrors the repo (worker/ imports ../src/*.js).
#
# YOUR PRODUCT needs more (headless Chromium, ffmpeg, python, ...)? Install it here and add
# its npm dependencies to worker/package.json. Example for Playwright/Chromium:
#   ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
#   RUN node node_modules/playwright-core/cli.js install-deps chromium \
#    && node node_modules/playwright-core/cli.js install chromium
# (use the full node:22-bookworm image in that case, not -slim)
FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
      iptables iproute2 util-linux ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/worker
COPY worker/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
WORKDIR /app
COPY src/config.js src/security.js ./src/
COPY worker/*.js ./worker/
COPY worker/entrypoint.sh ./worker/entrypoint.sh
RUN chmod +x /app/worker/entrypoint.sh
# Starts as root only to install the egress firewall, then drops to "node".
ENTRYPOINT ["/app/worker/entrypoint.sh"]
