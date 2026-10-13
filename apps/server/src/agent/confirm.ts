import { many, query } from "../db/pool.js";
import type { ChatMessage } from "../llm/types.js";
import { isOwner } from "../ingest.js";
import { asPerson } from "../integrations/person.js";
import { isOwnerOnly, personOf } from "./runner.js";
import { CLIENT_AGENT_TOOLS, CTO_TOOL_GROUPS, CTO_TOOLS, SPECIALISTS } from "./team.js";
import type { Tool, ToolContext } from "./tools/types.js";

/** Pedido de confirmação vale por este tempo; depois a pessoa precisa pedir de novo. */
const PENDING_MINUTES = 30;

export interface PendingAction {
  id: number;
  tool: string;
  agent: string;
  args: Record<string, unknown>;
  summary: string;
}

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[!.,;:~?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const NO = /^(nao|n|nem|cancela|cancelar|deixa|deixa pra la|esquece|para|pare|melhor nao|nao precisa|nao pode|negativo|👎|❌)\b/u;

/** Começo de um sim: "sim", "pode", "isso", "manda"... (simmm e siim também). */
const YES_START = /^(s+i+m+|s|ss|pode( ser)?|confirm[oa]?|confirmad[oa]|isso|ok+|okay|beleza|blz|fechado|claro|com certeza|positivo|bora|vai|faz|manda( bala)?|envia|apaga|exclui|dispara|gera|convida|perfeito|certo|ta( bom)?|uhum+|aham+|yes|por favor)(?= |$)/u;
/** O que pode vir depois do sim sem mudar nada: reforço, o verbo da própria ação, agradecimento ou emoji. */
const YES_TAIL = new Set(
  ("sim s pode isso mesmo claro manda mandar envia enviar apaga apagar exclui excluir faz fazer seguir ir bala ser ai la ja agora " +
    "por favor pfv pf ok beleza blz certo perfeito bora vai confirmo confirma dispara disparar gera gerar convida convidar " +
    "obrigado obrigada brigado brigada valeu vlw tmj show top otimo legal e pra voce de pode sim").split(" "),
);
/** Só agradecimento ou emoji: não muda a resposta ("sim" e logo depois "valeu"). */
const FILLER = /^(valeu|vlw|obrigad[oa]|brigad[oa]|tmj|show|top|otimo|legal|blz)?$/u;
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u200d\ufe0f]/gu;
const POSITIVE_EMOJI = /^(👍|✅|👌|🙏|😊|😁|🙌|❤️|❤|💜|😉|🤝|👏)+$/u;

type Kind = "yes" | "no" | "more" | "other" | "filler";

/** Uma mensagem: sim puro, não, sim com outra coisa junto ("sim, mas troca o e-mail"), outra coisa, ou só "valeu"/emoji. */
function classify(raw: string): Kind {
  const compact = raw.replace(/\s+/g, "");
  if (compact && POSITIVE_EMOJI.test(compact)) return "yes";
  if (/^(👎|❌)+$/u.test(compact)) return "no";
  const said = strip(raw.replace(EMOJI, " "));
  if (!said) return "filler";
  if (NO.test(said)) return "no";
  if (FILLER.test(said)) return "filler";
  const start = said.match(YES_START);
  if (!start) return "other";
  const rest = said.slice(start[0].length).trim();
  if (!rest || (said.length <= 60 && rest.split(" ").every((w) => YES_TAIL.has(w) || /^s+i+m+$/.test(w)))) return "yes";
  // "pode ver meu saldo?" é pedido novo, não um sim com detalhe
  return /\?\s*$/.test(raw) ? "other" : "more";
}

/** Lê o lote inteiro: vale a última mensagem que não é só agradecimento ou emoji solto. */
function decide(texts: string[]): Kind | null {
  const kinds = texts.map(classify).filter((k) => k !== "filler");
  return kinds.at(-1) ?? null;
}

/** "sim", "sim, pode mandar", "👍": a pessoa liberou. "não", "cancela": recusou. Qualquer outra coisa: ainda não decidiu. */
export function confirmationAnswer(texts: string[]): "yes" | "no" | null {
  const k = decide(texts);
  return k === "yes" || k === "no" ? k : null;
}

export async function openPending(conversationId: string): Promise<PendingAction[]> {
  return many<PendingAction>(
    `SELECT id, tool, agent, args, summary FROM pending_actions
      WHERE conversation_id = $1 AND status = 'pending' AND created_at > now() - make_interval(mins => $2) ORDER BY id`,
    [conversationId, PENDING_MINUTES],
  );
}

let registry: Map<string, Tool> | null = null;
function toolByName(name: string) {
  registry ??= new Map([...CTO_TOOLS, ...CTO_TOOL_GROUPS.flatMap((g) => g.tools), ...SPECIALISTS.flatMap((s) => s.tools), ...Object.values(CLIENT_AGENT_TOOLS)].map((t) => [t.name, t]));
  return registry.get(name);
}

/**
 * Resolve as ações guardadas com a resposta da PESSOA (texto dela, não do modelo):
 * "sim" executa exatamente o que foi guardado, "não" descarta. Devolve notas de sistema para o CTO contar o resultado.
 */
