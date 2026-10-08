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
CMD ["node", "dist/commands/sync.js"]
