# syntax=docker/dockerfile:1.7
# Imagem única (API + worker + dashboard). Multi-arch: todo o build roda na arquitetura
# do runner ($BUILDPLATFORM) e as dependências de produção são JS puro, então o estágio final
# só copia arquivos para a base node:22-alpine da arquitetura alvo (amd64 e arm64).
# A única coisa instalada na arquitetura alvo é o ffmpeg (gravação do navegador e leitura de vídeo).

FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY . .
# versão do push (CI) também no painel; vazio = a do package.json
ARG APP_VERSION=""
RUN APP_VERSION=$APP_VERSION npm run build

FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false --ignore-scripts

FROM node:22-alpine
RUN apk add --no-cache ffmpeg
# versão (release vX.Y.Z) e commit, mostrados no painel e no /health
ARG APP_VERSION=""
ARG GIT_SHA=""
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/public ./apps/server/public
USER node
EXPOSE 3000
# api: /health responde; worker: processo vivo e conexão do WhatsApp sem travar (ver src/healthcheck.ts)
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "apps/server/dist/healthcheck.js"]
CMD ["node", "apps/server/dist/index.js"]
