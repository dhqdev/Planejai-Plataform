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
import { clientAgents, CTO_TOOLS, SPECIALISTS } from "./team.js";
import { finishBrowser } from "./tools/research.js";
import { Guard, GuardTimeout, redactSecrets } from "./guard.js";
import { isOwner } from "../ingest.js";
import { describeMessage, preprocessMedia } from "./media.js";
import { Progress } from "./progress.js";
import { pickReaction } from "./reaction.js";
import { Tracer } from "./trace.js";
import { allShort, pushShort, recentShort, redisAlive, type ShortEntry } from "../shortmem.js";
import { config } from "../config.js";
import { Outbox, type ConversationRow, type ToolContext, type UserRow } from "./tools/types.js";

/** Mensagens recentes que entram no contexto do CTO (o resto vira resumo): menos token por resposta. */
const HISTORY_LIMIT = 16;
/** Mensagens que disparam a compactação em resumo */
const SUMMARY_TRIGGER = 40;
/** Entradas na memória curta que disparam o resumo (a lista guarda no máximo 60) */
const REDIS_SUMMARY_TRIGGER = 36;
/** Numa enxurrada de mensagens, só as últimas entram numa resposta */
const MAX_BATCH = 20;

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

async function loadMemories(userId: string, text: string) {
  const recent = await many("SELECT id, content FROM memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8", [userId]);
  const related = text
    ? await many(
        `SELECT id, content FROM memories WHERE user_id = $1 AND search @@ plainto_tsquery('portuguese', $2)
          ORDER BY ts_rank(search, plainto_tsquery('portuguese', $2)) DESC LIMIT 5`,
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
  let pending = await many("SELECT * FROM messages WHERE conversation_id = $1 AND processed = false ORDER BY id", [conversationId]);
  if (!pending.length) return { executionId: null, bubbles: [], outbox: new Outbox() };

  const channel = opts.channel ?? getChannel(conversation.channel);
  const settings = await getSettings();

  // Enxurrada: as mais antigas ficam registradas, mas só as últimas MAX_BATCH vão para o agente
  if (pending.length > MAX_BATCH) {
    const dropped = pending.slice(0, pending.length - MAX_BATCH);
    await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [dropped.map((m) => m.id)]);
    pending = pending.slice(-MAX_BATCH);
  }

  // Limites de uso por pessoa (o dono não tem limite; lembretes que ela mesma agendou sempre saem)
  if (opts.trigger === "message" && !isOwner(user.phone)) {
    const hit = await usageLimitHit(user.id, settings);
    if (hit) {
      await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
      const tracer = await Tracer.start({ trigger: opts.trigger, userId: user.id, conversationId, input: pending.map((m) => m.content).join("\n") });
      const step = await tracer.step({ agent: "cto", type: "info", name: "trava: limite diário", input: hit });
      await step.ok({ blocked: true });
      // avisa uma vez por dia; depois fica em silêncio até liberar
      const notified = await one(
        `UPDATE users SET profile = profile || jsonb_build_object('limit_notice_at', now()) WHERE id = $1
           AND COALESCE((profile->>'limit_notice_at')::timestamptz, 'epoch') < now() - interval '24 hours' RETURNING id`,
        [user.id],
      );
      if (notified) {
        await channel
          .sendText(conversation.remote_jid, "Você chegou no limite de uso de hoje 🙏 Amanhã eu volto a responder normalmente.")
          .catch(() => {});
      }
      await tracer.finish(notified ? "[limite diário: avisado]" : "[limite diário: silêncio]");
      return { executionId: tracer.executionId, bubbles: [], outbox: new Outbox() };
    }
  }
  const timezone = user.timezone ?? settings.timezone;
  const lastInbound = [...pending].reverse().find((m) => m.role === "user" && m.external_id);
  const tracer = await Tracer.start({
    trigger: opts.trigger,
    userId: user.id,
    conversationId,
    input: pending.map((m) => (m.role === "event" ? `[evento] ${m.content}` : m.content || `[${m.meta?.kind ?? "mídia"}]`)).join("\n"),
  });
  const outbox = new Outbox();
  const guard = Guard.fromSettings(settings);
  const progress = new Progress({ channel, jid: conversation.remote_jid, tracer });

  try {
    if (lastInbound) channel.markRead(conversation.remote_jid, lastInbound.external_id).catch(() => {});
    // Primeira coisa que a pessoa vê: uma reação com o emoji do tema, na hora e sem IA
    let autoReaction: string | null = null;
    if (lastInbound && opts.trigger !== "reminder") {
      const said = pending.filter((m) => m.role === "user").map((m) => m.content ?? "").join(" ");
      autoReaction = pickReaction(said, lastInbound.meta?.kind);
      channel.react(conversation.remote_jid, lastInbound.external_id, autoReaction).catch(() => {});
      outbox.reactions.push({ messageId: lastInbound.external_id, emoji: autoReaction });
    }
    if (opts.trigger !== "reminder") progress.start();
    await preprocessMedia(pending, channel, tracer, conversation.remote_jid);

    // Contexto: memória curta no Redis (já interpretada); sem Redis, as mensagens das últimas horas no Postgres
    const pendingIds = new Set(pending.map((p) => p.id));
    const fresh: ShortEntry[] = pending.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.role === "event" ? m.content : limitText(describeMessage(m), m, settings.maxMessageChars),
      ts: new Date(m.created_at).getTime(),
      ext: m.external_id,
    }));
    let past = await recentShort(conversationId, HISTORY_LIMIT);
    if (!past) {
      past = (
        await many(
          `SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 AND id > $2 AND processed = true
              AND created_at > now() - make_interval(hours => $4) ORDER BY id DESC LIMIT $3) h ORDER BY id`,
          [conversationId, conversation.summary_until, HISTORY_LIMIT, config.MESSAGE_RETENTION_HOURS],
        )
      ).map((m) => ({ id: m.id, role: m.role, text: m.role === "event" ? m.content : describeMessage(m), ts: new Date(m.created_at).getTime(), ext: m.external_id }));
    }
    const summarizedTs = Number((conversation as any).summary_ts ?? 0);
    const history = [...past.filter((e) => !pendingIds.has(e.id) && e.ts > summarizedTs), ...fresh];

    const messages: ChatMessage[] = [];
    for (const m of history) {
      if (m.role === "assistant") messages.push({ role: "assistant", content: m.text });
      else if (m.role === "event") messages.push({ role: "user", content: `[evento do sistema] ${m.text}` });
      else {
        const isNew = pendingIds.has(m.id);
        const prefix = isNew ? `[msg_id=${m.id}] ` : "";
        messages.push({ role: "user", content: `${prefix}${m.text}` });
      }
    }
    await pushShort(conversationId, fresh);

    // Só entra no time quem tem pelo menos uma ferramenta utilizável (menos token e nada de delegação inútil)
    const team = [];
    for (const s of [...SPECIALISTS, ...(await clientAgents(user.id))]) if ((await availableTools(s.tools)).length) team.push(s);
    const lastText = fresh.map((e) => e.text).join(" ").slice(0, 500);
    const disconnected = [];
    for (const i of INTEGRATIONS) if (!(await isConnected(i.id))) disconnected.push(i.name);
    const system = ctoSystemPrompt({
      settings,
      user,
      timezone,
      memories: await loadMemories(user.id, lastText),
      summary: conversation.summary,
      specialists: team,
      disconnected,
      autoReaction,
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
      guard,
      inboundImages: pending.map((m) => m.inboundImage).filter(Boolean),
      // lembrete agendado não ganha "já vou ver": a pessoa não perguntou nada agora
      progress: opts.trigger === "reminder" ? undefined : progress,
    };
    const tools = [...(await availableTools(CTO_TOOLS)), ...team.map(delegationTool)];
    let result;
    try {
      result = await runToolLoop({ agent: "cto", task: "agent:cto", ctx, tools, messages: [{ role: "system", content: system }, ...messages], maxSteps: 10 });
    } finally {
      // navegador esquecido aberto: fecha e, se a pessoa pediu a gravação, manda junto
      if (ctx.room.browser) await finishBrowser(ctx).catch(() => {});
    }

    if (result.timedOut || (guard.expired && !result.text)) {
      const step = await tracer.step({ agent: "cto", type: "info", name: "trava: tempo máximo", input: { minutos: guard.minutes, acoes: guard.toolCalls } });
      await step.ok({ stopped: true });
      result.text =
        `Isso passou do meu limite de ${fmtMinutes(guard.minutes)} e parei aqui pra não te deixar esperando. ` +
        "Quer que eu tente de um jeito mais simples ou dividido em partes?";
    }
    const silent = !result.text || /^\[\[sil[eê]ncio\]\]$/i.test(result.text.trim());
    const bubbles = silent ? [] : splitBubbles(result.text);
    // mídia que o CTO não posicionou vai depois do primeiro balão
    const placed = new Set(bubbles.filter((b) => b.type === "media").map((b) => (b as { id: string }).id));
    const unplaced = [...outbox.media.keys()].filter((id) => !placed.has(id)).map((id) => ({ type: "media", id }) as Bubble);
    if (unplaced.length) bubbles.splice(Math.min(1, bubbles.length), 0, ...unplaced);

    progress.stop();
    const keepInDb = !(await redisAlive());
    await deliver(bubbles, { channel, conversation, outbox, tracer, keepInDb });
    // A conversa já está no WhatsApp e na memória curta (Redis): com o Redis no ar, a mensagem sai do banco
    if (keepInDb) await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
    else await query("DELETE FROM messages WHERE id = ANY($1)", [pending.map((m) => m.id)]);
    await query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    const sentTexts = [...progress.sent, ...bubbles.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text)];
    if (sentTexts.length) await pushShort(conversationId, [{ id: Date.now(), role: "assistant", text: sentTexts.join("\n"), ts: Date.now() }]);
    await tracer.finish(silent ? "[[silencio]]" : result.text);
    return { executionId: tracer.executionId, bubbles, outbox };
  } catch (err) {
    await tracer.error(err);
    if (err instanceof GuardTimeout || guard.expired) {
      await channel
        .sendText(conversation.remote_jid, `Isso passou do meu limite de ${fmtMinutes(guard.minutes)} e parei aqui. Quer que eu tente de um jeito mais simples?`)
        .catch(() => {});
      await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
      return { executionId: tracer.executionId, bubbles: [], outbox };
    }
    // Não deixa a pessoa no vácuo
    await channel.sendText(conversation.remote_jid, "Tive um problema técnico aqui e não consegui terminar. Pode tentar de novo em instantes?").catch(() => {});
    await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
    throw err;
  } finally {
    progress.stop();
    guard.dispose();
  }
}

