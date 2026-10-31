# syntax=docker/dockerfile:1.7
# Small production image: Node 22 on Debian slim (glibc, so @node-rs/argon2's
# prebuilt binary works without a compiler), non-root user, prod deps only.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY migrations ./migrations
COPY scripts ./scripts
COPY public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
