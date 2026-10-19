#!/usr/bin/env bash
# Instala ou cuida do Planejai num servidor pelo SSH, rodando do seu computador (Linux, Mac ou WSL).
# No Windows sem WSL use deploy/instalar-ssh.ps1 (PowerShell, mesmo jeito).
#
#   ./deploy/instalar-ssh.sh root@203.0.113.10                 # instala (as perguntas aparecem aqui no seu terminal)
#   ./deploy/instalar-ssh.sh -p 2222 -i ~/.ssh/vps ubuntu@vps  # porta e chave; usuário comum usa sudo
#   ./deploy/instalar-ssh.sh -r respostas.env root@vps         # sem perguntas: respostas num arquivo (ver deploy/respostas.exemplo.env)
#   ./deploy/instalar-ssh.sh --codigo-local root@vps           # manda esta cópia do repositório em vez de baixar do GitHub
#   ./deploy/instalar-ssh.sh root@vps status                   # update | status | logs [serviço] | backup | restart | uninstall
#
# A senha do SSH (se houver) é pedida uma vez só: a conexão é reaproveitada.
# O arquivo de respostas vai pelo próprio SSH com permissão 600 e é apagado do servidor assim que a instalação lê.
set -euo pipefail

REPO="dhqdev/Planejai-Plataform"
BRANCH="${PLANEJAI_BRANCH:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
die() { printf 'erro %s\n' "$*" >&2; exit 1; }

PORT=""; KEY=""; ANSWERS=""; LOCAL_SRC=0; SSH_EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--porta) PORT="$2"; shift 2 ;;
    -i|--chave) KEY="$2"; shift 2 ;;
    -r|--respostas) ANSWERS="$2"; shift 2 ;;
    -b|--branch) BRANCH="$2"; shift 2 ;;
    --codigo-local) LOCAL_SRC=1; shift ;;
    -o) SSH_EXTRA+=(-o "$2"); shift 2 ;;
    -h|--help) usage ;;
    -*) die "opção desconhecida: $1 (veja --help)" ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || usage 1
TARGET="$1"; shift
CMD="${1:-install}"; [ $# -gt 0 ] && shift
case "$CMD" in install|update|upgrade|status|ps|logs|backup|restart|uninstall) ;; *) die "comando desconhecido: $CMD" ;; esac
[ -z "$ANSWERS" ] || [ -f "$ANSWERS" ] || die "não achei o arquivo de respostas $ANSWERS"
command -v ssh >/dev/null || die "falta o cliente ssh (openssh-client)."

sock="$(mktemp -u "${TMPDIR:-/tmp}/planejai-ssh.XXXXXX")"
SSH=(ssh -o ControlMaster=auto -o "ControlPath=$sock" -o ControlPersist=120 -o ServerAliveInterval=30)
[ -n "$PORT" ] && SSH+=(-p "$PORT")
[ -n "$KEY" ] && SSH+=(-i "$KEY")
SSH+=("${SSH_EXTRA[@]}")
cleanup() { "${SSH[@]}" -O exit "$TARGET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# primeira conexão: confere o servidor e se precisa de sudo
info="$("${SSH[@]}" "$TARGET" 'printf "%s %s %s\n" "$(id -u)" "$(uname -s)" "$(uname -m)"; command -v sudo >/dev/null && echo sudo; command -v bash >/dev/null && echo bash; true')" \
  || die "não consegui entrar em $TARGET pelo SSH."
read -r uid os machine <<<"$(head -1 <<<"$info")"
[ "$os" = "Linux" ] || die "o servidor é $os; o Planejai instala em Linux."
SUDO=""
if [ "$uid" != "0" ]; then
  grep -q '^sudo$' <<<"$info" || die "o usuário não é root e o servidor não tem sudo."
  SUDO="sudo"
fi
printf '==> %s (%s, %s)%s\n' "$TARGET" "$os" "$machine" "${SUDO:+, com sudo}"
if ! grep -q '^bash$' <<<"$info"; then
  # Alpine e imagens mínimas vêm sem bash
  printf '==> Instalando o bash no servidor\n'
  "${SSH[@]}" "$TARGET" "$SUDO sh -c 'command -v apk >/dev/null && apk add --no-cache bash curl'" || die "o servidor não tem bash; instale e rode de novo."
fi

# comandos do dia a dia: o install.sh já virou o comando "planejai" no servidor
if [ "$CMD" != "install" ]; then
  args=""; [ $# -gt 0 ] && args="$(printf '%q ' "$@")"
  "${SSH[@]}" -t "$TARGET" "command -v planejai >/dev/null || { echo 'erro o Planejai não está instalado nesse servidor' >&2; exit 1; }; $SUDO planejai $CMD $args"
  exit $?
fi

# pasta temporária no servidor (só o usuário lê)
rdir="$("${SSH[@]}" "$TARGET" 'umask 077; mktemp -d "${TMPDIR:-/tmp}/planejai-instalar.XXXXXX"')"
[ -n "$rdir" ] || die "não consegui criar a pasta temporária no servidor."

if [ -n "$ANSWERS" ]; then
  # tira CR do Windows e manda só linhas VAR=valor
  tr -d '\r' <"$ANSWERS" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | "${SSH[@]}" "$TARGET" "umask 077; cat > '$rdir/respostas.env'"
fi

if [ "$LOCAL_SRC" = "1" ]; then
  printf '==> Mandando o código desta cópia (%s)\n' "$HERE"
  tar -C "$HERE" --exclude=node_modules --exclude=.git --exclude=./.claude/worktrees --exclude=dist --exclude=.env -czf - . \
    | "${SSH[@]}" "$TARGET" "mkdir -p '$rdir/src' && tar -xzf - -C '$rdir/src'"
fi

# roda no servidor: lê as respostas, apaga o arquivo, garante o curl e chama o install.sh (perguntas vão para o seu terminal)
"${SSH[@]}" "$TARGET" "umask 077; cat > '$rdir/rodar.sh'" <<EOF
#!/usr/bin/env bash
set -euo pipefail
d='$rdir'
trap 'rm -rf "\$d"' EXIT
export PLANEJAI_BRANCH='$BRANCH'
if [ -f "\$d/respostas.env" ]; then set -a; . "\$d/respostas.env"; set +a; rm -f "\$d/respostas.env"; fi
if ! command -v curl >/dev/null; then
  echo "==> Instalando o curl"
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq curl ca-certificates
  elif command -v dnf >/dev/null; then dnf install -y -q curl
  elif command -v yum >/dev/null; then yum install -y -q curl
  elif command -v apk >/dev/null; then apk add --no-cache curl bash
  elif command -v zypper >/dev/null; then zypper -n install curl
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm curl
  else echo "erro instale o curl no servidor e rode de novo" >&2; exit 1; fi
fi
if [ -d "\$d/src" ]; then
  PLANEJAI_LOCAL_SRC="\$d/src" bash "\$d/src/install.sh" install
else
  curl -fsSL "https://raw.githubusercontent.com/$REPO/\$PLANEJAI_BRANCH/install.sh" -o "\$d/install.sh"
  bash "\$d/install.sh" install
fi
EOF

"${SSH[@]}" -t "$TARGET" "$SUDO bash '$rdir/rodar.sh'"
