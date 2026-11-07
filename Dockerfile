ARG NODE_IMAGE=node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

# ── Stage 1: Build frontend ──────────────────
FROM ${NODE_IMAGE} AS frontend-builder
ARG BUILD_EDITION=selfhosted
ARG BUILD_VERSION
WORKDIR /app
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
COPY public ./public
COPY server/openapi.yaml ./server/openapi.yaml
COPY scripts/sync-api-docs.mjs ./scripts/sync-api-docs.mjs
RUN BUILD_EDITION=$BUILD_EDITION BUILD_VERSION=$BUILD_VERSION npm run build

# ── Stage 2: Build server ────────────────────
FROM ${NODE_IMAGE} AS server-builder
ARG BUILD_EDITION=selfhosted
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build
RUN if [ "$BUILD_EDITION" != "cloud" ]; then rm -rf dist/ee; fi
RUN find dist -type d -name __tests__ -prune -exec rm -rf '{}' + \
    && find dist -type f \( -name '*.test.js' -o -name '*.test.js.map' \) -delete
RUN npm prune --omit=dev

# ── Stage 3: Runtime ─────────────────────────
FROM ${NODE_IMAGE}
# Bust the apk upgrade layer on every CI run so security patches land
# (otherwise BuildKit reuses a stale layer and Trivy flags old CVEs).
ARG APK_UPGRADE_BUST=0
RUN : "apk-upgrade-bust=${APK_UPGRADE_BUST}" \
    && apk upgrade --no-cache && apk add --no-cache postgresql-client font-dejavu \
    && npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm
WORKDIR /app
ENV NODE_ENV=production \
    SELF_HOSTED=true \
    PORT=1453 \
    DATABASE_PATH=/data/remindme.db \
    PHOTO_STORAGE_PATH=/data/photos \
    CAPTURE_SCRATCH_PATH=/scratch
COPY --chown=node:node --from=server-builder /app/package.json /app/package-lock.json* ./
COPY --chown=node:node LICENSE ./LICENSE
COPY --chown=node:node --from=server-builder /app/node_modules ./node_modules
COPY --chown=node:node --from=server-builder /app/dist ./dist
COPY --chown=node:node server/schema.sqlite.sql server/schema.pg.sql ./
COPY --chown=node:node server/scripts/migrate-sqlite-to-postgres.mjs ./scripts/migrate-sqlite-to-postgres.mjs
COPY --chown=node:node --from=frontend-builder /app/dist ./public
RUN mkdir -p /data/photos /data/photos/avatars /data/backups /scratch && chown -R node:node /data /scratch
USER node
EXPOSE 1453
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1453/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/start.js"]
