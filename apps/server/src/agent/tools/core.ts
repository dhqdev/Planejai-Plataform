import { safeFetch } from "../../net.js";
import { cacheGet } from "../../shortmem.js";
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
      message_id: { type: "string", description: "msg_id da mensagem (opcional; padrão: a última)" },
    },
    ["emoji"],
  ),
  async run(args, ctx) {
    let id = args.message_id ?? ctx.lastInboundId;
    if (args.message_id && /^\d+$/.test(String(args.message_id))) {
      const rows = await many("SELECT external_id FROM messages WHERE id = $1 AND conversation_id = $2", [Number(args.message_id), ctx.conversation.id]);
      id = rows[0]?.external_id ?? ctx.lastInboundId;
    }
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
    // baixa aqui (só internet pública) em vez de deixar o canal buscar a URL sozinho
    const res = await safeFetch(args.url, { signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0 (compatible; PlanejaiBot/1.0)" } });
    if (!res.ok) throw new Error(`Imagem não abriu (${res.status})`);
    const mimetype = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!mimetype.startsWith("image/")) throw new Error(`Isso não é uma imagem (${mimetype || "tipo desconhecido"})`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 8 * 1024 * 1024) throw new Error("Imagem grande demais (máx. 8 MB)");
    const id = ctx.outbox.addMedia({ base64: data.toString("base64"), mimetype, caption: args.caption });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta final onde a imagem deve aparecer.` };
  },
});

export const readDocument = defineTool<{ message_id: number | string; offset?: number; query?: string }>({
  name: "read_document",
  description:
    "Lê o texto de um documento que a pessoa mandou (PDF, Word, planilha, texto). Use offset para continuar lendo, " +
    "ou query para trazer só os trechos que falam de algo (mais barato).",
  parameters: obj({ message_id: { type: "number" }, offset: { type: "number" }, query: { type: "string" } }, ["message_id"]),
  async run(args, ctx) {
    let text = await cacheGet<string>(`doc:${ctx.conversation.id}:${Number(args.message_id)}`);
    if (!text) {
      const rows = await many(`SELECT meta FROM messages WHERE id = $1 AND conversation_id = $2`, [Number(args.message_id), ctx.conversation.id]);
      text = rows[0]?.meta?.doc_text ?? null;
    }
    if (!text) return { error: "Documento não encontrado (documentos ficam disponíveis por 24h)." };
    if (args.query) {
      const terms = args.query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      const paras = text.split(/\n+/);
      const hits = paras.filter((p) => terms.some((t) => p.toLowerCase().includes(t)));
      return { matches: hits.slice(0, 40).join("\n").slice(0, 6000), total_matches: hits.length };
    }
    const offset = Math.max(0, args.offset ?? 0);
    const chunk = text.slice(offset, offset + 6000);
    return { text: chunk, offset, next_offset: offset + 6000 < text.length ? offset + 6000 : null, total_chars: text.length };
  },
});
