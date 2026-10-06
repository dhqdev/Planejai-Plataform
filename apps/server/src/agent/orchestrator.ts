import { getChannel } from "../channels/index.js";
import type { Channel } from "../channels/types.js";
import { many, one, pool, query } from "../db/pool.js";
import { INTEGRATIONS, isConnected } from "../integrations/registry.js";
import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatMessage } from "../llm/types.js";
import { getSettings } from "../settings.js";
import { delegationTool, TeamRoom } from "./collab.js";
import { ctoSystemPrompt } from "./prompts.js";
import { availableTools, runToolLoop } from "./runner.js";
import { CTO_TOOLS, SPECIALISTS } from "./team.js";
import { Tracer } from "./trace.js";
import { Outbox, type ConversationRow, type ToolContext, type UserRow } from "./tools/types.js";

const HISTORY_LIMIT = 30;

/** Formata texto de LLM para WhatsApp (markdown -> estilo WhatsApp) */
export function toWhatsApp(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, label, url) => (label === url ? url : `${label}: ${url}`))
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

export type Bubble = { type: "text"; text: string } | { type: "media"; id: string };

/** Divide a resposta do CTO em balões: "---" separa mensagens e [[media:ID]] posiciona imagens. */
export function splitBubbles(text: string): Bubble[] {
  const out: Bubble[] = [];
  for (const chunk of text.split(/^\s*---\s*$/m)) {
    const parts = chunk.split(/\[\[media:([\w-]+)\]\]/);
    parts.forEach((p, i) => {
      if (i % 2 === 1) out.push({ type: "media", id: p });
      else if (p.trim()) out.push({ type: "text", text: toWhatsApp(p) });
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeMessage(m: any): string {
  const parts: string[] = [];
  const meta = m.meta ?? {};
  if (meta.kind === "audio") parts.push(`[áudio] ${meta.transcript ?? "(não consegui transcrever)"}`);
  if (meta.kind === "image") parts.push(`[foto] ${meta.image_description ?? ""}`);
  if (meta.kind === "document") parts.push(`[documento ${meta.fileName ?? ""}]`);
  if (meta.kind === "sticker") parts.push("[figurinha]");
  if (meta.kind === "video") parts.push("[vídeo]");
  if (meta.quoted?.text) parts.push(`(respondendo a: "${String(meta.quoted.text).slice(0, 200)}")`);
  if (m.content) parts.push(m.content);
  return parts.join(" ").trim();
}

/** Transcreve áudios e descreve imagens das mensagens pendentes (uma vez, guardando em meta). */
async function preprocessMedia(pending: any[], channel: Channel, tracer: Tracer, remoteJid: string) {
  for (const m of pending) {
    const kind = m.meta?.kind;
    if (!m.media || (kind !== "audio" && kind !== "image")) continue;
    if (m.meta.transcript || m.meta.image_description) continue;
    const step = await tracer.step({ agent: "cto", type: "tool", name: kind === "audio" ? "transcrever_audio" : "descrever_imagem", input: { message: m.id } });
    try {
      const media = await channel.downloadMedia({ externalId: m.external_id, remoteJid, media: m.media } as any);
      if (!media) throw new Error("Não foi possível baixar a mídia");
      if (kind === "audio") {
        const format = media.mimetype.includes("mpeg") ? "mp3" : media.mimetype.includes("wav") ? "wav" : media.mimetype.includes("mp4") ? "m4a" : "ogg";
        const r = await chatCompletion(await resolveModel("transcription"), {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Transcreva este áudio em português exatamente como falado. Responda só com a transcrição." },
                { type: "input_audio", input_audio: { data: media.base64, format } },
              ],
            },
          ],
        });
        m.meta.transcript = r.message.content?.trim();
        await step.ok({ transcript: m.meta.transcript }, r);
      } else {
        const r = await chatCompletion(await resolveModel("vision"), {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Descreva esta imagem em português de forma objetiva e completa para um assistente que não pode vê-la. " +
                    "Transcreva todo texto visível (valores, datas, nomes, códigos). Se for comprovante ou nota fiscal, extraia estabelecimento, valor total, data e itens.",
                },
                { type: "image_url", image_url: { url: `data:${media.mimetype};base64,${media.base64}` } },
              ],
            },
          ],
        });
        m.meta.image_description = r.message.content?.trim();
        await step.ok({ description: m.meta.image_description }, r);
      }
      // base64 só serve até aqui; não guarda mídia pesada no banco
      const { base64: _drop, ...mediaMeta } = m.media;
      await query("UPDATE messages SET meta = $2, media = $3 WHERE id = $1", [m.id, m.meta, mediaMeta]);
    } catch (err) {
      await step.fail(err);
    }
  }
}

