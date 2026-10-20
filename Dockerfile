# syntax=docker/dockerfile:1.7
# Imagem única (API + worker + dashboard). Multi-arch: todo o build roda na arquitetura
# do runner ($BUILDPLATFORM) e as dependências de produção são JS puro, então o estágio final
# só copia arquivos para a base node:22-alpine da arquitetura alvo (amd64 e arm64).
# Instalados na arquitetura alvo: ffmpeg (gravação do navegador e leitura de vídeo) e o cliente do
# Postgres 16 (pg_dump/pg_restore do backup no bucket e da restauração, mesma versão do serviço db).

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
# mudanças publicadas para o post de novidades do blog (o CI grava; build local fica sem)
RUN test -f apps/server/novidades.json || echo '[]' > apps/server/novidades.json

FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --workspace apps/server --include-workspace-root=false --ignore-scripts

FROM node:22-alpine
RUN apk add --no-cache ffmpeg && (apk add --no-cache postgresql16-client || apk add --no-cache postgresql-client)
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
COPY --from=build /app/apps/server/novidades.json ./apps/server/novidades.json
USER node
EXPOSE 3000
# api: /health responde; worker: processo vivo e conexão do WhatsApp sem travar (ver src/healthcheck.ts)
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "apps/server/dist/healthcheck.js"]
CMD ["node", "apps/server/dist/index.js"]