export async function resolvePending(pending: PendingAction[], userTexts: string[], ctx: ToolContext): Promise<ChatMessage[]> {
  if (!pending.length) return [];
  const answer = confirmationAnswer(userTexts);
  const notes: ChatMessage[] = [];
  const kind = decide(userTexts);
  if (!userTexts.some((t) => t.trim()) || kind === "more") {
    // respondeu em áudio, figurinha ou foto, ou começou com sim e pediu outra coisa junto ("sim, mas troca o e-mail"):
    // nada roda, mas o pedido continua valendo para um sim curto ou para a enquete
    notes.push({
      role: "system",
      content:
        `Ainda NÃO foi feito: ${pending.map((p) => p.summary).join("; ")}. ` +
        (kind === "more"
          ? "Ela começou com sim, mas disse mais coisa junto. Se ela mudou algum detalhe, chame a ferramenta de novo com os dados novos (vira um novo pedido); se não, faça o resto que ela pediu e diga em poucas palavras que falta só um sim curto (ou tocar em Sim na enquete) para isso sair."
          : "A resposta dela não veio em texto. O pedido continua esperando: peça em poucas palavras para ela tocar em Sim na enquete ou digitar sim.") +
        " O sistema repete a pergunta do sim no fim da sua resposta; não faça outra pergunta de sim ou não junto.",
    });
    // a pergunta volta ao pé da resposta (enquete nova): o próximo "sim" responde a ela, não a outra pergunta do modelo
    const latest = pending.reduce((a, b) => (b.id > a.id ? b : a));
    ctx.room.confirmations.push(latest.summary);
    ctx.room.keptTool = latest.tool;
    return notes;
  }
  if (!answer) {
    // não respondeu sim nem não: o pedido cai (um "sim" solto mais tarde não pode disparar uma ação esquecida)
    await query("UPDATE pending_actions SET status = 'expired', resolved_at = now() WHERE id = ANY($1) AND status = 'pending'", [pending.map((p) => p.id)]);
    notes.push({
      role: "system",
      content:
        `A pessoa não respondeu sim nem não para: ${pending.map((p) => p.summary).join("; ")}. Nada disso foi feito. ` +
        "Se ela ainda quer (ou pediu mudança), chame a ferramenta de novo com os dados certos: vira um novo pedido de confirmação.",
    });
    return notes;
  }
  let run = pending;
  if (answer === "yes" && pending.length > 1) {
    // um "sim" responde só à última pergunta: o resto cai e o CTO pergunta de novo, uma por vez
    const latest = pending.reduce((a, b) => (b.id > a.id ? b : a));
    const rest = pending.filter((p) => p !== latest);
    await query("UPDATE pending_actions SET status = 'expired', resolved_at = now() WHERE id = ANY($1) AND status = 'pending'", [rest.map((p) => p.id)]);
    notes.push({
      role: "system",
      content: `Não executei: ${rest.map((p) => p.summary).join("; ")}. Se ela ainda quiser, pergunte de novo, uma por vez.`,
    });
    run = [latest];
  }
  for (const p of run) {
    // fecha antes de rodar: uma nova tentativa da fila não executa a mesma ação duas vezes
    const claimed = await query("UPDATE pending_actions SET status = $2, resolved_at = now() WHERE id = $1 AND status = 'pending'", [
      p.id,
      answer === "yes" ? "approved" : "declined",
    ]);
    if (!claimed.rowCount) continue;
    if (answer === "no") {
      notes.push({ role: "system", content: `A pessoa NÃO confirmou: ${p.summary}. Nada foi feito; confirme isso a ela em poucas palavras.` });
      continue;
    }
    const tool = toolByName(p.tool);
    const step = await ctx.tracer.step({ agent: p.agent, type: "tool", name: p.tool, input: { ...p.args, confirmado_pela_pessoa: true } });
    if (!tool || (isOwnerOnly(tool) && !isOwner(ctx.user.phone))) {
      await step.fail("Ferramenta indisponível para esta pessoa");
      notes.push({ role: "system", content: `A pessoa confirmou "${p.summary}", mas a ferramenta não está disponível. Diga que não foi feito.` });
      continue;
    }
    try {
      const out: any = await asPerson(personOf(ctx.user), () => tool.run(p.args, { ...ctx, agent: p.agent, approvedAction: true, toolCall: { name: p.tool, args: p.args }, parentStepId: step.id }));
      if (out && typeof out === "object") delete out._usage;
      await step.ok(out);
      const failed = out && typeof out === "object" && ("error" in out || out.ok === false);
      if (!failed) ctx.room.done.add(p.tool);
      notes.push({
        role: "system",
        content:
          `A pessoa confirmou e o sistema JÁ executou: ${p.summary}. Resultado: ${JSON.stringify(out ?? { ok: true }).slice(0, 2000)}. ` +
          "Conte o resultado a ela em poucas palavras. Não chame essa ferramenta de novo.",
      });
    } catch (err) {
      await step.fail(err);
      notes.push({ role: "system", content: `A pessoa confirmou "${p.summary}", mas deu erro ao executar: ${err instanceof Error ? err.message : String(err)}. Diga que não foi feito.` });
    }
  }
  return notes;
}
