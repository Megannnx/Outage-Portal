# One image, two roles: `web` (Next.js) and `worker` (timers, delivery, escalations).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=UTC
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && groupadd -r portal && useradd -r -g portal -d /app portal
COPY --from=build --chown=portal:portal /app /app
USER portal
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "next", "start", "-p", "3000"]
