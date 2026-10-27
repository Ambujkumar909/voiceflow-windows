# VoiceFlow server: Node 24 runs the TypeScript sources directly (no build step).
# Stateless: all data lives in Postgres, so any number of these can run behind a load balancer.
FROM node:24.22.1-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TRUST_PROXY=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY scripts ./scripts

# Unprivileged, and nothing in the image is writable at run time (compose mounts it read-only).
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Exec form: node itself is PID 1, so it receives SIGTERM directly and shuts down cleanly.
CMD ["node", "src/index.ts"]
