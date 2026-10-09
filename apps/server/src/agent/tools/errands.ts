import { one, query } from "../../db/pool.js";
import { MAX_ERRAND_MESSAGES, finishErrand, openErrands, sendToErrand, startErrand } from "../../errands.js";
import { blockedResult, checkErrandText } from "../errand-check.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

export const errandStart = defineTool<{ place: string; phone: string; message: string; goal: string; allowed?: string; hours?: number; confirmed_by_user?: boolean }>({
  name: "errand_start",
  description:
    "Fala com um estabelecimento (petshop, salão, clínica, restaurante) pelo WhatsApp em nome da pessoa: manda a primeira mensagem e o sistema acompanha as respostas sozinho, " +
    "fecha o que ela liberou e pergunta a ela o resto. É mensagem para terceiro: só sai depois do sim da pessoa. " +
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
      hours: { type: "number", description: "Quanto esperar resposta, padrão 24h" },
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
    const gate = await requireConfirmation(
      args,
      `mandar no WhatsApp de ${args.place} (${args.phone}): "${args.message}"` + (args.allowed ? `, e se ${args.allowed.replace(/^se\s+/i, "")}, eu fecho por você` : ", e te trago a resposta"),
      ctx,
    );
    if (gate) return gate;
    return startErrand({ user: ctx.user, conversationId: ctx.conversation.id, place: args.place, phone: args.phone, message: args.message, goal: args.goal, allowed: args.allowed, hours: args.hours, timezone: ctx.timezone });
  },
});

export const errandContinue = defineTool<{ errand_id: string; message: string; allowed?: string; confirmed_by_user?: boolean }>({
  name: "errand_continue",
  description:
    "Manda para o estabelecimento a decisão da pessoa num recado em andamento (ex.: 'pode ser 19h então'). É mensagem para terceiro: só sai depois do sim dela. " +
    "allowed: o que a pessoa acabou de liberar para fechar sem perguntar de novo.",
  parameters: obj({ errand_id: { type: "string" }, message: { type: "string" }, allowed: { type: "string" }, ...CONFIRM_PARAM }, ["errand_id", "message"]),
  async run(args, ctx) {
    const e = await one("SELECT place, goal, log FROM errands WHERE id::text = $1 AND user_id = $2", [args.errand_id, ctx.user.id]);
    if (!e) return { ok: false, error: "Recado não encontrado" };
    if (!ctx.approvedAction) {
      const previous = [...(e.log as { from: string; text: string }[])].reverse().find((l) => l.from === "nos")?.text;
      const check = await checkErrandText({ place: e.place, goal: e.goal, message: args.message, previous }, ctx.tracer, ctx.agent);
      if (!check.ok) return blockedResult(check);
    }
    const gate = await requireConfirmation(args, `responder para ${e.place}: "${args.message}"`, ctx);
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
  description: "Recados em andamento com estabelecimentos (com quem, o objetivo e se está esperando a pessoa decidir).",
  parameters: obj({}),
  async run(_args, ctx) {
    const list = await openErrands(ctx.user.id);
    return {
      errands: list.map((e) => ({
        id: e.id,
        place: e.place,
        goal: e.goal,
        allowed: e.allowed,
        status: e.status === "asking" ? `esperando a pessoa: ${e.question}` : "esperando eles",
        last: e.log.slice(-3).map((l) => `${l.from === "nos" ? "nós" : l.from}: ${l.text}`),
        messages_left: MAX_ERRAND_MESSAGES - e.sent,
      })),
    };
  },
});

export const errandCancel = defineTool<{ errand_id: string }>({
  name: "errand_cancel",
  description: "Para de acompanhar um recado (não manda nada para o estabelecimento).",
  parameters: obj({ errand_id: { type: "string" } }, ["errand_id"]),
  async run(args, ctx) {
    const e = await one("SELECT id FROM errands WHERE id::text = $1 AND user_id = $2", [args.errand_id, ctx.user.id]);
    if (!e) return { ok: false, error: "Recado não encontrado" };
    return finishErrand(e.id, { status: "cancelled", outcome: "cancelado pela pessoa", timezone: ctx.timezone });
  },
});
