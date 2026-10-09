import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { Tracer } from "./trace.js";

/**
 * Trava dos recados: antes de qualquer mensagem sair para um estabelecimento (errand_start, errand_continue,
 * errand_reply), o servidor confere o texto e o objetivo. Não confia no modelo que escreveu: primeiro um filtro
 * rápido sem IA (tamanho, repetição, palavrão e ameaça óbvios), depois uma chamada barata que devolve JSON.
 * Bloqueou: nada sai, e o agente recebe o motivo e uma sugestão para conversar com a pessoa com jeito.
 */

export const MAX_ERRAND_TEXT = 600;

export type ErrandCheck = { ok: true } | { ok: false; reason: string; suggestion?: string };

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[@4]/g, "a")
    .replace(/[3]/g, "e")
    .replace(/[1!]/g, "i")
    .replace(/[0]/g, "o")
    .replace(/\$/g, "s");

/** Ofensa, palavrão e ameaça que não precisam de IA para recusar (pt-BR, sem acento, com as trocas comuns de letra). */
const ABUSE =
  /\b(porra|caralh\w*|puta|putas|puto|put[ao] que pariu|fdp|filh[oa] da puta|vsf|vtnc|vai (se fuder|se foder|tomar no \w+)|foda-?se|fod[ae]r|merda|bosta|cuzao|desgracad[oa]s?|otari[oa]s?|idiotas?|imbecis|imbecil|retardad[oa]s?|babacas?|vagabund[oa]s?|viados?|bichas?|traveco|criou?l[oa]s?|vou te (matar|pegar|quebrar)|te mato|vou (matar|explodir)|nudes?)\b/;

/** Pegadinha, spam e pergunta sobre a vida de outra pessoa: barato de pegar sem IA. */
const NONSENSE = /\b(trote|pegadinha|endereco d[oa] (dono|funcionari)|onde (ele|ela) mora|cpf d[oa]|telefone (pessoal|particular) d[oa])\b/;

export function quickCheck(text: string, previous?: string | null): ErrandCheck {
  const t = text.trim();
  if (!t) return { ok: false, reason: "mensagem vazia" };
  if (t.length > MAX_ERRAND_TEXT)
    return { ok: false, reason: `mensagem longa demais (${t.length} caracteres, máximo ${MAX_ERRAND_TEXT})`, suggestion: "Encurte para uma ou duas frases, com uma pergunta só." };
  if (previous && strip(previous).replace(/\W/g, "") === strip(t).replace(/\W/g, ""))
    return { ok: false, reason: "mensagem repetida: já foi mandada igual para eles", suggestion: "Espere a resposta deles ou pergunte de outro jeito." };
  if (/(.)\1{7,}/u.test(t) || /\b(\w+)(\s+\1\b){3,}/i.test(t)) return { ok: false, reason: "texto repetitivo, parece spam", suggestion: "Escreva uma pergunta clara, uma vez só." };
  const s = strip(t);
  if (ABUSE.test(s)) return { ok: false, reason: "tem palavra ofensiva, ameaça ou conteúdo impróprio", suggestion: "Pergunte com educação, sem xingamento nem ameaça." };
  if (NONSENSE.test(s)) return { ok: false, reason: "parece trote ou pede dado pessoal de alguém", suggestion: "O recado é para perguntar sobre um serviço (preço, horário, disponibilidade)." };
  return { ok: true };
}

const SYSTEM =
  "Você confere recados que um assistente vai mandar no WhatsApp para um estabelecimento (petshop, salão, clínica, loja) em nome de um cliente. " +
  "Aprove só pedido legítimo de serviço: preço, horário, agendamento, disponibilidade, orçamento, dúvida sobre o serviço, reclamação educada. " +
  "Recuse: ofensa, assédio, ameaça, discriminação, conteúdo sexual, algo ilegal, spam, trote ou piada, pedido de dado pessoal de funcionário ou de outra pessoa, " +
  "e assunto sem relação com o que o lugar oferece. " +
  'Responda só JSON: {"ok":true} ou {"ok":false,"reason":"motivo curto em pt-BR","suggestion":"como pedir de um jeito bom, uma frase"}.';

/**
 * Filtro rápido + uma chamada barata (rota `errand_check`), registrada no Tracer como passo "trava: recado".
 * Erro ao conferir também bloqueia: na dúvida, nada sai para o estabelecimento.
 */
export async function checkErrandText(
  opts: { place: string; goal: string; message: string; previous?: string | null },
  tracer: Tracer | undefined,
  agent = "recados",
): Promise<ErrandCheck> {
  const quick = quickCheck(opts.message, opts.previous) as ErrandCheck;
  const quickGoal = quick.ok ? quickCheck(opts.goal.slice(0, MAX_ERRAND_TEXT)) : quick;
  const step = tracer ? await tracer.step({ agent, type: "llm", name: "trava: recado", input: { place: opts.place, goal: opts.goal, message: opts.message } }) : null;
  if (!quickGoal.ok) {
    await step?.ok({ ...quickGoal, by: "filtro" });
    return quickGoal;
  }
  try {
    const r = await chatCompletion(await resolveModel("errand_check"), {
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Lugar: ${opts.place.slice(0, 120)}\nObjetivo: ${opts.goal.slice(0, 400)}\nMensagem: ${opts.message.slice(0, MAX_ERRAND_TEXT)}` },
      ],
    });
    const raw = String(r.message.content ?? "").replace(/^```(json)?|```$/g, "").trim();
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { ok?: unknown; reason?: unknown; suggestion?: unknown };
    const out: ErrandCheck =
      parsed.ok === true
        ? { ok: true }
        : { ok: false, reason: String(parsed.reason || "pedido fora do que um estabelecimento atende").slice(0, 200), suggestion: parsed.suggestion ? String(parsed.suggestion).slice(0, 300) : undefined };
    await step?.ok(out, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    return out;
  } catch (err) {
    await step?.fail(err);
    return { ok: false, reason: "não consegui conferir a mensagem agora", suggestion: "Tente de novo em instantes." };
  }
}

/** O que o agente recebe quando a trava segura a mensagem: curto, para ele contar à pessoa com jeito. */
export function blockedResult(c: Extract<ErrandCheck, { ok: false }>) {
  return {
    ok: false,
    blocked: true,
    error: `Mensagem NÃO enviada: ${c.reason}.` + (c.suggestion ? ` Sugestão: ${c.suggestion}` : "") + " Explique à pessoa com gentileza e proponha um jeito melhor de perguntar.",
  };
}
