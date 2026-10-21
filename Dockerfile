FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --network-concurrency=1 --child-concurrency=1

COPY . .
RUN pnpm run check && pnpm run build

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=512

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates chromium python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]==2026.8.19' \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && yt-dlp --version && chromium --version && ffmpeg -version

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/app ./app
COPY --from=build /app/lib ./lib
COPY --from=build /app/types ./types
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/instrumentation.ts ./instrumentation.ts
COPY --from=build /app/proxy.ts ./proxy.ts
COPY --from=build /app/scripts/configure-admin-auth.mjs ./scripts/configure-admin-auth.mjs
COPY --from=build /app/deploy/check-runtime.cjs ./deploy/check-runtime.cjs

RUN mkdir -p /app/.data
EXPOSE 3000

CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
