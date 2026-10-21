import { BETA_NOTE, betaNote, forgetUber, lastRide, newShortcutToken, openRide, priceLabel, rideLink, shortcutUrl, startQuote, startRequest, uberAllowed } from "../../uber.js";
import { type RideApp, SITES, pickOption } from "../uber-robot.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/**
 * Uber e 99 pelo WhatsApp (beta, uber.ts; app "99" usa o mesmo robô). O Juvenal só enfileira: a lista de opções e o resultado chegam sozinhos
 * numa mensagem do sistema (sem IA). Pedir a corrida passa pelo "sim" conferido pelo servidor.
 */

const appOf = (v: unknown): RideApp => (String(v ?? "").trim() === "99" ? "99" : "uber");

const notEnabled = (app: RideApp, pickup?: string, dropoff?: string) => ({
  ok: false,
  not_enabled: true,
  link: rideLink(app, pickup, dropoff),
  message:
    app === "99"
      ? "Pedir 99 por aqui ainda está em teste e não foi liberado para esta pessoa. Mande o link: ele abre a 99 e ela põe o destino."
      : "Pedir Uber por aqui ainda está em teste e não foi liberado para esta pessoa. Mande o link: ele abre o app da Uber já com o destino, ela só confirma.",
});

export const uberQuote = defineTool<{ pickup: string; dropoff: string; app?: RideApp }>({
  name: "uber_quote",
  description:
    "Uber ou 99 (beta): entra na conta da pessoa no app e manda no WhatsApp as opções de corrida com preço e tempo de chegada (a lista chega sozinha, logo depois). " +
    "pickup e dropoff: endereço ou nome do lugar com bairro/cidade. Origem que ela não disse: use o endereço das memórias ou pergunte. app: \"99\" quando ela pedir 99; senão Uber.",
  parameters: obj({ pickup: { type: "string" }, dropoff: { type: "string" }, app: { type: "string", enum: ["uber", "99"] } }, ["pickup", "dropoff"]),
  async run(args, ctx) {
    const pickup = String(args.pickup ?? "").trim();
    const dropoff = String(args.dropoff ?? "").trim();
    const app = appOf(args.app);
    if (!pickup || !dropoff) return { ok: false, error: "Falta a origem ou o destino: pergunte antes." };
    if (!(await uberAllowed(ctx.user, app))) return notEnabled(app, pickup, dropoff);
    const r = await startQuote(ctx.user, pickup, dropoff, ctx.conversation?.id, app);
    if (!r.ok) return { ok: false, busy: true, message: "Já estou mexendo numa corrida dela agora. Diga que é só aguardar a mensagem com o resultado." };
    return {
      ok: true,
      queued: true,
      ahead: r.ahead,
      message:
        `Ainda NÃO tem preço: a lista chega sozinha numa mensagem logo depois da sua. Responda só uma frase curta dizendo que está vendo as opções na ${SITES[app].name}` +
        (r.ahead ? ` (tem ${r.ahead} pedido${r.ahead > 1 ? "s" : ""} na frente)` : "") +
        `, que se a ${SITES[app].name} mandar código por SMS ou e-mail você pede, e lembre que é beta ${betaNote(app)}. Não invente preço nem tempo.`,
    };
  },
});

export const uberRequest = defineTool<{ option: string; confirmed_by_user?: boolean }>({
  name: "uber_request",
  description:
    "Uber ou 99 (beta): pede a corrida que a pessoa escolheu da última lista de opções (número ou nome, ex.: '1' ou 'UberX'). " +
    "Chame com a escolha dela: o sistema pede o sim com o preço e só depois pede na Uber. Sem lista de menos de 10 min, chame uber_quote de novo.",
  parameters: obj({ option: { type: "string" }, ...CONFIRM_PARAM }, ["option"]),
  async run(args, ctx) {
    const ride = await openRide(ctx.user.id);
    if (!ride) return { ok: false, error: "Não tenho uma lista de opções de menos de 10 min. Chame uber_quote de novo com a origem e o destino." };
    const app = ride.provider ?? "uber";
    if (!(await uberAllowed(ctx.user, app))) return notEnabled(app);
    const option = pickOption(ride.options, args.option);
    if (!option) return { ok: false, error: `Não achei "${args.option}" na lista. Opções: ${ride.options.map((o) => `${o.n}. ${o.name}`).join(", ")}. Pergunte qual.` };
    // o resumo sai do que o robô leu na Uber (servidor), não do texto do modelo
    const n = SITES[app].name;
    const summary = `pedir um *${option.name}* na sua ${n}, de ${ride.pickup_label ?? ride.pickup} até ${ride.dropoff_label ?? ride.dropoff}, por ${priceLabel(option)} (paga no que está salvo na ${n})`;
    const wait = await requireConfirmation(args, summary, ctx);
    if (wait) return wait;
    const r = await startRequest(ride, option);
    if (!r.ok) return { ok: false, error: "Essa lista já foi usada ou venceu. Chame uber_quote de novo." };
    return {
      ok: true,
      queued: true,
      message: "Ainda NÃO está pedido: estou pedindo agora e a confirmação (ou o aviso de que o preço mudou) chega sozinha numa mensagem. Diga só isso, em uma frase.",
    };
  },
});

