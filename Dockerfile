# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm i -g bun@1.4.2
COPY package.json bun.lock ./
COPY sdk ./sdk
COPY server ./server
RUN bun install --frozen-lockfile && bun run build
# Drop dev dependencies from the final tree.
RUN rm -rf node_modules sdk/packages/*/node_modules server/node_modules \
 && bun install --production --frozen-lockfile

FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 10000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
