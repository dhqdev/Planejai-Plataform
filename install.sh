#!/usr/bin/env bash
# Instalador do Planejai para qualquer VM Linux com Docker (amd64, arm64, armv7, armv6, s390x...).
#
#   curl -fsSL https://raw.githubusercontent.com/dhqdev/Planejai-Plataform/main/install.sh | sudo bash
#
# Depois de instalado vira o comando "planejai": planejai status | logs | update | backup | restart | uninstall.
# Formas de subir (escolhidas na instalação):
#   1) Docker Compose + HTTPS automático (Caddy, Let's Encrypt)   -> precisa de um domínio apontando para a VM
#   2) Docker Compose só com porta (atrás do seu proxy, ou para testar)
#   3) Docker Swarm + Traefik já existente (rede network_public, como o n8n)
#   4) Portainer: só gera as variáveis para colar na stack
# Código local em vez do GitHub: PLANEJAI_LOCAL_SRC=/caminho/do/repo.
# Sem perguntas: PLANEJAI_YES=1 e as variáveis (PLANEJAI_MODE, PLANEJAI_DOMAIN, ADMIN_EMAIL, OPENROUTER_API_KEY...).
set -euo pipefail

REPO="dhqdev/Planejai-Plataform"
BRANCH="${PLANEJAI_BRANCH:-main}"
DIR="${PLANEJAI_DIR:-/opt/planejai}"
IMAGE="ghcr.io/dhqdev/planejai-plataform"
YES="${PLANEJAI_YES:-0}"

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_b=$'\033[1m'; c_0=$'\033[0m'
[ -t 1 ] || { c_ok=; c_warn=; c_err=; c_dim=; c_b=; c_0=; }
say()  { printf '%s\n' "${c_b}==>${c_0} $*"; }
ok()   { printf '%s\n' "${c_ok}ok${c_0}  $*"; }
warn() { printf '%s\n' "${c_warn}!!${c_0}  $*" >&2; }
die()  { printf '%s\n' "${c_err}erro${c_0} $*" >&2; exit 1; }

# perguntas vêm do terminal mesmo quando o script chega por "curl | bash"
TTY=""
if [ "$YES" != "1" ] && { exec 3</dev/tty; } 2>/dev/null; then TTY=1; fi

# ask VAR "Pergunta" "padrão": usa a variável de ambiente se já existir; sem terminal, fica o padrão
ask() {
  local var="$1" q="$2" def="${3:-}" ans=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ -n "$TTY" ]; then
    if [ -n "$def" ]; then printf '%s [%s]: ' "$q" "$def" >&2; else printf '%s: ' "$q" >&2; fi
    IFS= read -r ans <&3 || true
  fi
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_secret() {
  local var="$1" q="$2" ans=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ -n "$TTY" ]; then
    printf '%s: ' "$q" >&2; IFS= read -rs ans <&3 || true; printf '\n' >&2
  fi
  printf -v "$var" '%s' "$ans"
}
confirm() { # confirm "Pergunta" (padrão sim)
  local ans=""
  [ "$YES" = "1" ] && return 0
  [ -n "$TTY" ] || return 0
  printf '%s [S/n]: ' "$1" >&2; IFS= read -r ans <&3 || true
  case "${ans,,}" in n|nao|não|no) return 1 ;; *) return 0 ;; esac
}
secret() { if command -v openssl >/dev/null; then openssl rand -hex 32; else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }

need_root() {
  [ "$(id -u)" = "0" ] && return
  if [ -f "$0" ] && command -v sudo >/dev/null; then exec sudo -E bash "$0" "$@"; fi
  die "rode como root: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sudo bash"
}

arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    armv7l|armv7*) echo arm/v7 ;;
    armv6l|armv6*) echo arm/v6 ;;
    s390x) echo s390x ;;
    ppc64le) echo ppc64le ;;
    riscv64) echo riscv64 ;;
    i386|i686) echo 386 ;;
    *) uname -m ;;
  esac
}
# imagem pronta no GitHub e navegador headless só existem nessas duas
prebuilt_arch() { case "$(arch)" in amd64|arm64) return 0 ;; *) return 1 ;; esac; }