export const uberStatus = defineTool<Record<string, never>>({
  name: "uber_status",
  description: "Uber ou 99 (beta): situação da última corrida pedida por aqui (cotando, opções, pedindo, pedida, erro).",
  parameters: obj({}),
  async run(_args, ctx) {
    const r = await lastRide(ctx.user.id);
    if (!r) return { ride: null };
    const n = SITES[r.provider ?? "uber"].name;
    return {
      app: n,
      status: r.status,
      de: r.pickup_label ?? r.pickup,
      para: r.dropoff_label ?? r.dropoff,
      escolha: r.chosen ? `${r.chosen.name} ${priceLabel(r.chosen)}` : null,
      motorista: r.driver,
      erro: r.error,
      quando: r.updated_at,
      cancelar: `Cancelar é pelo app da ${n} (pode ter taxa).`,
    };
  },
});

export const uberShortcut = defineTool<Record<string, never>>({
  name: "uber_sms_shortcut",
  description:
    "Uber ou 99 (beta): manda à pessoa o passo a passo do Atalho (iPhone) ou app (Android) que encaminha sozinho o código do SMS da Uber e da 99, para ela não precisar digitar. " +
    "Use quando ela pedir para não ter que mandar o código.",
  parameters: obj({}),
  async run(_args, ctx) {
    if (!(await uberAllowed(ctx.user)) && !(await uberAllowed(ctx.user, "99"))) return notEnabled("uber");
    const url = shortcutUrl(await newShortcutToken(ctx.user.id));
    // o link tem um token pessoal: vai direto para ela, sem passar pelo modelo nem pelo registro da execução
    await ctx.channel.sendText(
      ctx.conversation.remote_jid,
      `📲 *Código da Uber e da 99 sem digitar*\n\n` +
        `*iPhone (app Atalhos):*\n` +
        `• Automação > Nova > *Mensagem*\n` +
        `• "Mensagem contém": *Uber*\n` +
        `• Marque *Executar imediatamente*\n` +
        `• Ação *Obter conteúdo de URL*: cole o link abaixo, método *POST*, corpo *JSON* com o campo *texto* = Mensagem\n` +
        `• Usa a 99? Faça outra igual com "Mensagem contém": *99*\n\n` +
        `*Android:* um app de encaminhar SMS para URL (ex.: SMS Forwarder) com filtro "Uber" (e "99"), mandando o texto no campo *texto* para o mesmo link.\n\n` +
        `Seu link (é só seu, não passe pra ninguém):\n${url}\n\n` +
        `Só uso o código quando eu mesmo estou entrando na sua Uber. Pedir de novo troca o link e o antigo para de valer.\n_${BETA_NOTE}_`,
    );
    return { ok: true, sent: true, message: "O passo a passo e o link já foram para ela. Diga só uma frase curta." };
  },
});

export const uberForget = defineTool<{ app?: RideApp; confirmed_by_user?: boolean }>({
  name: "uber_forget",
  description: "Uber ou 99 (beta): apaga a sessão guardada do app (desconecta). Na próxima corrida o app pede código de novo. app: \"99\" ou Uber.",
  parameters: obj({ app: { type: "string", enum: ["uber", "99"] }, ...CONFIRM_PARAM }),
  async run(args, ctx) {
    const app = appOf(args.app);
    const wait = await requireConfirmation(args, `apagar a sua conta da ${SITES[app].name} guardada aqui (desconectar)`, ctx);
    if (wait) return wait;
    return { ok: true, removed: await forgetUber(ctx.user.id, app) };
  },
});

export const UBER_TOOLS = [uberQuote, uberRequest, uberStatus, uberShortcut, uberForget];
