# Instala ou cuida do Planejai num servidor pelo SSH, rodando do seu Windows (PowerShell 5+ com o OpenSSH do Windows 10/11).
# Mesmo jeito do deploy/instalar-ssh.sh (Linux/Mac).
#
#   .\deploy\instalar-ssh.ps1 root@203.0.113.10                         # instala (as perguntas aparecem aqui)
#   .\deploy\instalar-ssh.ps1 ubuntu@vps -Porta 2222 -Chave ~\.ssh\vps    # porta e chave; usuário comum usa sudo
#   .\deploy\instalar-ssh.ps1 root@vps -Respostas respostas.env           # sem perguntas (ver deploy\respostas.exemplo.env)
#   .\deploy\instalar-ssh.ps1 root@vps -CodigoLocal                       # manda esta cópia do repositório
#   .\deploy\instalar-ssh.ps1 root@vps status                             # update | status | logs | backup | restart | uninstall
#
# Se o Windows bloquear o script: powershell -ExecutionPolicy Bypass -File .\deploy\instalar-ssh.ps1 root@vps
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Servidor,
  [Parameter(Position = 1)]
  [ValidateSet('install', 'update', 'upgrade', 'status', 'ps', 'logs', 'backup', 'restart', 'uninstall')]
  [string]$Comando = 'install',
  [Parameter(Position = 2, ValueFromRemainingArguments = $true)][string[]]$Extra = @(),
  [int]$Porta = 0,
  [string]$Chave = '',
  [string]$Respostas = '',
  [string]$Branch = 'main',
  [switch]$CodigoLocal
)
$ErrorActionPreference = 'Stop'
$Repo = 'dhqdev/Planejai-Plataform'
$Raiz = Split-Path -Parent $PSScriptRoot

function Falha($msg) { Write-Host "erro $msg" -ForegroundColor Red; exit 1 }
foreach ($exe in 'ssh', 'scp') {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
    Falha "falta o $exe. Ative em Configurações > Sistema > Recursos opcionais > Cliente OpenSSH."
  }
}
if ($Respostas -and -not (Test-Path $Respostas)) { Falha "não achei o arquivo de respostas $Respostas" }

$sshArgs = @('-o', 'ServerAliveInterval=30')
$scpArgs = @()
if ($Porta) { $sshArgs += @('-p', "$Porta"); $scpArgs += @('-P', "$Porta") }
if ($Chave) { $sshArgs += @('-i', $Chave); $scpArgs += @('-i', $Chave) }

function Remoto([string]$cmd, [switch]$Terminal) {
  $a = $sshArgs
  if ($Terminal) { $a = @('-t') + $a }
  & ssh @a $Servidor $cmd
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
function Enviar([string]$arquivo, [string]$destino) {
  & scp -q @scpArgs $arquivo "${Servidor}:$destino"
  if ($LASTEXITCODE -ne 0) { Falha "não consegui copiar $arquivo para o servidor." }
}
# arquivo de texto com quebra de linha do Linux (LF) e sem BOM
function GravarLF([string]$caminho, [string]$texto) {
  [IO.File]::WriteAllText($caminho, ($texto -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
}

# Comandos remotos sem aspas duplas: o PowerShell 5 as perde ao chamar o ssh.exe.
# confere o servidor e se precisa de sudo
$info = & ssh @sshArgs $Servidor 'id -u; uname -s; uname -m; command -v sudo >/dev/null && echo sudo; command -v bash >/dev/null && echo bash; true'
if ($LASTEXITCODE -ne 0) { Falha "não consegui entrar em $Servidor pelo SSH." }
$linhas = @($info)
$uid, $os, $maquina = $linhas[0], $linhas[1], $linhas[2]
if ($os -ne 'Linux') { Falha "o servidor é $os; o Planejai instala em Linux." }
$sudo = ''
if ($uid -ne '0') {
  if ($linhas -notcontains 'sudo') { Falha 'o usuário não é root e o servidor não tem sudo.' }
  $sudo = 'sudo'
}
Write-Host "==> $Servidor ($os, $maquina)$(if ($sudo) { ', com sudo' })"
if ($linhas -notcontains 'bash') {
  Write-Host '==> Instalando o bash no servidor'
  Remoto "$sudo sh -c 'command -v apk >/dev/null && apk add --no-cache bash curl'"
}

if ($Comando -ne 'install') {
  $args2 = ($Extra | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
  & ssh -t @sshArgs $Servidor "command -v planejai >/dev/null || exit 97; $sudo planejai $Comando $args2"
  if ($LASTEXITCODE -eq 97) { Falha 'o Planejai não está instalado nesse servidor.' }
  exit $LASTEXITCODE
}

$rdir = (& ssh @sshArgs $Servidor 'umask 077; mktemp -d /tmp/planejai-instalar.XXXXXX' | Select-Object -First 1)
if (-not $rdir) { Falha 'não consegui criar a pasta temporária no servidor.' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("planejai-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($Respostas) {
    # só linhas VAR=valor, sem CR do Windows
    $txt = (Get-Content -LiteralPath $Respostas | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' }) -join "`n"
    GravarLF (Join-Path $tmp 'respostas.env') "$txt`n"
    Enviar (Join-Path $tmp 'respostas.env') "$rdir/respostas.env"
  }
  if ($CodigoLocal) {
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Falha 'falta o tar (vem no Windows 10 1803+).' }
    Write-Host "==> Mandando o código desta cópia ($Raiz)"
    $tgz = Join-Path $tmp 'src.tgz'
    & tar -C $Raiz --exclude=node_modules --exclude=.git --exclude=./.claude/worktrees --exclude=dist --exclude=.env -czf $tgz .
    if ($LASTEXITCODE -ne 0) { Falha 'não consegui empacotar o código.' }
    Enviar $tgz "$rdir/src.tgz"
    Remoto "mkdir -p '$rdir/src' && tar -xzf '$rdir/src.tgz' -C '$rdir/src' && rm -f '$rdir/src.tgz' && sed -i 's/\r$//' '$rdir/src/install.sh'"
  }

  $rodar = @"
#!/usr/bin/env bash
set -euo pipefail
d='$rdir'
trap 'rm -rf "`$d"' EXIT
export PLANEJAI_BRANCH='$Branch'
if [ -f "`$d/respostas.env" ]; then set -a; . "`$d/respostas.env"; set +a; rm -f "`$d/respostas.env"; fi
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
if [ -d "`$d/src" ]; then
  PLANEJAI_LOCAL_SRC="`$d/src" bash "`$d/src/install.sh" install
else
  curl -fsSL "https://raw.githubusercontent.com/$Repo/`$PLANEJAI_BRANCH/install.sh" -o "`$d/install.sh"
  bash "`$d/install.sh" install
fi
"@
  GravarLF (Join-Path $tmp 'rodar.sh') $rodar
  Enviar (Join-Path $tmp 'rodar.sh') "$rdir/rodar.sh"
  Remoto "$sudo bash '$rdir/rodar.sh'" -Terminal
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