async function loadMemories(userId: string, text: string) {
  const recent = await many("SELECT id, content FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 12", [userId]);
  const related = text
    ? await many(
        `SELECT id, content FROM memories WHERE user_id = $1 AND search @@ plainto_tsquery('portuguese', $2)
          ORDER BY ts_rank(search, plainto_tsquery('portuguese', $2)) DESC LIMIT 6`,
        [userId, text.slice(0, 500)],
      )
    : [];
  const seen = new Set<string>();
  return [...related, ...recent].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

export interface ProcessResult {
  executionId: string | null;
  bubbles: Bubble[];
  outbox: Outbox;
}

/**
 * Processa uma conversa: junta as mensagens pendentes, prepara mídia, roda o CTO
 * (que delega aos especialistas) e entrega a resposta no canal.
 */
export async function processConversation(
  conversationId: string,
  opts: { trigger: "message" | "reminder" | "playground"; event?: string; channel?: Channel } = { trigger: "message" },
): Promise<ProcessResult> {
  // Um processamento por conversa por vez
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [conversationId]);
    return await processLocked(conversationId, opts);
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [conversationId]).catch(() => {});
    lock.release();
  }
}

async function processLocked(
  conversationId: string,
  opts: { trigger: "message" | "reminder" | "playground"; event?: string; channel?: Channel },
): Promise<ProcessResult> {
  const conversation = await one<ConversationRow>("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  if (!conversation) throw new Error(`Conversa ${conversationId} não existe`);
  const user = await one<UserRow>("SELECT * FROM users WHERE id = $1", [conversation.user_id]);
  if (!user || user.status !== "active") return { executionId: null, bubbles: [], outbox: new Outbox() };

  if (opts.event) {
    await query("INSERT INTO messages (conversation_id, role, content, processed) VALUES ($1, 'event', $2, false)", [conversationId, opts.event]);
  }
  const pending = await many("SELECT * FROM messages WHERE conversation_id = $1 AND processed = false ORDER BY id", [conversationId]);
  if (!pending.length) return { executionId: null, bubbles: [], outbox: new Outbox() };

  const channel = opts.channel ?? getChannel(conversation.channel);
  const settings = await getSettings();
  const timezone = user.timezone ?? settings.timezone;
  const lastInbound = [...pending].reverse().find((m) => m.role === "user" && m.external_id);
  const tracer = await Tracer.start({
    trigger: opts.trigger,
    userId: user.id,
    conversationId,
    input: pending.map((m) => (m.role === "event" ? `[evento] ${m.content}` : m.content || `[${m.meta?.kind ?? "mídia"}]`)).join("\n"),
  });
  const outbox = new Outbox();

  try {
    if (lastInbound) {
      channel.markRead(conversation.remote_jid, lastInbound.external_id).catch(() => {});
      channel.setTyping(conversation.remote_jid, 4000).catch(() => {});
    }
    await preprocessMedia(pending, channel, tracer, conversation.remote_jid);

    const history = (
      await many(
        `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id DESC LIMIT $3) h ORDER BY id`,
        [conversationId, conversation.summary_until, HISTORY_LIMIT],
      )
    ).map((m) => {
      const pendingIds = new Set(pending.map((p) => p.id));
      return { ...m, isNew: pendingIds.has(m.id) };
    });

    const messages: ChatMessage[] = [];
    for (const m of history) {
      if (m.role === "assistant") messages.push({ role: "assistant", content: m.content });
      else if (m.role === "event") messages.push({ role: "user", content: `[evento do sistema] ${m.content}` });
      else {
        const prefix = m.isNew && m.external_id ? `(msg id ${m.external_id}) ` : "";
        const reaction = m.meta?.reaction ? ` [você reagiu ${m.meta.reaction}]` : "";
        messages.push({ role: "user", content: `${prefix}${describeMessage(m)}${reaction}` });
      }
    }

    const lastText = pending.map((m) => describeMessage(m)).join(" ");
    const disconnected = [];
    for (const i of INTEGRATIONS) if (!(await isConnected(i.id))) disconnected.push(i.name);
    const system = ctoSystemPrompt({
      settings,
      user,
      timezone,
      memories: await loadMemories(user.id, lastText),
      summary: conversation.summary,
      specialists: SPECIALISTS,
      disconnected,
    });

    const ctx: ToolContext = {
      user,
      conversation,
      channel,
      tracer,
      outbox,
      timezone,
      lastInboundId: lastInbound?.external_id,
      agent: "cto",
      room: new TeamRoom(),
      callChain: ["cto"],
    };
    const tools = [...(await availableTools(CTO_TOOLS)), ...SPECIALISTS.map(delegationTool)];
    const result = await runToolLoop({ agent: "cto", task: "agent:cto", ctx, tools, messages: [{ role: "system", content: system }, ...messages], maxSteps: 12 });

    const silent = !result.text || /^\[\[sil[eê]ncio\]\]$/i.test(result.text.trim());
    const bubbles = silent ? [] : splitBubbles(result.text);
    // mídia que o CTO não posicionou vai depois do primeiro balão
    const placed = new Set(bubbles.filter((b) => b.type === "media").map((b) => (b as { id: string }).id));
    const unplaced = [...outbox.media.keys()].filter((id) => !placed.has(id)).map((id) => ({ type: "media", id }) as Bubble);
    if (unplaced.length) bubbles.splice(Math.min(1, bubbles.length), 0, ...unplaced);

    await deliver(bubbles, { channel, conversation, outbox, tracer });
    await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
    await query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    await tracer.finish(silent ? "[[silencio]]" : result.text);
    return { executionId: tracer.executionId, bubbles, outbox };
  } catch (err) {
    await tracer.error(err);
    // Não deixa a pessoa no vácuo
    await channel.sendText(conversation.remote_jid, "Tive um problema técnico aqui e não consegui terminar. Pode tentar de novo em instantes?").catch(() => {});
    await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
    throw err;
  }
}

async function deliver(bubbles: Bubble[], o: { channel: Channel; conversation: ConversationRow; outbox: Outbox; tracer: Tracer }) {
  for (const [i, b] of bubbles.entries()) {
    const step = await o.tracer.step({ agent: "cto", type: "channel", name: b.type === "text" ? "enviar_texto" : "enviar_imagem", input: b.type === "text" ? { text: b.text } : { media: b.id } });
    try {
      if (b.type === "text") {
        if (i > 0) {
          const ms = Math.min(2500, 400 + b.text.length * 15);
          o.channel.setTyping(o.conversation.remote_jid, ms).catch(() => {});
          await sleep(o.channel.id === "playground" ? 0 : ms);
        }
        const r = await o.channel.sendText(o.conversation.remote_jid, b.text);
        await query("INSERT INTO messages (conversation_id, role, content, external_id, processed) VALUES ($1, 'assistant', $2, $3, true)", [
          o.conversation.id,
          b.text,
          r.id ?? null,
        ]);
        await step.ok(r);
      } else {
        const img = o.outbox.media.get(b.id);
        if (!img) throw new Error(`media ${b.id} não existe`);
        const r = await o.channel.sendImage(o.conversation.remote_jid, img);
        await query(
          "INSERT INTO messages (conversation_id, role, content, external_id, media, processed) VALUES ($1, 'assistant', $2, $3, $4, true)",
          [o.conversation.id, img.caption ?? "[imagem]", r.id ?? null, { url: img.url ?? null, mimetype: img.mimetype ?? null }],
        );
        await step.ok(r);
      }
    } catch (err) {
      await step.fail(err);
    }
  }
}

/** Compacta conversas longas: resume mensagens antigas e avança summary_until. */
export async function summarizeConversation(conversationId: string) {
  const conv = await one<ConversationRow>("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  if (!conv) return;
  const rows = await many("SELECT id, role, content, meta FROM messages WHERE conversation_id = $1 AND id > $2 ORDER BY id", [conversationId, conv.summary_until]);
  if (rows.length < HISTORY_LIMIT + 20) return;
  const old = rows.slice(0, rows.length - HISTORY_LIMIT);
  const transcript = old.map((m) => `${m.role === "assistant" ? "Assistente" : m.role === "event" ? "Evento" : "Pessoa"}: ${describeMessage(m)}`).join("\n");
  const r = await chatCompletion(await resolveModel("summary"), {
    messages: [
      {
        role: "system",
        content:
          "Atualize o resumo da conversa entre uma pessoa e seu assistente. Mantenha fatos, decisões, pendências, compromissos e preferências. " +
          "Máximo 15 linhas, em português, em tópicos curtos.",
      },
      { role: "user", content: `Resumo atual:\n${conv.summary ?? "(vazio)"}\n\nNovas mensagens:\n${transcript.slice(0, 60_000)}` },
    ],
  });
  if (r.message.content) {
    await query("UPDATE conversations SET summary = $2, summary_until = $3 WHERE id = $1", [conversationId, r.message.content.trim(), old.at(-1)!.id]);
  }
}