ensure_docker() {
  if ! command -v docker >/dev/null; then
    warn "Docker não encontrado."
    confirm "Instalar o Docker agora (script oficial get.docker.com)?" || die "instale o Docker e rode de novo."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  fi
  docker info >/dev/null 2>&1 || die "o Docker está instalado mas não respondeu (docker info). Ele está rodando?"
  docker compose version >/dev/null 2>&1 || die "falta o plugin docker compose v2 (pacote docker-compose-plugin)."
  ok "Docker $(docker version --format '{{.Server.Version}}') · compose $(docker compose version --short) · $(arch)"
}

# baixa o código do GitHub (sem precisar de git) e copia os arquivos de deploy para $DIR
fetch_source() {
  say "Baixando o Planejai ($BRANCH) do GitHub"
  local tmp; tmp="$(mktemp -d)"
  if [ -n "${PLANEJAI_LOCAL_SRC:-}" ]; then
    # código já baixado (sem internet para o GitHub, ou testando uma cópia local)
    tar -C "$PLANEJAI_LOCAL_SRC" --exclude=node_modules --exclude=.git --exclude=./.claude/worktrees --exclude=dist -cf - . | tar -xf - -C "$tmp"
  else
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp" --strip-components=1
  fi
  [ -f "$tmp/deploy/portainer-stack.yml" ] || die "download incompleto."
  mkdir -p "$DIR/vm"
  rm -rf "$DIR/src"; mv "$tmp" "$DIR/src"
  cp "$DIR/src/deploy/portainer-stack.yml" "$DIR/portainer-stack.yml"
  cp "$DIR/src/deploy/vm/"* "$DIR/vm/"
  install -m 0755 "$DIR/src/install.sh" /usr/local/bin/planejai
  ok "código em $DIR/src · comando planejai instalado"
}

load_env() { [ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }; return 0; }

compose() {
  local files=(-f "$DIR/portainer-stack.yml" -f "$DIR/vm/compose.vm.yml")
  [ "${PLANEJAI_SOURCE:-ghcr}" = "build" ] && files+=(-f "$DIR/vm/compose.build.yml")
  docker compose -p planejai --project-directory "$DIR" --env-file "$DIR/.env" "${files[@]}" "$@"
}

