# Stage 1 — build TypeScript and compile native modules (better-sqlite3)
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build \
 && npm prune --omit=dev \
 && npm cache clean --force \
 # Trim files not needed at runtime (source maps, docs, bundled SQLite source)
 && find node_modules -type f \( -name "*.map" -o -name "*.md" \) -delete \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src

# Stage 2 — lean runtime image (no compilers, no dev dependencies)
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
VOLUME ["/app/data"]
EXPOSE 3000
# Always-on: Express dashboard + sync scheduler in one process.
# For one-shot sync (external cron), override the command:
#   docker run ... -e SYNC_INTERVAL_HOURS=0 truelayer2actual node dist/commands/sync.js
CMD ["node", "dist/commands/serve.js"]
