# syntax=docker/dockerfile:1.6

FROM node:22.23.4-bookworm-slim AS base

RUN corepack enable && corepack prepare pnpm@10.9.0 --activate
WORKDIR /usr/src/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./



FROM base AS build

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build



FROM base AS prod-deps

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod



FROM node:22.23.4-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=prod-deps /usr/src/app/node_modules ./node_modules
COPY --from=build     /usr/src/app/dist         ./dist
COPY package.json ./

USER node
EXPOSE 3000

CMD ["node", "dist/hosted.js"]
