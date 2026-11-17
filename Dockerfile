# syntax=docker/dockerfile:1
#
# Not used by the Render blueprint (render.yaml uses the native node runtime).
# Kept so `docker build` works if a container host is wanted later.
#
# STATUS: written, NOT built. No Docker daemon was available where this was
# authored, so no `docker build` has been run against it. [UNVERIFIED: image builds]
#
# History: the previous file ran `npm ci` against a package-lock.json that this
# repo does not have (package-lock.json is gitignored; pnpm-lock.yaml is the only
# lockfile, package.json pins packageManager pnpm@10.26.2), so it could not have
# built. This one installs with pnpm through corepack, which reads the pinned
# version from package.json.
#
# Node 20 matches the previous Dockerfile. Node 20 reached end-of-life
# 2026-04-30; bump deliberately, after a build + `npm test` under the new major.

# ---- Builder ----
FROM node:20-alpine AS builder

WORKDIR /app

# bcrypt / msgpackr-extract may compile from source if no prebuild matches
RUN apk add --no-cache python3 make g++ \
  && corepack enable

# Manifest + lockfile first so the install layer caches. pnpm.onlyBuiltDependencies
# in package.json governs which postinstall scripts may run.
COPY package.json pnpm-lock.yaml .npmrc ./
# --prod=false: `nest build` needs devDependencies regardless of NODE_ENV
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm run build

# Slim the tree for the runtime image (keeps built native addons)
RUN pnpm prune --prod

# ---- Production ----
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache dumb-init \
  && addgroup -g 1001 -S nodejs \
  && adduser -S nestjs -u 1001

# COPY keeps pnpm's node_modules/.pnpm symlink layout intact
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
# Config packs are read from disk at runtime
COPY --from=builder --chown=nestjs:nodejs /app/packages ./packages

USER nestjs

# Hosts inject PORT (Render: 10000); default to 8000 otherwise
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8000)+'/api/v1/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main.js"]
