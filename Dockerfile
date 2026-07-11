# ─────────────────────────────────────────────────────────────
# Multi-stage build for the LINE rental bot.
# Stage 1 compiles TypeScript with the full dependency set;
# stage 2 ships only dist/ + public/ + production deps.
# ─────────────────────────────────────────────────────────────

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app

# Install ALL deps (incl. devDeps) so tsc is available. Doing this before
# copying source keeps the layer cached across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only production deps at runtime (no tsx/typescript).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + the static LIFF assets it serves from ../public.
COPY --from=build /app/dist ./dist
COPY public ./public

# Railway injects PORT; the server reads it and binds 0.0.0.0.
EXPOSE 3000
CMD ["node", "dist/server.js"]
