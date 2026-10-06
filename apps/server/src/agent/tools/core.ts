import { many, query } from "../../db/pool.js";
import { formatLocal, isoLocal } from "../../time.js";
import { defineTool, obj } from "./types.js";

export const reactToMessage = defineTool<{ emoji: string; message_id?: string }>({
  name: "react_to_message",
  description:
    "Reage com um emoji a uma mensagem da pessoa no WhatsApp, como um humano faria (👍 para confirmações, ❤️, 😂, 🙏, 🔥, ✅...). " +
    "Use com naturalidade, não em toda mensagem. Sem message_id reage à última mensagem recebida.",
  parameters: obj(
    {
      emoji: { type: "string", description: "Um único emoji" },
      message_id: { type: "string", description: "id da mensagem (opcional)" },
    },
    ["emoji"],
  ),
  async run(args, ctx) {
    const id = args.message_id ?? ctx.lastInboundId;
    if (!id) return { ok: false, error: "Nenhuma mensagem para reagir" };
    await ctx.channel.react(ctx.conversation.remote_jid, id, args.emoji);
    ctx.outbox.reactions.push({ messageId: id, emoji: args.emoji });
    await query("UPDATE messages SET meta = meta || jsonb_build_object('reaction', $3::text) WHERE conversation_id = $1 AND external_id = $2", [
      ctx.conversation.id,
      id,
      args.emoji,
    ]);
    return { ok: true };
  },
});

export const saveMemory = defineTool<{ content: string; tags?: string[] }>({
  name: "save_memory",
  description:
    "Guarda um fato duradouro sobre a pessoa (preferências, nomes de família, cidade, rotina, gostos) para lembrar em conversas futuras. " +
    "Não guarde coisas passageiras.",
  parameters: obj(
    {
      content: { type: "string", description: "O fato, em uma frase. Ex.: 'Prefere cinema legendado e mora em Campinas'" },
      tags: { type: "array", items: { type: "string" } },
    },
    ["content"],
  ),
  async run(args, ctx) {
    await query("INSERT INTO memories (user_id, content, tags) VALUES ($1, $2, $3)", [ctx.user.id, args.content, args.tags ?? []]);
    return { ok: true };
  },
});

export const searchMemories = defineTool<{ query: string }>({
  name: "search_memories",
  description: "Busca nas memórias guardadas sobre a pessoa.",
  parameters: obj({ query: { type: "string" } }, ["query"]),
  async run(args, ctx) {
    const rows = await many(
      `SELECT id, content, tags, created_at FROM memories
        WHERE user_id = $1 AND (search @@ websearch_to_tsquery('portuguese', $2) OR content ILIKE '%' || $2 || '%')
        ORDER BY created_at DESC LIMIT 15`,
      [ctx.user.id, args.query],
    );
    return { memories: rows };
  },
});

export const forgetMemory = defineTool<{ id: string }>({
  name: "forget_memory",
  description: "Apaga uma memória (quando a pessoa pede para esquecer ou o fato mudou).",
  parameters: obj({ id: { type: "string" } }, ["id"]),
  async run(args, ctx) {
    const r = await query("DELETE FROM memories WHERE id = $1 AND user_id = $2", [args.id, ctx.user.id]);
    return { ok: (r.rowCount ?? 0) > 0 };
  },
});

export const getDatetime = defineTool<Record<string, never>>({
  name: "get_datetime",
  description: "Data e hora atuais no fuso da pessoa.",
  parameters: obj({}),
  async run(_args, ctx) {
    const now = new Date();
    return { local: formatLocal(now, ctx.timezone), iso_local: isoLocal(now, ctx.timezone), timezone: ctx.timezone };
  },
});

export const attachImage = defineTool<{ url: string; caption?: string }>({
  name: "attach_image",
  description:
    "Prepara uma imagem da internet (URL direta de imagem) para enviar no WhatsApp. Retorna um media_id; " +
    "o CTO posiciona na resposta com [[media:ID]].",
  parameters: obj({ url: { type: "string" }, caption: { type: "string" } }, ["url"]),
  async run(args, ctx) {
    const id = ctx.outbox.addMedia({ url: args.url, caption: args.caption });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta final onde a imagem deve aparecer.` };
  },
});
