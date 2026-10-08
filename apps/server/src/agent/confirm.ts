import { many, query } from "../db/pool.js";
import type { ChatMessage } from "../llm/types.js";
import { isOwner } from "../ingest.js";
import { asPerson } from "../integrations/person.js";
import { isOwnerOnly, personOf } from "./runner.js";
import { CLIENT_AGENT_TOOLS, CTO_TOOLS, SPECIALISTS } from "./team.js";
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

const YES = /^(sim|s|ss|pode|pode sim|confirm[oa]?|confirmad[oa]|isso|isso mesmo|ok+|okay|beleza|blz|fechado|claro|com certeza|positivo|bora|vai|faz|manda|envia|apaga|dispara|gera|convida|pode (mandar|enviar|apagar|fazer|disparar|gerar|convidar|seguir|ir)|sim pode|sim por favor|por favor|perfeito|certo|ta|ta bom|👍|✅|👌)( (sim|pode|por favor|obrigad[oa]|valeu|isso))*$/u;
const NO = /^(nao|n|nem|cancela|cancelar|deixa|deixa pra la|esquece|para|pare|melhor nao|nao precisa|nao pode|negativo|👎|❌)\b/u;

/** "sim", "pode mandar", "👍": a pessoa liberou. "não", "cancela": recusou. Qualquer outra coisa: ainda não decidiu. */
export function confirmationAnswer(texts: string[]): "yes" | "no" | null {
  const said = texts.map(strip).filter(Boolean);
  if (!said.length) return null;
  const last = said.at(-1)!;
  if (NO.test(last)) return "no";
  if (last.length <= 40 && YES.test(last)) return "yes";
  return null;
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
  registry ??= new Map([...CTO_TOOLS, ...SPECIALISTS.flatMap((s) => s.tools), ...Object.values(CLIENT_AGENT_TOOLS)].map((t) => [t.name, t]));
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
  for (const p of pending) {
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
