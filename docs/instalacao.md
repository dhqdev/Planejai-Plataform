# Instalação

O Planejai roda em qualquer máquina Linux com Docker. Escolha a forma que combina com o seu servidor.

| Forma | Para quem | O que precisa |
| --- | --- | --- |
| [Script `install.sh`](#script-installsh) com HTTPS automático | VM nova, sem nada instalado | Um domínio apontando para a VM, portas 80 e 443 livres |
| Script `install.sh` só com porta | Já tem Nginx/Caddy/Cloudflare na frente, ou só quer testar | Uma porta livre |
| Script `install.sh` em Swarm + Traefik | Servidor no padrão do n8n (rede `network_public`) | Traefik rodando em Swarm |
| [Pelo SSH, do seu computador](#pelo-ssh-do-seu-computador) | Instalar ou atualizar um servidor sem abrir terminal nele (Windows, Mac ou Linux) | Acesso SSH (root ou usuário com sudo) |
| [cloud-init](#cloud-init-vm-nova-que-já-nasce-instalada) | VM nova que já sobe com o Planejai (DigitalOcean, Hetzner, Oracle, AWS, Vultr, Magalu) | Campo "User data" do provedor |
| [Portainer](#portainer) | Quem já gerencia tudo pelo Portainer | Portainer com Compose ou Swarm |
| [Coolify, Dokploy, EasyPanel](#painéis-com-docker-compose) | Quem já usa um desses painéis | Painel que aceite Docker Compose |
| [Docker Compose na mão](#docker-compose-na-mão) | Quem prefere ver cada arquivo, ou Docker Desktop no Windows/Mac | Docker com o plugin compose |

## Arquiteturas

| Arquitetura | Imagem pronta (GitHub) | Compilar na máquina | Navegador headless |
| --- | --- | --- | --- |
| amd64 (Intel/AMD) | sim | sim | sim |
| arm64 (Oracle Ampere, Raspberry Pi 4/5 64 bits, Graviton, Mac M1+) | sim | sim | sim |
| armv7 (Raspberry Pi 2/3/4 com sistema 32 bits) | sim | sim | não |
| armv6, s390x, ppc64le, riscv64 | não | sim | não |

O CI publica a imagem para amd64, arm64 e armv7 a cada push na `main` (`ghcr.io/dhqdev/planejai-plataform`, um manifesto só: o Docker baixa a certa sozinho). Nas outras, o `install.sh` compila a imagem na própria máquina. O navegador headless (browserless) só existe para amd64 e arm64; sem ele tudo funciona, menos os prints de páginas e a gravação de tela dos agentes, e o `install.sh` já deixa ele de fora. Na stack do Portainer em armv7, apague o serviço `browserless`. O Postgres, o Redis e o Caddy têm imagens oficiais para todas.

Memória: com o navegador, conte uns 2 GB de RAM; sem ele (`PLANEJAI_BROWSER=0`), 1 GB já sobe.

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

### Pelo SSH, do seu computador

Roda no seu computador, entra no servidor pelo SSH e faz a instalação lá. As perguntas aparecem no seu terminal. Se o usuário não for root, usa `sudo`; se o servidor não tiver curl (ou bash, no Alpine), instala antes.

Linux, Mac ou WSL:

```bash
git clone https://github.com/dhqdev/Planejai-Plataform.git && cd Planejai-Plataform
./deploy/instalar-ssh.sh root@203.0.113.10                    # instala
./deploy/instalar-ssh.sh -p 2222 -i ~/.ssh/minha-vps ubuntu@vps # porta e chave
./deploy/instalar-ssh.sh root@vps update                      # depois: update, status, logs worker, backup, restart
```

Windows (PowerShell, com o cliente OpenSSH que já vem no Windows 10/11):

```powershell
git clone https://github.com/dhqdev/Planejai-Plataform.git; cd Planejai-Plataform
.\deploy\instalar-ssh.ps1 root@203.0.113.10
.\deploy\instalar-ssh.ps1 ubuntu@vps -Porta 2222 -Chave ~\.ssh\minha-vps
.\deploy\instalar-ssh.ps1 root@vps update
```

Se o Windows bloquear o script: `powershell -ExecutionPolicy Bypass -File .\deploy\instalar-ssh.ps1 root@vps`.

Opções dos dois:

| Bash | PowerShell | O que faz |
| --- | --- | --- |
| `-r arquivo` | `-Respostas arquivo` | Instala sem perguntas, com as respostas de um arquivo (modelo em [`deploy/respostas.exemplo.env`](../deploy/respostas.exemplo.env)). O arquivo vai pelo SSH com permissão 600 e é apagado do servidor assim que é lido. Não faça commit dele. |
| `--codigo-local` | `-CodigoLocal` | Manda a sua cópia do repositório em vez de baixar do GitHub (servidor sem acesso ao GitHub, ou testando uma mudança). A imagem continua vindo pronta; use `PLANEJAI_SOURCE=build` nas respostas para compilar com esse código. |
| `-b branch` | `-Branch branch` | Instala de outra branch. |
| `-p`, `-i`, `-o` | `-Porta`, `-Chave` | Porta, chave e opções extras do SSH. |

Vários servidores de uma vez: `for h in vps1 vps2; do ./deploy/instalar-ssh.sh -r respostas.env root@$h; done`.

### cloud-init (VM nova que já nasce instalada)

Ao criar a VM, cole [`deploy/cloud-init.yml`](../deploy/cloud-init.yml) no campo *User data* (ou *Cloud-init*) do provedor, com os seus valores. No primeiro boot ela instala o Docker e o Planejai sozinha. Acompanhe com `ssh root@IP tail -f /var/log/planejai-instalacao.log`. O provedor guarda o user-data, então troque a senha do painel no primeiro acesso. Para Terraform ou Ansible, o mesmo vale: rode o `install.sh` com `PLANEJAI_YES=1` e as variáveis (veja [Sem perguntas](#sem-perguntas)).

### Modo HTTPS

Sobe um Caddy na frente (`deploy/vm/compose.vm.yml`, perfil `https`) que tira o certificado do Let's Encrypt sozinho. O domínio precisa apontar para o IP da VM antes da instalação, e as portas 80 e 443 precisam estar livres e abertas no firewall da nuvem. O painel fica só em `127.0.0.1:3080` por dentro.

### Modo Swarm + Traefik

Junta `deploy/portainer-stack.yml` com `deploy/vm/compose.swarm.yml` (labels do Traefik, rede `network_public`, worker com `stop-first`) num arquivo só, `/opt/planejai/stack.rendered.yml`, e publica com `docker stack deploy`. O n8n na mesma rede chama o Planejai em `http://planejai-app:3000`.

## Portainer

- **Compose comum:** *Stacks > Add stack > Repository*, URL `https://github.com/dhqdev/Planejai-Plataform`, compose path `deploy/portainer-stack.yml`, e as variáveis do [`.env.example`](../.env.example) em *Environment variables*. O `install.sh` no modo `portainer` gera essas variáveis (com os segredos) para você colar.
- **Swarm + Traefik:** cole [`deploy/swarm-traefik-stack.yml`](../deploy/swarm-traefik-stack.yml) e troque os valores `TROQUE` (veja o README).

## Painéis com Docker Compose

Coolify, Dokploy, EasyPanel e parecidos aceitam um arquivo compose: aponte para o repositório com o caminho `deploy/portainer-stack.yml` (ou cole o arquivo) e preencha as variáveis do [`.env.example`](../.env.example). O domínio e o HTTPS ficam com o painel: ligue o domínio no serviço `app`, porta 3000. Em armv7, apague o serviço `browserless`. Esses painéis não foram testados um a um; se algum reclamar dos `profiles` ou de `depends_on`, a forma mais certa é o `install.sh` no modo `port` atrás do proxy do painel.

## Docker Compose na mão

```bash
git clone https://github.com/dhqdev/Planejai-Plataform.git /opt/planejai/src
cd /opt/planejai && cp src/deploy/portainer-stack.yml . && cp -r src/deploy/vm . && cp src/.env.example .env
# preencha o .env (segredos: openssl rand -hex 32) e suba com a imagem pronta:
docker compose -p planejai -f portainer-stack.yml -f vm/compose.vm.yml up -d
# ou compilando aqui (qualquer arquitetura):
docker compose -p planejai -f portainer-stack.yml -f vm/compose.vm.yml -f vm/compose.build.yml up -d --build
```

O `compose.build.yml` espera o código em `./src` ao lado dos arquivos de stack.

No Windows ou no Mac com Docker Desktop (para testar no seu computador) é o mesmo: com o `.env` preenchido e `PUBLIC_URL=http://localhost:3080`, rode o primeiro `docker compose ... up -d` acima e abra `http://localhost:3080`. Com WSL dá para usar o próprio `install.sh` no modo `port`. Perfis em `COMPOSE_PROFILES` no `.env`: `browser` (navegador headless) e `https` (Caddy, com `PLANEJAI_DOMAIN` e `ACME_EMAIL`).

## Escalar as conversas

O padrão é um `worker` que segura o WhatsApp e roda as conversas. Com muitos clientes, troque o `worker` da stack pelos serviços `channel` (WhatsApp, envios e agendados, sempre 1 réplica) e `conversations` (agentes, pode ter várias réplicas). Os dois estão comentados em `deploy/portainer-stack.yml`.
