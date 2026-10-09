# Instalação

O Planejai roda em qualquer máquina Linux com Docker. Escolha a forma que combina com o seu servidor.

| Forma | Para quem | O que precisa |
| --- | --- | --- |
| [Script `install.sh`](#script-installsh) com HTTPS automático | VM nova, sem nada instalado | Um domínio apontando para a VM, portas 80 e 443 livres |
| Script `install.sh` só com porta | Já tem Nginx/Caddy/Cloudflare na frente, ou só quer testar | Uma porta livre |
| Script `install.sh` em Swarm + Traefik | Servidor no padrão do n8n (rede `network_public`) | Traefik rodando em Swarm |
| [Portainer](#portainer) | Quem já gerencia tudo pelo Portainer | Portainer com Compose ou Swarm |
| [Docker Compose na mão](#docker-compose-na-mão) | Quem prefere ver cada arquivo | Docker com o plugin compose |

## Arquiteturas

| Arquitetura | Imagem pronta (GitHub) | Compilar na máquina | Navegador headless |
| --- | --- | --- | --- |
| amd64 (Intel/AMD) | sim | sim | sim |
| arm64 (Oracle Ampere, Raspberry Pi 4/5 64 bits, Graviton) | sim | sim | sim |
| armv7, armv6 (Raspberry Pi 32 bits), s390x | não | sim | não |

A imagem pronta só sai para amd64 e arm64 porque o navegador headless (browserless) só existe nessas duas. Nas outras, o `install.sh` compila a imagem na própria máquina e sobe sem o navegador: tudo funciona, menos os prints de páginas e a gravação de tela dos agentes. O Postgres e o Redis têm imagens oficiais para todas.

## Script `install.sh`

```bash
curl -fsSL https://raw.githubusercontent.com/dhqdev/Planejai-Plataform/main/install.sh | sudo bash
```

O script:

1. Confere o sistema e a arquitetura. Se não houver Docker, oferece instalar pelo script oficial (`get.docker.com`).
2. Baixa o código do GitHub em `/opt/planejai/src` (sem precisar de git) e instala o comando `planejai`.
3. Pergunta a forma de subir, o domínio ou a porta, o e-mail e a senha do painel, a chave do OpenRouter e o seu WhatsApp.
4. Gera os segredos (`openssl rand -hex 32`) e grava tudo em `/opt/planejai/.env`, que só o root lê. Numa reinstalação ou atualização o `.env` existente é reaproveitado e as chaves nunca mudam: a `ENCRYPTION_KEY` abre as credenciais já salvas.
5. Baixa a imagem pronta ou compila, sobe os serviços e espera o `/health` responder.

Depois de instalado:

```bash
planejai status            # serviços e /health
planejai logs worker       # logs (app, worker, db...)
planejai update            # baixa o código novo, atualiza a imagem e reinicia
planejai backup            # pg_dump em /opt/planejai/backups (guarde junto o .env)
planejai restart
planejai uninstall         # para os serviços; apaga dados só se você digitar "apagar"
```

### Sem perguntas

Tudo pode vir por variável, para automatizar (cloud-init, Terraform, Ansible):

```bash
curl -fsSL https://raw.githubusercontent.com/dhqdev/Planejai-Plataform/main/install.sh | sudo \
  PLANEJAI_YES=1 PLANEJAI_MODE=https PLANEJAI_DOMAIN=planejai.seudominio.com \
  ADMIN_EMAIL=voce@exemplo.com ADMIN_PASSWORD='...' OPENROUTER_API_KEY=sk-or-... OWNER_PHONES=5511999998888 bash
```

| Variável | Valores | Padrão |
| --- | --- | --- |
| `PLANEJAI_MODE` | `https`, `port`, `swarm`, `portainer` | pergunta (`https`) |
| `PLANEJAI_SOURCE` | `ghcr` (imagem pronta), `build` (compilar) | `ghcr` em amd64/arm64, `build` nas outras |
| `PLANEJAI_DIR` | pasta da instalação | `/opt/planejai` |
| `PLANEJAI_PORT` | porta do painel no modo `port` | `3080` |
| `PLANEJAI_BROWSER` | `0` deixa o navegador headless de fora (VM com pouca memória) | `1` |
| `PLANEJAI_BRANCH` | branch do GitHub | `main` |
| `PLANEJAI_LOCAL_SRC` | usar uma cópia local do repositório em vez de baixar | vazio |

### Modo HTTPS

Sobe um Caddy na frente (`deploy/vm/compose.vm.yml`, perfil `https`) que tira o certificado do Let's Encrypt sozinho. O domínio precisa apontar para o IP da VM antes da instalação, e as portas 80 e 443 precisam estar livres e abertas no firewall da nuvem. O painel fica só em `127.0.0.1:3080` por dentro.

### Modo Swarm + Traefik

Junta `deploy/portainer-stack.yml` com `deploy/vm/compose.swarm.yml` (labels do Traefik, rede `network_public`, worker com `stop-first`) num arquivo só, `/opt/planejai/stack.rendered.yml`, e publica com `docker stack deploy`. O n8n na mesma rede chama o Planejai em `http://planejai-app:3000`.

## Portainer

- **Compose comum:** *Stacks > Add stack > Repository*, URL `https://github.com/dhqdev/Planejai-Plataform`, compose path `deploy/portainer-stack.yml`, e as variáveis do [`.env.example`](../.env.example) em *Environment variables*. O `install.sh` no modo `portainer` gera essas variáveis (com os segredos) para você colar.
- **Swarm + Traefik:** cole [`deploy/swarm-traefik-stack.yml`](../deploy/swarm-traefik-stack.yml) e troque os valores `TROQUE` (veja o README).

## Docker Compose na mão

```bash
git clone https://github.com/dhqdev/Planejai-Plataform.git /opt/planejai/src
cd /opt/planejai && cp src/deploy/portainer-stack.yml . && cp -r src/deploy/vm . && cp src/.env.example .env
# preencha o .env (segredos: openssl rand -hex 32) e suba com a imagem pronta:
docker compose -p planejai -f portainer-stack.yml -f vm/compose.vm.yml up -d
# ou compilando aqui (qualquer arquitetura):
docker compose -p planejai -f portainer-stack.yml -f vm/compose.vm.yml -f vm/compose.build.yml up -d --build
```

O `compose.build.yml` espera o código em `./src` ao lado dos arquivos de stack. Perfis em `COMPOSE_PROFILES` no `.env`: `browser` (navegador headless) e `https` (Caddy, com `PLANEJAI_DOMAIN` e `ACME_EMAIL`).

## Escalar as conversas

O padrão é um `worker` que segura o WhatsApp e roda as conversas. Com muitos clientes, troque o `worker` da stack pelos serviços `channel` (WhatsApp, envios e agendados, sempre 1 réplica) e `conversations` (agentes, pode ter várias réplicas). Os dois estão comentados em `deploy/portainer-stack.yml`.