configure() {
  if [ -f "$DIR/.env" ]; then
    ok "usando a configuração existente em $DIR/.env (as chaves não mudam)"
    load_env; return
  fi
  say "Configuração"
  if [ -z "${PLANEJAI_MODE:-}" ]; then
    printf '%s\n' "  1) Docker Compose com HTTPS automático (precisa de domínio apontando para esta VM)" \
                  "  2) Docker Compose só com porta (já tenho proxy, ou só testar)" \
                  "  3) Docker Swarm com Traefik já rodando (rede network_public)" \
                  "  4) Portainer: só gerar as variáveis para colar na stack" >&2
    ask MODE_N "Como subir" "1"
    case "$MODE_N" in 2) PLANEJAI_MODE=port ;; 3) PLANEJAI_MODE=swarm ;; 4) PLANEJAI_MODE=portainer ;; *) PLANEJAI_MODE=https ;; esac
  fi
  case "$PLANEJAI_MODE" in https|port|swarm|portainer) ;; *) die "PLANEJAI_MODE inválido: $PLANEJAI_MODE" ;; esac

  if [ -z "${PLANEJAI_SOURCE:-}" ]; then
    if prebuilt_arch; then
      ask SRC_N "Imagem: 1) pronta do GitHub (rápido)  2) compilar aqui" "1"
      [ "$SRC_N" = "2" ] && PLANEJAI_SOURCE=build || PLANEJAI_SOURCE=ghcr
    else
      PLANEJAI_SOURCE=build
      warn "arquitetura $(arch): não há imagem pronta, ela vai ser compilada aqui (alguns minutos) e o navegador headless fica de fora."
    fi
  fi

  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; ip="${ip:-localhost}"
  case "$PLANEJAI_MODE" in
    https|swarm)
      ask PLANEJAI_DOMAIN "Domínio do painel (ex.: planejai.seudominio.com)" ""
      [ -n "$PLANEJAI_DOMAIN" ] || die "o domínio é obrigatório nesse modo."
      PUBLIC_URL="https://$PLANEJAI_DOMAIN"
      [ "$PLANEJAI_MODE" = "https" ] && ask ACME_EMAIL "E-mail para o certificado (Let's Encrypt)" "${ADMIN_EMAIL:-}"
      [ "$PLANEJAI_MODE" = "swarm" ] && ask TRAEFIK_CERTRESOLVER "certresolver do Traefik" "letsencryptresolver"
      PLANEJAI_PORT="127.0.0.1:3080" ;;
    port|portainer)
      ask PLANEJAI_PORT "Porta do painel" "3080"
      ask PUBLIC_URL "Endereço público do painel" "http://$ip:${PLANEJAI_PORT##*:}" ;;
  esac

  ask ADMIN_EMAIL "E-mail do administrador" ""
  [ -n "$ADMIN_EMAIL" ] || die "o e-mail do administrador é obrigatório."
  ACME_EMAIL="${ACME_EMAIL:-$ADMIN_EMAIL}"
  ask_secret ADMIN_PASSWORD "Senha do painel (vazio = gerar uma)"
  GENERATED_PASSWORD=""
  [ -n "$ADMIN_PASSWORD" ] || { ADMIN_PASSWORD="$(secret | cut -c1-16)"; GENERATED_PASSWORD=1; }
  ask_secret OPENROUTER_API_KEY "Chave do OpenRouter (sk-or-...; dá para pôr depois no .env)"
  ask OWNER_PHONES "Seu WhatsApp com DDI e DDD (ex.: 5511999998888)" ""

  local profiles=()
  [ "$PLANEJAI_MODE" = "https" ] && profiles+=(https)
  # navegador headless (prints de páginas): só amd64/arm64; PLANEJAI_BROWSER=0 deixa de fora (VM com pouca RAM)
  if prebuilt_arch && [ "${PLANEJAI_BROWSER:-1}" != "0" ]; then profiles+=(browser); fi
  COMPOSE_PROFILES="$(IFS=,; echo "${profiles[*]:-}")"

  umask 077
  cat >"$DIR/.env" <<EOF
# Planejai: gerado pelo install.sh em $(date -u +%Y-%m-%dT%H:%MZ). NÃO perca a ENCRYPTION_KEY (abre as credenciais salvas).
PLANEJAI_MODE=$PLANEJAI_MODE
PLANEJAI_SOURCE=$PLANEJAI_SOURCE
PLANEJAI_TAG=${PLANEJAI_TAG:-latest}
PLANEJAI_PORT=$PLANEJAI_PORT
PLANEJAI_DOMAIN=${PLANEJAI_DOMAIN:-}
ACME_EMAIL=$ACME_EMAIL
TRAEFIK_CERTRESOLVER=${TRAEFIK_CERTRESOLVER:-letsencryptresolver}
COMPOSE_PROFILES=$COMPOSE_PROFILES

PUBLIC_URL=$PUBLIC_URL
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
OPENROUTER_API_KEY=$OPENROUTER_API_KEY
OWNER_PHONES=$OWNER_PHONES
WHATSAPP_PROVIDER=baileys
DEFAULT_TIMEZONE=America/Sao_Paulo

POSTGRES_PASSWORD=$(secret)
SESSION_SECRET=$(secret)
ENCRYPTION_KEY=$(secret)
WEBHOOK_SECRET=$(secret)
INTERNAL_API_KEY=$(secret)
BROWSERLESS_TOKEN=$(secret)
EOF
  chmod 600 "$DIR/.env"
  ok "configuração salva em $DIR/.env (só o root lê)"
  load_env
}

