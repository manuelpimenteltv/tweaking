# Two production images from one Dockerfile:
#   docker build --target web -t loupe-web .
#   docker build --target worker -t loupe-worker .
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

# Web: Next.js server. No media tools — heavy processing runs in the worker.
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN corepack enable && useradd --system --uid 10001 loupe
COPY --from=build /app ./
USER loupe
EXPOSE 3000
CMD ["pnpm", "start"]

# Worker: processes untrusted media. Runs as an unprivileged user with FFmpeg.
# Deploy with no inbound network and egress limited to PostgreSQL + object storage.
FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* && corepack enable && useradd --system --uid 10001 loupe
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER loupe
CMD ["pnpm", "worker:prod"]
