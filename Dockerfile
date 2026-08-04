# syntax=docker/dockerfile:1
#
# Dockerfile — build the Vite bundle, ship nothing but static files + nginx.
#
# The game has no server side: `npm run build` produces a directory of static
# files (one HTML entry point, hashed JS/CSS, the two water textures) and that
# is the whole deployment. The runtime stage therefore carries no Node, no
# source and no node_modules — only nginx and dist/.
#
#   docker build -t hollowmere .
#   docker run --rm -p 8080:80 hollowmere

# ---------------------------------------------------------------------------
# Build stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first, so an edit to src/ doesn't re-run the install layer.
# `npm ci` (not `install`) so the build is pinned to package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci

# Only what the build actually reads. models/ is deliberately absent: the
# rigged GLB is unreferenced since the first-person conversion (see CLAUDE.md),
# so it is neither typechecked against nor bundled, and copying 7 MB of it in
# would only slow the build.
COPY tsconfig.json vite.config.ts index.html main.ts ./
COPY src ./src
COPY textures ./textures

# `npm run build` is `tsc --noEmit && vite build` — the typecheck is the only
# automated gate this repo has, so a type error fails the image build too.
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# nginx:alpine's own entrypoint/CMD already daemon-off's in the foreground.
