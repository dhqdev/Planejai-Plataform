# Planejai

Assistente pessoal no WhatsApp no estilo do Instinct: uma única conversa que pesquisa na internet, manda prints, agenda lembretes naturais, anota gastos, mexe no seu e-mail e agenda, gera links de pagamento e reage às suas mensagens com emoji.

Por dentro é um **time de agentes de IA que conversam entre si**: o **CTO** fala com você e lidera o time; os especialistas trabalham em paralelo, consultam uns aos outros (`consult_*`), anotam descobertas num quadro compartilhado, e o CTO revisa e devolve trabalho incompleto antes de mandar a resposta. Cada conversa CTO ↔ especialista é contínua dentro da execução, então dá para cobrar e ajustar.

| Agente | O que faz | Modelo padrão (OpenRouter) |
| --- | --- | --- |
| 🧠 CTO | Conversa, reage, guarda memórias, delega e compõe a resposta | `deepseek/deepseek-v4.1-flash` |
| 🔎 Pesquisador | Busca na web, lê páginas, tira prints | `xiaomi/mimo-v2.6-flash` |
| 📅 Agenda | Lembretes únicos/recorrentes, Google Agenda | `deepseek/deepseek-v4.1-flash` |
| 💰 Financeiro | Gastos, receitas, resumo do mês, links de pagamento | `deepseek/deepseek-v4.1-flash` |
| ✉️ Comunicação | Gmail e Slack | `deepseek/deepseek-v4.1-flash` |
| 🗂️ Produtividade | Notion, Linear, GitHub | `deepseek/deepseek-v4.1-flash` |
| Áudio / foto / resumo | Transcrição, visão, compactação de memória | `qwen/qwen3.8-omni-flash`, `xiaomi/mimo-v2.6-flash` |

Todos os modelos têm fallback e podem ser trocados na tela **Modelos** do dashboard, que mostra os preços do catálogo do OpenRouter ao vivo.

## O que tem

- **Backend próprio** (Node 22 + TypeScript + Fastify), fila e agendamentos com pg-boss no próprio Postgres.
- **WhatsApp próprio (Baileys)**: o worker conecta direto no WhatsApp Web multi-device. Você lê o QR code (ou digita um código de pareamento) na tela **WhatsApp** do dashboard; a sessão fica salva no Postgres e se reconecta sozinha. Também funciona com Evolution API ou com a Cloud API oficial da Meta. Texto, áudio (transcrito), foto (descrita por visão), documentos, localização, respostas citadas e reações.
- **Jeito humano**: junta mensagens seguidas antes de responder, marca como lida, mostra "digitando…", divide a resposta em balões, reage com emoji e às vezes só reage sem responder.
- **Lembretes naturais**: o lembrete guarda a intenção; na hora o CTO escreve a mensagem com contexto ("David, passaram os 15 minutos: hora de ir ao banheiro!").
- **Integrações** com credenciais criptografadas no banco: Google Workspace (OAuth), Notion, GitHub, Linear, Slack, Tavily, Brave, Browserless, Mercado Pago, Stripe.
- **Dashboard estilo n8n**: execuções com canvas do fluxo e entrada/saída de cada passo, conversas, time de agentes, integrações, modelos, lembretes, pessoas (aprovar números), playground para testar sem WhatsApp, tema claro e escuro.
- **Segurança**: compras, pagamentos e mensagens para terceiros exigem confirmação explícita; números desconhecidos ficam aguardando aprovação.

## Deploy no Portainer

1. Faça push na `main`. O GitHub Actions publica `ghcr.io/dhqdev/planejai-plataform:latest` para **amd64, arm64 e arm/v7**.
   - O pacote do GHCR nasce privado: torne-o público em *GitHub > Packages > planejai-plataform > Settings* ou cadastre o registry `ghcr.io` no Portainer com um token `read:packages`.
2. No Portainer: *Stacks > Add stack*, cole `deploy/portainer-stack.yml` (ou aponte para este repositório) e preencha as variáveis de `.env.example`. No mínimo: `PUBLIC_URL`, `POSTGRES_PASSWORD`, `APP_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `OPENROUTER_API_KEY`, `WEBHOOK_SECRET`, `OWNER_PHONES`, `BROWSERLESS_TOKEN` e as variáveis do provedor de WhatsApp.
3. A stack sobe `app` (API + dashboard), `worker` (agentes, lembretes), `db` (Postgres 16 próprio, volume `planejai_db`) e `browserless` (prints de páginas).
4. Conecte o WhatsApp:
   - **Baileys (padrão)**: abra o dashboard, vá em **WhatsApp** e leia o QR code com o celular do número do assistente (*Dispositivos conectados > Conectar um dispositivo*). Use um número dedicado ao assistente. Mantenha o `worker` com 1 réplica.
   - **Evolution**: `{PUBLIC_URL}/webhooks/evolution?secret={WEBHOOK_SECRET}`, evento `MESSAGES_UPSERT`.
   - **Cloud API**: `{PUBLIC_URL}/webhooks/whatsapp`, verify token `WHATSAPP_CLOUD_VERIFY_TOKEN`, campo `messages`.
5. Redeploy automático (opcional): crie um webhook na stack do Portainer e salve a URL no secret `PORTAINER_WEBHOOK_URL` do repositório.

## Desenvolvimento

```bash
npm ci
cp .env.example .env
docker compose up db -d
npm run dev             # API + worker em http://localhost:3000
npm run dev:dashboard   # dashboard em http://localhost:5173
npm run typecheck && npm test
```

Tudo sobre a arquitetura e como estender (nova ferramenta, integração, especialista, modelo) está na skill do Claude Code em [`.claude/skills/planejai/SKILL.md`](.claude/skills/planejai/SKILL.md).
