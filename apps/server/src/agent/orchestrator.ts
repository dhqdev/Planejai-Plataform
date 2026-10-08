import { getChannel } from "../channels/index.js";
import type { Channel } from "../channels/types.js";
import { many, one, pool, query, waitLonger } from "../db/pool.js";
import { INTEGRATIONS, isConnected } from "../integrations/registry.js";
import { chatCompletion, LlmError } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatMessage } from "../llm/types.js";
import { getSettings } from "../settings.js";
import { delegationTool, TeamRoom } from "./collab.js";
import { ctoSystemPrompt } from "./prompts.js";
import { availableTools, OWNER_INTEGRATIONS, runToolLoop } from "./runner.js";
import { clientAgents, CTO_TOOLS, SPECIALISTS, type AgentDef } from "./team.js";
import { TEAM_TOOLS } from "./tools/team.js";
import { finishBrowser } from "./tools/research.js";
import { Guard, GuardTimeout, redactSecrets } from "./guard.js";
import { isOwner } from "../ingest.js";
import { describeMessage, preprocessMedia } from "./media.js";
import { unbackedClaim } from "./claims.js";
import { openPending, resolvePending } from "./confirm.js";
import { Progress } from "./progress.js";
import { humanize } from "./humanize.js";
import { isAckOnly, pickReaction } from "./reaction.js";
import { Tracer } from "./trace.js";
import { allShort, pushShort, recentShort, redisAlive, type ShortEntry } from "../shortmem.js";
import { billingAccess, blockedMessage, planOf } from "../billing.js";
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
  const out = text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_m, label, url) => (label === url ? url : `${label}: ${url}`))
    .trim();
  return humanize(out);
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
  /** outra rodada desta conversa ainda está em andamento (só com wait: false) */
  busy?: boolean;
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
  opts: ProcessOpts = { trigger: "message" },
): Promise<ProcessResult> {
  // Um processamento por conversa por vez
  const lock = await pool.connect();
  const restore = await waitLonger(lock).catch(() => null);
  let locked = false;
  try {
    if (opts.wait === false) {
      // a fila não espera: com a conversa ocupada, devolve "busy" e o job volta para a fila em vez de prender uma vaga do worker
      locked = (await lock.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [conversationId])).rows[0].ok;
      if (!locked) return { busy: true, executionId: null, bubbles: [], outbox: new Outbox() };
    } else {
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [conversationId]);
      locked = true;
    }
    return await processLocked(conversationId, opts);
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [conversationId]).catch(() => {});
    await restore?.();
    lock.release();
  }
}

export interface ProcessOpts {
  trigger: "message" | "reminder" | "playground";
  event?: string;
  channel?: Channel;
  /** a fila ainda vai tentar de novo: erro passageiro deixa as mensagens pendentes em vez de perder */
  retryable?: boolean;
  /** false = se a conversa já está sendo processada, devolve busy na hora em vez de esperar a trava */
  wait?: boolean;
}

/** OpenRouter fora do ar, limite de taxa, rede caída ou tempo de rede esgotado: vale tentar de novo. */
export function isTransientError(err: unknown) {
  if (err instanceof LlmError) return err.status === 429 || (err.status ?? 0) >= 500;
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  const code = e?.code ?? e?.cause?.code ?? "";
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+)$/.test(code) || /fetch failed/i.test(e?.message ?? "");
}

