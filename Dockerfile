# Stage 1 — build TypeScript
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Stage 2 — lean runtime image
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist/
VOLUME ["/app/data"]
EXPOSE 3000
# Always-on: Express dashboard + sync scheduler in one process.
# For one-shot sync (external cron), override the command:
#   docker run ... -e SYNC_INTERVAL_HOURS=0 truelayer2actual node dist/commands/sync.js
CMD ["node", "dist/commands/serve.js"]
