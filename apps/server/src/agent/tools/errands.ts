import { one, query } from "../../db/pool.js";
import { finishErrand, messageLimit, openErrands, sendToErrand, startErrand } from "../../errands.js";
import { CONVERSA_AGENTS, conversaAgent } from "../conversa.js";
import { blockedResult, checkErrandText, quickCheck } from "../errand-check.js";
import { normalizePhone } from "../../accounts.js";
import { phoneVariants } from "../../ingest.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation, type ToolContext } from "./types.js";


const norm = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const GENERIC_PLACE = /^(pet|petshop|shop|clinica|salao|restaurante|barbearia|studio|academia|loja|mercado|padaria|farmacia|consultorio|dra?|do|da|de|dos|das)$/;
/** Dinheiro, pagamento ou dado pessoal na mensagem: nunca sai sem o sim da pessoa. */
const RISKY_TEXT = /r\$|\breais?\b|\bpix\b|\bpag(ar|o|a|amento)\b|\bsinal\b|cart[aã]o|\bcpf\b|\bsenha\b|\bcobr/i;

/**
 * Pedido claro, sem pedir o "sim" de novo: a pessoa digitou o nome ou o número do lugar nesta mensagem, ou já fechou um recado
 * com esse número antes (costuma confirmar). Conferido no servidor, nunca por campo do modelo; dinheiro e dado pessoal sempre pedem sim.
 */
async function clearRequest(args: { place: string; phone: string; message: string; allowed?: string }, ctx: ToolContext) {
  if (ctx.proactive || !ctx.typedText?.trim()) return false;
  if (RISKY_TEXT.test(norm(`${args.message} ${args.allowed ?? ""}`))) return false;
  const typed = norm(ctx.typedText);
  const words = norm(args.place).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC_PLACE.test(w));
  const named = words.length > 0 && words.every((w) => typed.includes(w));
  const digits = normalizePhone(args.phone).slice(-8);
  const gave = digits.length === 8 && ctx.typedText.replace(/\D/g, "").includes(digits);
  if (named || gave) return true;
  const before = await one("SELECT 1 FROM errands WHERE user_id = $1 AND phone = ANY($2) AND status = 'done' AND kind = 'recado' LIMIT 1", [ctx.user.id, phoneVariants(normalizePhone(args.phone))]);
  return !!before;
}

export const errandStart = defineTool<{ place: string; phone: string; message: string; goal: string; allowed?: string; hours?: number; confirmed_by_user?: boolean }>({
  name: "errand_start",
  description:
    "Fala com um estabelecimento (petshop, salão, clínica, restaurante) pelo WhatsApp em nome da pessoa: manda a primeira mensagem e o sistema acompanha as respostas sozinho, " +
    "fecha o que ela liberou e pergunta a ela o resto. É mensagem para terceiro: só sai depois do sim da pessoa, EXCETO quando ela mesma citou o lugar ou o número na mensagem, ou já fechou recado com ele antes (aí o sistema envia direto, sem perguntar de novo). Valor, pagamento e dado pessoal sempre pedem sim. " +
    "allowed: o que pode ser fechado sem perguntar de novo, bem concreto (ex.: 'se tiver banho às 18h de hoje, confirmar'); sem isso, só pergunta e traz a resposta.",
  parameters: obj(
    {
      place: { type: "string", description: "Nome do lugar" },
      phone: { type: "string", description: "Telefone/WhatsApp do lugar, com DDD" },
      message: {
        type: "string",
        description: "Primeira mensagem: cumprimento, contexto mínimo e a pergunta no fim, natural (o sistema acerta bom dia/boa tarde e apresenta como assistente da pessoa)",
      },
      goal: { type: "string", description: "O que a pessoa quer resolver, com data e serviço" },
      allowed: { type: "string", description: "Condição já liberada para fechar sozinho (opcional)" },
      hours: { type: "number", description: "Quanto acompanhar a resposta, padrão e máximo 168h (7 dias)" },
      ...CONFIRM_PARAM,
    },
    ["place", "phone", "message", "goal"],
  ),
  async run(args, ctx) {
    // a trava confere antes de pedir o "sim": mensagem ofensiva, trote ou nada a ver nem chega a ser proposta
    if (!ctx.approvedAction) {
      const check = await checkErrandText({ place: args.place, goal: args.goal, message: args.message }, ctx.tracer, ctx.agent);
      if (!check.ok) return blockedResult(check);
    }
    const gate = (await clearRequest(args, ctx)) ? null : await requireConfirmation(
      args,
      `mandar no WhatsApp de ${args.place} (${args.phone}): "${args.message}"` + (args.allowed ? `, e se ${args.allowed.replace(/^se\s+/i, "")}, eu fecho por você` : ", e te trago a resposta"),
      ctx,
    );
    if (gate) return gate;
    return startErrand({ user: ctx.user, conversationId: ctx.conversation.id, place: args.place, phone: args.phone, message: args.message, goal: args.goal, allowed: args.allowed, hours: args.hours, timezone: ctx.timezone });
  },
});

