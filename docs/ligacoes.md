# Ligações de lembrete e alarme (central própria, sem Twilio)

O Planejai liga para a pessoa e fala o lembrete ("Lembrete do Planejai: hora de tomar o remédio", duas vezes).
Quem liga é uma central nossa, o serviço `voz` da stack (Asterisk + voz em português gerada no próprio servidor), e a ligação sai
por um **chip de celular** colocado num **gateway GSM**. Não tem custo por minuto: vale o plano do chip.

```
Planejai (worker) ──HTTP interno──> voz (Asterisk + Piper) ──internet──> gateway GSM na sua casa ──chip Claro──> celular da pessoa
```

Enquanto `VOZ_URL` e `VOZ_TOKEN` estiverem vazios, nada liga: lembrete e alarme seguem só no WhatsApp e no celular.

## 1. Comprar o gateway GSM

Uma caixinha com entrada para chip que conversa por SIP. Procure no Mercado Livre por "gateway GSM VoIP" e confira com o vendedor:

- **4G com VoLTE** (as redes 2G e 3G estão sendo desligadas no Brasil; gateway só 2G pode parar de funcionar);
- **registro em servidor SIP** ("SIP register", "SIP server", "trunk por registro");
- 1 chip basta (cada chip faz uma ligação por vez; com 2 chips dá para ligar em paralelo depois).

Exemplos de linha: Yeastar TG (TG200 em diante tem 4G), Dinstar 4G, GoIP 4G. Fica ligado na tomada e na internet (cabo de rede no roteador), num lugar com sinal da Claro.

## 2. O chip

Pode ser o mesmo chip do número do Planejai. O WhatsApp do Planejai roda pela internet e não precisa do chip no celular:
tire o chip do celular, coloque no gateway e **deixe o celular do WhatsApp ligado no Wi-Fi** (abra o WhatsApp nele de vez em quando, senão os aparelhos conectados caem).

Cuidados: plano de pessoa física não é feito para ligação automática. Com poucas ligações por dia o risco é baixo; se crescer muito, use um chip só para isso.
O limite do Planejai é de 10 ligações por pessoa em 24h.

## 3. Abrir as portas no servidor

No firewall da VPS (e no painel do provedor, se ele tiver firewall próprio), libere **UDP**:

- `5070` (o gateway se conecta por aqui);
- `10000` a `10019` (o áudio das ligações).

Não precisa abrir nada no roteador da sua casa: o gateway é quem chama o servidor.

## 4. Subir o serviço `voz` na stack

O arquivo `deploy/swarm-traefik-stack.yml` já traz o serviço `voz`. No Portainer, na stack do Planejai, troque:

| Onde | Variável | O que colocar |
| --- | --- | --- |
| bloco `x-env` | `VOZ_URL` | `http://voz:8080` (já vem assim) |
| bloco `x-env` e serviço `voz` | `VOZ_TOKEN` | o mesmo segredo nos dois lugares (`openssl rand -hex 32`) |
| serviço `voz` | `VOZ_SENHA_GATEWAY` | uma senha forte, 16+ caracteres; vai no gateway |
| serviço `voz` | `VOZ_IP_PUBLICO` | o IP público da VPS |
| serviço `voz` | `VOZ_DDD` | o DDD do chip (ex.: `19`) |
| serviço `voz` | `VOZ_CSP` | `21` para Claro (15 Vivo, 41 TIM) |

Atualize a stack. Em alguns segundos o serviço `voz` fica saudável (a imagem `ghcr.io/dhqdev/planejai-plataform-voz` sai do CI junto com a principal).

## 5. Configurar o gateway

Na tela de configuração do gateway (cada marca chama de um jeito), crie uma conta/linha SIP com:

- **Servidor SIP / Registrar / Proxy**: o IP público da VPS, porta `5070`, transporte UDP;
- **Usuário / Authentication ID / Número**: `gsm`;
- **Senha**: a mesma do `VOZ_SENHA_GATEWAY`;
- **Registrar**: ligado (intervalo 60 a 300 s);
- **Codecs**: G.711 A-law (PCMA) e µ-law (PCMU);
- **Rota IP → GSM**: as chamadas que chegam dessa conta saem pelo chip, discando o número como veio.

Quando o gateway aparecer como "registrado", a central vê o chip online.

## 6. Testar

No painel, **Minha conta > Alarmes**: com a central configurada aparece a escolha "Ligação" e o botão **Testar ligação**, que liga para o seu número.
O resultado aparece em **Execuções** (passo "alarme: ligação (teste)"). Pelo WhatsApp: "me liga daqui a 2 minutos pra lembrar de beber água".

Se der erro:

- "O gateway GSM não está conectado": o gateway não registrou. Confira IP, porta 5070/UDP aberta, usuário `gsm` e senha.
- Ligação chama mas fica muda: `VOZ_IP_PUBLICO` errado ou portas 10000-10019/UDP fechadas.
- Ligação não completa para outro DDD: o gateway talvez espere o número no formato +55. Ponha `VOZ_DISCAGEM: e164` no serviço `voz`.

Logs da central: no Portainer, serviço `voz` > Logs (o número das pessoas não vai para o log).