get_image() {
  if [ "${PLANEJAI_SOURCE:-ghcr}" = "build" ]; then
    say "Compilando a imagem para $(arch) (alguns minutos)"
    PLANEJAI_BUILD_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/src/package.json" | head -1)" compose build app
  else
    say "Baixando as imagens"
    compose pull --ignore-buildable || die "não consegui baixar a imagem $IMAGE. Rode 'docker login ghcr.io' ou reinstale com PLANEJAI_SOURCE=build."
  fi
}

wait_health() {
  local url="http://127.0.0.1:${PLANEJAI_PORT##*:}/health" i
  say "Esperando o Planejai responder"
  for i in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then ok "no ar"; return 0; fi
    sleep 3
  done
  warn "ainda não respondeu em $url. Veja: planejai logs app"
  return 1
}

up_compose() {
  get_image
  say "Subindo os serviços"
  compose up -d --remove-orphans
  wait_health || true
}

up_swarm() {
  docker info --format '{{.Swarm.LocalNodeState}}' | grep -q active || {
    confirm "Este Docker não está em modo Swarm. Ativar agora (docker swarm init)?" || die "Swarm desligado."
    docker swarm init >/dev/null
  }
  docker network inspect network_public >/dev/null 2>&1 || die "a rede network_public não existe: suba o Traefik antes (ou use o modo 1)."
  get_image
  say "Publicando a stack planejai no Swarm"
  local files=(-f "$DIR/portainer-stack.yml" -f "$DIR/vm/compose.vm.yml" -f "$DIR/vm/compose.swarm.yml")
  [ "$PLANEJAI_SOURCE" = "build" ] && files+=(-f "$DIR/vm/compose.build.yml")
  # o Swarm não entende alguns campos do compose: renderiza um arquivo só, sem eles
  docker compose -p planejai --project-directory "$DIR" --env-file "$DIR/.env" "${files[@]}" config \
    | sed -e '/^name:/d' -e '/^ *pull_policy:/d' >"$DIR/stack.rendered.yml"
  chmod 600 "$DIR/stack.rendered.yml"
  if [ "$PLANEJAI_SOURCE" = "build" ]; then
    docker stack deploy --resolve-image never -c "$DIR/stack.rendered.yml" planejai
  else
    docker stack deploy --with-registry-auth -c "$DIR/stack.rendered.yml" planejai
  fi
  ok "stack publicada. Acompanhe com: planejai status"
}

print_portainer() {
  say "Portainer: Stacks > Add stack > Repository"
  printf '%s\n' "  URL do repositório: https://github.com/$REPO" \
                "  Compose path:       deploy/portainer-stack.yml" \
                "  Em Environment variables > Advanced mode, cole:" ""
  grep -vE '^(#|PLANEJAI_MODE|PLANEJAI_SOURCE|COMPOSE_PROFILES|ACME_EMAIL|TRAEFIK_CERTRESOLVER|PLANEJAI_DOMAIN)' "$DIR/.env" | sed '/^$/d'
  printf '\n%s\n' "  (as mesmas linhas ficam guardadas em $DIR/.env)"
}

summary() {
  printf '\n%s\n' "${c_b}Planejai instalado${c_0}"
  printf '  Painel:  %s\n' "$PUBLIC_URL"
  printf '  Login:   %s\n' "$ADMIN_EMAIL"
  [ -n "${GENERATED_PASSWORD:-}" ] && printf '  Senha:   %s  %s\n' "$ADMIN_PASSWORD" "${c_dim}(gerada agora, troque no painel)${c_0}"
  [ -z "${OPENROUTER_API_KEY:-}" ] && warn "falta a OPENROUTER_API_KEY: ponha em $DIR/.env e rode planejai restart"
  printf '%s\n' "  Próximo passo: abra o painel, vá em WhatsApp e leia o QR code." \
                "  Comandos: planejai status | logs | update | backup | restart | uninstall"
}