async function processLocked(conversationId: string, opts: ProcessOpts): Promise<ProcessResult> {
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
  // Assinatura: acabaram os dias grátis ou o pagamento está pendente. Avisa uma vez por dia com o link e não chama a IA.
  if (opts.trigger === "message" && settings.billingEnabled) {
    const access = await billingAccess(user, settings);
    if (!access.allowed) {
      await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
      const tracer = await Tracer.start({ trigger: opts.trigger, userId: user.id, conversationId, input: pending.map((m) => m.content).join("\n") });
      const step = await tracer.step({ agent: "cto", type: "info", name: "trava: assinatura", input: { situacao: access.state } });
      await step.ok({ blocked: true });
      const notified = await one(
        `UPDATE users SET profile = profile || jsonb_build_object('billing_notice_at', now()) WHERE id = $1
           AND COALESCE((profile->>'billing_notice_at')::timestamptz, 'epoch') < now() - interval '24 hours' RETURNING id`,
        [user.id],
      );
      if (notified) await channel.sendText(conversation.remote_jid, blockedMessage(access, planOf(settings))).catch(() => {});
      await tracer.finish(notified ? "[assinatura: avisado]" : "[assinatura: silêncio]");
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
  // mensagens desta rodada já interpretadas (vão para a memória curta no fim, ou no erro definitivo)
  let fresh: ShortEntry[] = [];
  // sala do time desta rodada: diz quais ferramentas já rodaram, para uma nova tentativa não repetir ação feita
  let room: TeamRoom | undefined;

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

    // Ação sensível esperando o "sim" da pessoa: esta mensagem é a resposta (nunca vira "só reação")
    const waiting = opts.trigger === "message" ? await openPending(conversationId) : [];
    // Só um "valeu", "ok" ou emoji: a reação já respondeu, então nem chama a IA (economia de tokens)
    const userMsgs = pending.filter((m) => m.role === "user");
    if (!waiting.length && opts.trigger !== "reminder" && userMsgs.length === pending.length && userMsgs.every((m) => !m.media && (!m.meta?.kind || m.meta.kind === "text"))) {
      const last = (await recentShort(conversationId, 3))?.filter((e) => e.role === "assistant").at(-1);
      if (isAckOnly(userMsgs.map((m) => m.content ?? ""), Boolean(last && /\?\s*\S{0,3}\s*$/.test(last.text)))) {
        const step = await tracer.step({ agent: "cto", type: "info", name: "só reação, sem IA", input: { reacao: autoReaction } });
        await step.ok({ economizou: "uma chamada do CTO" });
        await pushShort(conversationId, userMsgs.map((m) => ({ id: m.id, role: "user" as const, text: m.content ?? "", ts: new Date(m.created_at).getTime(), ext: m.external_id })));
        if (await redisAlive()) await query("DELETE FROM messages WHERE id = ANY($1)", [pending.map((m) => m.id)]);
        else await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
        await tracer.finish("[[silencio]]");
        return { executionId: tracer.executionId, bubbles: [], outbox };
      }
    }

    if (opts.trigger !== "reminder") progress.start();
    await preprocessMedia(pending, channel, tracer, conversation.remote_jid);

    // Contexto: memória curta no Redis (já interpretada); sem Redis, as mensagens das últimas horas no Postgres
    const pendingIds = new Set(pending.map((p) => p.id));
    fresh = pending.map((m) => ({
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
    // Só entra no time quem tem pelo menos uma ferramenta utilizável (menos token e nada de delegação inútil)
    const team: AgentDef[] = [];
    for (const s of [...SPECIALISTS, ...(await clientAgents(user.id))]) if ((await availableTools(s.tools, user)).length) team.push(s);
    const lastText = fresh.map((e) => e.text).join(" ").slice(0, 500);
    const disconnected = [];
    // para convidados, as contas do dono nem existem: não adianta dizer "conecte no painel"
    const owner = isOwner(user.phone);
    for (const i of INTEGRATIONS) if ((owner || !OWNER_INTEGRATIONS.has(i.id)) && !(await isConnected(i.id))) disconnected.push(i.name);
    const system = ctoSystemPrompt({
      settings,
      user,
      timezone,
      memories: await loadMemories(user.id, lastText),
      summary: conversation.summary,
      specialists: team,
      disconnected,
      autoReaction,
      styleNotes: (user as any).style_notes ?? null,
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
      room: (room = new TeamRoom(team)),
      callChain: ["cto"],
      guard,
      inboundImages: pending.map((m) => m.inboundImage).filter(Boolean),
      inboundFiles: pending.map((m) => m.inboundFile).filter(Boolean),
      inboundText: fresh.map((e) => `[msg_id=${e.id}] ${e.text}`).join("\n").slice(0, 6000),
      // lembrete agendado não ganha "já vou ver": a pessoa não perguntou nada agora
      progress: opts.trigger === "reminder" ? undefined : progress,
    };
    const tools = [...(await availableTools(CTO_TOOLS, user)), ...TEAM_TOOLS, ...team.map(delegationTool)];
    // "sim"/"não" da pessoa para a ação guardada: o servidor executa (ou descarta) antes do CTO responder
    const confirmNotes = await resolvePending(
      waiting,
      userMsgs.filter((m) => !m.media && (!m.meta?.kind || m.meta.kind === "text")).map((m) => m.content ?? ""),
      ctx,
    );
    let result;
    try {
      result = await runToolLoop({ agent: "cto", task: "agent:cto", ctx, tools, messages: [{ role: "system", content: system }, ...messages, ...confirmNotes], maxSteps: 10 });
    } finally {
      // navegador esquecido aberto: fecha e, se a pessoa pediu a gravação, manda junto
      if (ctx.room.browser) await finishBrowser(ctx).catch(() => {});
    }

    // trava: disse que fez (anotei, apaguei, agendei…) sem nenhuma ferramenta confirmar? Faz agora ou admite.
    const claim = result.text && !result.timedOut ? unbackedClaim(result.text, ctx.room.done) : null;
    if (claim && !guard.expired) {
      const step = await tracer.step({ agent: "cto", type: "info", name: "trava: ação não confirmada", input: { acao: claim, resposta: result.text.slice(0, 300) } });
      const retry = await runToolLoop({
        agent: "cto",
        task: "agent:cto",
        ctx,
        tools,
        maxSteps: 5,
        messages: [
          ...result.messages,
          {
            role: "system",
            content:
              `Sua resposta diz que fez "${claim}", mas nenhuma ferramenta confirmou isso nesta conversa. ` +
              "Faça a ação agora com a ferramenta certa (ou peça ao especialista) e responda de novo. Se não der, diga com honestidade o que não foi feito.",
          },
        ],
      }).catch(() => null);
      const still = retry?.text ? unbackedClaim(retry.text, ctx.room.done) : claim;
      await step.ok({ refeito: Boolean(retry?.text) && !still });
      result.text = retry?.text && !still ? retry.text : `Não consegui concluir isso agora (${claim}), então nada foi feito. Pode me pedir de novo?`;
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
    // só agora a rodada entra na memória curta: se der erro passageiro e a fila tentar de novo, nada fica duplicado
    await pushShort(conversationId, fresh);
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
      await pushShort(conversationId, fresh).catch(() => {});
      await channel
        .sendText(conversation.remote_jid, `Isso passou do meu limite de ${fmtMinutes(guard.minutes)} e parei aqui. Quer que eu tente de um jeito mais simples?`)
        .catch(() => {});
      await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
      return { executionId: tracer.executionId, bubbles: [], outbox };
    }
    // Erro passageiro com nova tentativa na fila: as mensagens ficam pendentes e a próxima rodada responde tudo
    // ...mas só se nada com efeito já rodou: refazer a rodada repetiria lembrete criado, mensagem enviada, conta paga
    const acted = room ? sideEffectsDone(room.done) : [];
    if (opts.retryable && isTransientError(err) && !acted.length) throw err;
    await pushShort(conversationId, fresh).catch(() => {});
    // Não deixa a pessoa no vácuo
    const sorry = acted.length
      ? "Tive um problema técnico aqui no meio do caminho. O que já fiz ficou feito, mas não consegui terminar. Me fala o que faltou que eu continuo."
      : "Tive um problema técnico aqui e não consegui terminar. Pode tentar de novo em instantes?";
    await channel.sendText(conversation.remote_jid, sorry).catch(() => {});
    await query("UPDATE messages SET processed = true WHERE id = ANY($1)", [pending.map((m) => m.id)]);
    throw err;
  } finally {
    progress.stop();
    guard.dispose();
  }
}

/** Ferramentas que só leem ou calculam: rodar de novo numa nova tentativa não muda nada. */
const NO_SIDE_EFFECT =
  /^(ask_|consult_|share_with_team$|react_to_message$|web_search|fetch_url|browser_|screenshot_url|map_route|make_chart|make_image|calculate|read_|list_|get_|search_)|(_list|_status|_search|_read|_summary|_events|_channels|_workflows|_executions|_catalog|_search_issues|_read_page|attach_image)$/;

export function sideEffectsDone(done: Set<string>) {
  return [...done].filter((n) => !NO_SIDE_EFFECT.test(n));
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
    // usage_daily conta por dia (o ingest soma em current_date); antes somava ontem + hoje e travava antes da hora
    const r = await one("SELECT COALESCE(SUM(messages), 0)::int AS n FROM usage_daily WHERE user_id = $1 AND day = current_date", [userId]);
    if (r.n > s.dailyMessageLimit) return { limite: "mensagens hoje", usado: r.n, maximo: s.dailyMessageLimit };
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
