# Self-hosted Remaivo: one container, one data volume.
#   docker run -d -p 5007:5007 -v remaivo-data:/data ghcr.io/stvrvdimitris/remaivo
# The build output is plain JavaScript, so build once on the native platform
# and only install the runtime (workerd) per target architecture.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN REMAIVO_HOST=selfhost pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=5007
# workerd needs CA certificates for outbound HTTPS (e.g. web fonts).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json ./
RUN MINIFLARE=$(node -p "require('./package.json').devDependencies.miniflare") \
 && echo '{"type":"module","private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund "miniflare@$MINIFLARE" \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY cloudflare/migrations ./cloudflare/migrations
COPY selfhost ./selfhost
VOLUME /data
EXPOSE 5007
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/manifest.webmanifest').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "selfhost/server.mjs"]
