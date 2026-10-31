FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY test/fixtures/agentorg-cli-79508a61.tgz ./test/fixtures/agentorg-cli-79508a61.tgz
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:24.22.1-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY test/fixtures/agentorg-cli-79508a61.tgz ./test/fixtures/agentorg-cli-79508a61.tgz
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
ENV HOST=0.0.0.0 PORT=8787 ORGACTOR_HOME=/data
EXPOSE 8787
VOLUME /data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/server/main.js"]
