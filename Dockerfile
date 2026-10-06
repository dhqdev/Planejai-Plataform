# syntax=docker/dockerfile:1.7
# Imagem única (API + worker + dashboard). Multi-arch: todo o build roda na arquitetura
# do runner ($BUILDPLATFORM) e as dependências de produção são JS puro, então o estágio final
# só copia arquivos para a base node:22-alpine da arquitetura alvo (amd64, arm64, arm/v7).
# A única coisa instalada na arquitetura alvo é o ffmpeg (gravação do navegador e leitura de vídeo).

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY . .
RUN npm run build

FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false --ignore-scripts

FROM node:22-alpine
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/public ./apps/server/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "apps/server/dist/index.js"]