export const conversaStart = defineTool<{ name: string; phone: string; message: string; goal: string; agent?: string; hours?: number; confirmed_by_user?: boolean }>({
  name: "conversa_start",
  description:
    "Põe um agente do time para CONVERSAR de verdade com uma pessoa pelo WhatsApp a pedido da dona (ex.: 'a Maria tá passando mal, conversa com ela'): " +
    "manda a primeira mensagem e o agente responde a pessoa sozinho até resolver, avisa a dona na hora se for sério e manda um resumo no fim. " +
    "Só para quando ela pede que alguém converse; recado de ida (só avisar algo) é send_whatsapp/send_to_contact. É mensagem para terceiro: só sai depois do sim.",
  parameters: obj(
    {
      name: { type: "string", description: "Nome da pessoa" },
      phone: { type: "string", description: "WhatsApp da pessoa, com DDD" },
      message: { type: "string", description: "Primeira mensagem, calorosa, dizendo que a dona pediu para conversar e perguntando como a pessoa está (o sistema apresenta o agente)" },
      goal: { type: "string", description: "O que está acontecendo e como ajudar, com o que a dona contou" },
      agent: { type: "string", enum: CONVERSA_AGENTS.map((a) => a.slug), description: "Quem conversa: saude para quem está doente; geral se nenhum combina" },
      hours: { type: "number", description: "Por quanto tempo conversar, padrão 24h (máx. 72)" },
      ...CONFIRM_PARAM,
    },
    ["name", "phone", "message", "goal"],
  ),
  async run(args, ctx) {
    const a = conversaAgent(args.agent);
    // sem IA: é pedido da própria dona, que vê o texto exato e diz o sim; o filtro rápido pega ofensa, spam e repetição
    if (!ctx.approvedAction) {
      const check = quickCheck(args.message);
      if (!check.ok) return blockedResult(check);
    }
    const hours = Math.min(Math.max(args.hours ?? 24, 1), 72);
    const gate = await requireConfirmation(
      args,
      `pôr ${a.persona} (${a.name}) para conversar com ${args.name} (${args.phone}) no WhatsApp por até ${hours}h, começando com: "${args.message}". ` +
        "Eu te aviso na hora se for algo sério e te mando um resumo no fim",
      ctx,
    );
    if (gate) return gate;
    return startErrand({
      user: ctx.user,
      conversationId: ctx.conversation.id,
      place: args.name,
      phone: args.phone,
      message: args.message,
      goal: args.goal,
      hours,
      timezone: ctx.timezone,
      kind: "conversa",
      agent: a.slug,
      persona: a.persona,
    });
  },
});

export const errandContinue = defineTool<{ errand_id: string; message: string; allowed?: string; confirmed_by_user?: boolean }>({
  name: "errand_continue",
  description:
    "Manda para o estabelecimento a decisão da pessoa num recado em andamento (ex.: 'pode ser 19h então'). É mensagem para terceiro: só sai depois do sim dela. " +
    "allowed: o que a pessoa acabou de liberar para fechar sem perguntar de novo.",
  parameters: obj({ errand_id: { type: "string" }, message: { type: "string" }, allowed: { type: "string" }, ...CONFIRM_PARAM }, ["errand_id", "message"]),
  async run(args, ctx) {
    const e = await one("SELECT place, goal, log, status FROM errands WHERE id::text = $1 AND user_id = $2", [args.errand_id, ctx.user.id]);
    if (!e) return { ok: false, error: "Recado não encontrado" };
    if (!ctx.approvedAction) {
      const previous = [...(e.log as { from: string; text: string }[])].reverse().find((l) => l.from === "nos")?.text;
      const check = await checkErrandText({ place: e.place, goal: e.goal, message: args.message, previous }, ctx.tracer, ctx.agent);
      if (!check.ok) return blockedResult(check);
    }
    // a pessoa acabou de decidir o que foi perguntado a ela (status 'asking'): a resposta dela já é o sim, não pede de novo (dinheiro e dado pessoal pedem)
    const decided = e.status === "asking" && !ctx.proactive && !!ctx.typedText?.trim() && !RISKY_TEXT.test(norm(`${args.message} ${args.allowed ?? ""}`));
    const gate = decided ? null : await requireConfirmation(args, `responder para ${e.place}: "${args.message}"`, ctx);
    if (gate) return gate;
    await query(
      `UPDATE errands SET allowed = COALESCE($2, allowed), log = log || $3::jsonb, updated_at = now() WHERE id::text = $1`,
      [args.errand_id, args.allowed ?? null, JSON.stringify([{ from: "pessoa", text: args.allowed ?? args.message, at: new Date().toISOString() }])],
    );
    return sendToErrand(args.errand_id, args.message);
  },
});

export const errandList = defineTool<Record<string, never>>({
  name: "errand_list",
  description: "Recados com estabelecimentos e conversas que o time está tendo com alguém a pedido da pessoa, em andamento (com quem, o objetivo e se está esperando a pessoa decidir).",
  parameters: obj({}),
  async run(_args, ctx) {
    const list = await openErrands(ctx.user.id);
    return {
      errands: list.map((e) => ({
        id: e.id,
        kind: e.kind,
        place: e.place,
        goal: e.goal,
        allowed: e.allowed,
        status: e.status === "asking" ? `esperando a pessoa: ${e.question}` : "esperando eles",
        last: e.log.slice(-3).map((l) => `${l.from === "nos" ? "nós" : l.from === "voce" ? "a pessoa, pelo painel" : l.from}: ${l.text}`),
        messages_left: messageLimit(e) - e.sent,
      })),
    };
  },
});

export const errandCancel = defineTool<{ errand_id: string }>({
  name: "errand_cancel",
  description: "Para de acompanhar um recado ou encerra uma conversa que o time está tendo com alguém (não manda nada para eles).",
  parameters: obj({ errand_id: { type: "string" } }, ["errand_id"]),
  async run(args, ctx) {
    const e = await one("SELECT id FROM errands WHERE id::text = $1 AND user_id = $2", [args.errand_id, ctx.user.id]);
    if (!e) return { ok: false, error: "Recado não encontrado" };
    return finishErrand(e.id, { status: "cancelled", outcome: "cancelado pela pessoa", timezone: ctx.timezone });
  },
});