function fmtMinutes(min: number) {
  return min >= 1 ? `${Number(min.toFixed(1)).toString().replace(".", ",")} min` : `${Math.round(min * 60)} s`;
}

/** Texto digitado muito longo é cortado (documentos têm limite próprio e são lidos sob demanda). */
function limitText(text: string, m: { meta?: any }, max: number) {
  const kind = m.meta?.kind;
  if (kind && kind !== "text") return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[mensagem cortada: passou de ${max} caracteres]`;
}

/** Algum limite de 24h da pessoa estourou? Devolve qual, para o log. */
async function usageLimitHit(userId: string, s: { dailyMessageLimit: number; dailyCostLimitUsd: number }) {
  if (s.dailyMessageLimit > 0) {
    const r = await one("SELECT COALESCE(SUM(messages), 0)::int AS n FROM usage_daily WHERE user_id = $1 AND day >= current_date - 1", [userId]);
    if (r.n > s.dailyMessageLimit) return { limite: "mensagens em 24h", usado: r.n, maximo: s.dailyMessageLimit };
  }
  if (s.dailyCostLimitUsd > 0) {
    const r = await one("SELECT COALESCE(SUM(cost_usd), 0)::float AS c FROM executions WHERE user_id = $1 AND started_at > now() - interval '24 hours'", [userId]);
    if (r.c >= s.dailyCostLimitUsd) return { limite: "custo de IA em 24h (US$)", usado: Number(r.c.toFixed(4)), maximo: s.dailyCostLimitUsd };
  }
  return null;
}

async function deliver(bubbles: Bubble[], o: { channel: Channel; conversation: ConversationRow; outbox: Outbox; tracer: Tracer; keepInDb: boolean }) {
  for (const [i, b] of bubbles.entries()) {
    const step = await o.tracer.step({ agent: "cto", type: "channel", name: b.type === "text" ? "enviar_texto" : "enviar_imagem", input: b.type === "text" ? { text: b.text } : { media: b.id } });
    try {
      if (b.type === "text") {
        if (i > 0) {
          const ms = Math.min(2500, 400 + b.text.length * 15);
          o.channel.setTyping(o.conversation.remote_jid, ms).catch(() => {});
          await sleep(o.channel.id === "playground" ? 0 : ms);
        }
        b.text = redactSecrets(b.text);
        const r = await o.channel.sendText(o.conversation.remote_jid, b.text);
        if (o.keepInDb) {
          await query("INSERT INTO messages (conversation_id, role, content, external_id, processed) VALUES ($1, 'assistant', $2, $3, true)", [
            o.conversation.id,
            b.text,
            r.id ?? null,
          ]);
        }
        await step.ok(r);
      } else {
        const img = o.outbox.media.get(b.id);
        if (!img) throw new Error(`media ${b.id} não existe`);
        const r = await o.channel.sendImage(o.conversation.remote_jid, img);
        if (o.keepInDb) await query(
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

/**
 * Compacta a conversa: resume mensagens antigas e avança summary_until.
 * Sem upTo, resume quando passa de SUMMARY_TRIGGER (mantendo as recentes); com upTo, resume tudo até esse id
 * (usado antes de apagar mensagens com mais de 24h, para nada importante se perder).
 */
export async function summarizeConversation(conversationId: string, opts: { upTo?: number; olderThanMs?: number } = {}) {
  const conv = await one<ConversationRow & { summary_ts: string }>("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  if (!conv) return;
  // Com Redis, a conversa mora só na memória curta: resume de lá antes que expire ou que a lista seja cortada
  if (opts.upTo == null && (await redisAlive())) {
    const since = Number(conv.summary_ts ?? 0);
    const entries = ((await allShort(conversationId)) ?? []).filter((e) => e.ts > since);
    let old: ShortEntry[];
    if (opts.olderThanMs != null) old = entries.filter((e) => e.ts < Date.now() - opts.olderThanMs!);
    else old = entries.length >= REDIS_SUMMARY_TRIGGER ? entries.slice(0, entries.length - HISTORY_LIMIT) : [];
    if (!old.length) return;
    const transcript = old
      .map((e) => `${e.role === "assistant" ? "Assistente" : e.role === "event" ? "Evento" : "Pessoa"}: ${e.text.slice(0, 1500)}`)
      .join("\n");
    const summary = await writeSummary(conv.summary, transcript);
    if (summary) await query("UPDATE conversations SET summary = $2, summary_ts = $3 WHERE id = $1", [conversationId, summary, old.at(-1)!.ts]);
    return;
  }
  const rows = await many(
    "SELECT id, role, content, meta FROM messages WHERE conversation_id = $1 AND id > $2 AND processed = true AND ($3::bigint IS NULL OR id <= $3) ORDER BY id",
    [conversationId, conv.summary_until, opts.upTo ?? null],
  );
  let old;
  if (opts.upTo != null) old = rows;
  else {
    if (rows.length < SUMMARY_TRIGGER) return;
    old = rows.slice(0, rows.length - HISTORY_LIMIT);
  }
  if (!old.length) return;
  const transcript = old
    .map((m) => `${m.role === "assistant" ? "Assistente" : m.role === "event" ? "Evento" : "Pessoa"}: ${describeMessage(m).slice(0, 1500)}`)
    .join("\n");
  const summary = await writeSummary(conv.summary, transcript);
  if (summary) await query("UPDATE conversations SET summary = $2, summary_until = $3 WHERE id = $1", [conversationId, summary, old.at(-1)!.id]);
}

async function writeSummary(current: string | null, transcript: string) {
  const r = await chatCompletion(await resolveModel("summary"), {
    messages: [
      {
        role: "system",
        content:
          "Atualize o resumo da conversa entre uma pessoa e seu assistente. Mantenha fatos, decisões, pendências, compromissos e preferências. " +
          "Descarte conversa fiada. Máximo 15 linhas, em português, em tópicos curtos.",
      },
      { role: "user", content: `Resumo atual:\n${current ?? "(vazio)"}\n\nNovas mensagens:\n${transcript.slice(0, 40_000)}` },
    ],
  });
  return r.message.content?.trim() || null;
}