cmd_install() {
  need_root "$@"
  say "Instalando o Planejai em $DIR"
  ensure_docker
  command -v curl >/dev/null || die "falta o curl."
  mkdir -p "$DIR"
  fetch_source
  configure
  case "$PLANEJAI_MODE" in
    https|port) up_compose ;;
    swarm) up_swarm ;;
    portainer) print_portainer; return ;;
  esac
  summary
}

cmd_update() {
  need_root "$@"; load_env
  [ -f "$DIR/.env" ] || die "não achei $DIR/.env. Rode a instalação primeiro."
  fetch_source
  case "$PLANEJAI_MODE" in
    swarm) up_swarm ;;
    portainer) say "No Portainer, atualize a stack com Re-pull image." ;;
    *) up_compose; docker image prune -f >/dev/null ;;
  esac
}

cmd_status() {
  load_env
  if [ "${PLANEJAI_MODE:-}" = "swarm" ]; then docker stack services planejai; else compose ps; fi
  curl -fsS "http://127.0.0.1:${PLANEJAI_PORT##*:}/health" 2>/dev/null && echo || true
}

cmd_logs() {
  load_env
  if [ "${PLANEJAI_MODE:-}" = "swarm" ]; then docker service logs -f --tail 200 "planejai_${1:-worker}"
  else compose logs -f --tail 200 "$@"; fi
}

cmd_backup() {
  need_root "$@"; load_env
  mkdir -p "$DIR/backups"
  local f; f="$DIR/backups/planejai-$(date +%Y%m%d-%H%M).dump"
  local db
  if [ "${PLANEJAI_MODE:-}" = "swarm" ]; then db="$(docker ps -q -f name=planejai_db | head -1)"; else db="$(compose ps -q db)"; fi
  [ -n "$db" ] || die "o banco não está rodando."
  docker exec "$db" pg_dump -U planejai -Fc planejai >"$f"
  chmod 600 "$f"
  ok "backup em $f ($(du -h "$f" | cut -f1)). Guarde junto o $DIR/.env (a ENCRYPTION_KEY)."
}

cmd_restart() {
  need_root "$@"; load_env
  if [ "${PLANEJAI_MODE:-}" = "swarm" ]; then up_swarm; else compose up -d --force-recreate app worker; fi
}

cmd_uninstall() {
  need_root "$@"; load_env
  confirm "Parar e remover os serviços do Planejai?" || exit 0
  if [ "${PLANEJAI_MODE:-}" = "swarm" ]; then docker stack rm planejai; else compose down; fi
  ok "serviços removidos. Dados (banco, WhatsApp, backups) continuam nos volumes e $DIR/.env continua lá."
  local ans=""
  if [ -n "$TTY" ]; then printf 'Para APAGAR TUDO (banco e backups), digite apagar: ' >&2; IFS= read -r ans <&3 || true; fi
  if [ "$ans" = "apagar" ]; then
    [ "${PLANEJAI_MODE:-}" = "swarm" ] || compose down -v
    docker volume ls -q | grep '^planejai_' | xargs -r docker volume rm >/dev/null || true
    rm -rf "$DIR" /usr/local/bin/planejai
    ok "tudo apagado."
  fi
}

usage() {
  printf '%s\n' "uso: planejai [install|update|status|logs [serviço]|backup|restart|uninstall]" \
                "variáveis: PLANEJAI_DIR (padrão /opt/planejai), PLANEJAI_BRANCH, PLANEJAI_YES=1, PLANEJAI_MODE=https|port|swarm|portainer, PLANEJAI_SOURCE=ghcr|build, PLANEJAI_BROWSER=0"
}

main() {
  local cmd="${1:-install}"; [ $# -gt 0 ] && shift
  case "$cmd" in
    install) cmd_install "$@" ;;
    update|upgrade) cmd_update "$@" ;;
    status|ps) cmd_status ;;
    logs) cmd_logs "$@" ;;
    backup) cmd_backup "$@" ;;
    restart) cmd_restart "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    -y|--yes) YES=1; TTY=""; cmd_install "$@" ;;
    -h|--help|help) usage ;;
    *) usage; exit 1 ;;
  esac
}
main "$@"
