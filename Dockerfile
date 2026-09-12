FROM node:24-slim AS build
ARG BARISTA_VERSION=dev
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @coffee-shop/protocol build \
 && VITE_BARISTA_VERSION="${BARISTA_VERSION}" pnpm --filter @coffee-shop/web build \
 && pnpm --filter @coffee-shop/hub build

FROM node:24-slim
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production PORT=8787 COFFEE_SHOP_DATA=/data/state.json
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml* ./
COPY --from=build /app/apps/hub/package.json ./apps/hub/package.json
COPY --from=build /app/apps/hub/dist ./apps/hub/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
RUN pnpm install --prod --frozen-lockfile=false
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "apps/hub/dist/index.js"]
