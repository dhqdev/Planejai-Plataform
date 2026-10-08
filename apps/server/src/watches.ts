import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";
import { many, one, query } from "./db/pool.js";
import { isConnected } from "./integrations/registry.js";
import { mercadolivreSearch, webSearch } from "./agent/tools/research.js";
import { Tracer } from "./agent/trace.js";
import { notifyUser } from "./social.js";
import { brl } from "./agent/tools/finance.js";

/**
 * Acompanhamentos: o assistente fica de olho em algo que a pessoa quer (preço de um produto, novidade de um assunto)
 * por 7 dias (ajustável) e, a cada olhada, conta o que achou ou que não achou nada (notify_mode "always");
 * em "changes" só fala quando aparece algo melhor. A checagem em si não usa IA: só busca e compara.
 * A IA (modelo barato, poucas linhas) só entra para escrever quando há algo novo; "não achei" é texto pronto.
 */

export interface WatchInput {
  userId: string;
  conversationId: string;
  kind: "price" | "news";
  query: string;
  target?: number | null;
  everyHours?: number;
  days?: number;
  notifyMode?: NotifyMode;
}

export type NotifyMode = "always" | "changes";
const MAX_ACTIVE_PER_USER = 10;
export const DEFAULT_DAYS = 7;

const clampHours = (kind: string, h?: number | null) => {
  // preço muda devagar e notícia menos ainda: intervalo mínimo para não gastar
  const min = kind === "price" ? 3 : 6;
  return Math.max(min, Math.min(72, Math.round(h ?? (kind === "price" ? 8 : 12))));
};
const clampDays = (d?: number | null) => Math.max(1, Math.min(30, Math.round(d ?? DEFAULT_DAYS)));

export async function createWatch(w: WatchInput) {
  const n = await one("SELECT COUNT(*)::int AS n FROM watches WHERE user_id = $1 AND active", [w.userId]);
  if (n.n >= MAX_ACTIVE_PER_USER) throw new Error(`Já existem ${n.n} acompanhamentos ativos; cancele algum antes.`);
  return one(
    `INSERT INTO watches (user_id, conversation_id, kind, query, target, every_hours, next_check_at, expires_at, notify_mode)
     VALUES ($1,$2,$3,$4,$5,$6, now(), now() + make_interval(days => $7), $8)
     RETURNING id, kind, query, target, every_hours, expires_at, notify_mode`,
    [w.userId, w.conversationId, w.kind, w.query.slice(0, 200), w.target ?? null, clampHours(w.kind, w.everyHours), clampDays(w.days), w.notifyMode ?? "always"],
  );
}

export async function listWatches(userId: string | null) {
  return many(
    `SELECT w.id, w.kind, w.query, w.target, w.best, w.every_hours, w.next_check_at, w.notified, w.active, w.paused, w.expires_at, w.created_at,
            w.notify_mode, w.checks, w.last_check_at, w.last_result, COALESCE(u.full_name, u.name) AS user_name
       FROM watches w JOIN users u ON u.id = w.user_id WHERE ($1::uuid IS NULL OR w.user_id = $1) ORDER BY w.active DESC, w.created_at DESC LIMIT 200`,
    [userId],
  );
}

export async function cancelWatch(id: string, userId: string | null) {
  const r = await query("UPDATE watches SET active = false, ended_notice = true WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

/** Ajustes pela tela (ou pelo assistente): o que buscar, meta, frequência, dias, como avisar, pausar e reativar. */
export async function updateWatch(
  id: string,
  userId: string | null,
  p: { query?: string; target?: number | null; every_hours?: number; days?: number; notify_mode?: NotifyMode; paused?: boolean; reactivate?: boolean },
) {
  const w = await one("SELECT * FROM watches WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [id, userId]);
  if (!w) return null;
  if (p.reactivate && !w.active) {
    const n = await one("SELECT COUNT(*)::int AS n FROM watches WHERE user_id = $1 AND active", [w.user_id]);
    if (n.n >= MAX_ACTIVE_PER_USER) throw new Error(`Já existem ${n.n} acompanhamentos ativos; pare algum antes.`);
  }
  const days = p.days != null ? clampDays(p.days) : null;
  return one(
    `UPDATE watches SET
        query = COALESCE($2, query),
        target = CASE WHEN $3::boolean THEN $4::numeric ELSE target END,
        every_hours = COALESCE($5, every_hours),
        notify_mode = COALESCE($6, notify_mode),
        paused = COALESCE($7, paused),
        -- dias contam a partir de agora; reativar sem dizer os dias dá mais uma semana
        expires_at = CASE WHEN $8::int IS NOT NULL THEN now() + make_interval(days => $8::int)
                          WHEN $9 AND NOT active THEN now() + make_interval(days => ${DEFAULT_DAYS}) ELSE expires_at END,
        active = CASE WHEN $9 THEN true ELSE active END,
        ended_notice = CASE WHEN $9 THEN false ELSE ended_notice END,
        next_check_at = CASE WHEN $9 AND NOT active THEN now() ELSE next_check_at END
      WHERE id = $1 RETURNING *`,
    [
      id,
      p.query?.trim() ? p.query.trim().slice(0, 200) : null,
      p.target !== undefined,
      p.target != null && Number(p.target) > 0 ? Number(p.target) : null,
      p.every_hours != null ? clampHours(w.kind, p.every_hours) : null,
      p.notify_mode === "always" || p.notify_mode === "changes" ? p.notify_mode : null,
      typeof p.paused === "boolean" ? p.paused : null,
      days,
      Boolean(p.reactivate),
    ],
  );
}

/** "Olhar agora" pela tela: roda a checagem na hora e devolve o resultado. */
export async function checkWatchNow(id: string, userId: string | null) {
  const w = await one(
    `UPDATE watches SET next_check_at = now() + make_interval(hours => every_hours)
      WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND active RETURNING *`,
    [id, userId],
  );
  if (!w) return null;
  await checkOne(w);
  return one("SELECT last_result, last_check_at, best FROM watches WHERE id = $1", [id]);
}

/** Roda no worker a cada 15 min: só os acompanhamentos vencidos. */
export async function checkDueWatches(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  // acabou o prazo: desliga e avisa a pessoa uma vez
  const ended = await many("UPDATE watches SET active = false WHERE active AND expires_at < now() RETURNING *");
  for (const w of ended) await endNotice(w).catch((err) => log?.error({ err, watch: w.id }, "falha ao avisar fim do acompanhamento"));
  const due = await many(
    `UPDATE watches SET next_check_at = now() + make_interval(hours => every_hours)
      WHERE id IN (SELECT id FROM watches WHERE active AND NOT paused AND next_check_at <= now() ORDER BY next_check_at LIMIT 20)
      RETURNING *`,
  );
  let notified = 0;
  for (const w of due) {
    try {
      if (await checkOne(w)) notified++;
    } catch (err) {
      log?.error({ err, watch: w.id }, "falha ao checar acompanhamento");
    }
  }
  if (due.length) log?.info({ checked: due.length, notified }, "acompanhamentos checados");
  return { checked: due.length, notified };
}

async function endNotice(w: any) {
  if (w.ended_notice) return;
  await query("UPDATE watches SET ended_notice = true WHERE id = $1", [w.id]);
  const best = w.kind === "price" && w.best?.price ? ` O menor preço que vi foi ${brl(Number(w.best.price))}.` : "";
  await notifyUser(w.user_id, `Terminei de acompanhar "${w.query}" (${w.checks} olhadas).${best} Se quiser, é só pedir que eu continuo de olho.`);
}

async function fakeCtx(w: any): Promise<any> {
  const user = await one("SELECT * FROM users WHERE id = $1", [w.user_id]);
  const conversation = await one("SELECT * FROM conversations WHERE id = $1", [w.conversation_id]);
  return { user, conversation, agent: "acompanhamento", callChain: [], timezone: user?.timezone ?? "America/Sao_Paulo" };
}

type Outcome = { found: boolean; summary: string; facts?: string; fallback?: string | null; mayBeIrrelevant?: boolean };

async function checkOne(w: any): Promise<boolean> {
  const ctx = await fakeCtx(w);
  if (!ctx.user || ctx.user.status !== "active") {
    await query("UPDATE watches SET active = false WHERE id = $1", [w.id]);
    return false;
  }
  const first = !w.checks;
  let out = w.kind === "price" ? await checkPrice(w, ctx) : await checkNews(w, ctx);
  let sent = false;
  if (out.found && out.facts) sent = await send(w, out.facts, out.fallback ?? null, out.mayBeIrrelevant);
  // a IA leu os resultados novos e nada respondia ao pedido
  if (out.found && !sent) out = { found: false, summary: "apareceram resultados, mas nada que responda ao seu pedido." };
  await query("UPDATE watches SET checks = checks + 1, last_check_at = now(), last_result = $2 WHERE id = $1", [
    w.id,
    { found: out.found, summary: out.summary.slice(0, 400), at: new Date().toISOString() },
  ]);
  // não achou (ou a IA viu que nada era relevante): no modo "sempre avisar" conta isso em uma linha, sem IA
  if (!sent && w.notify_mode !== "changes") {
    const next = new Date(Date.now() + w.every_hours * 3_600_000).toLocaleString("pt-BR", {
      timeZone: ctx.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const intro = first ? `Comecei a acompanhar "${w.query}". ` : `Dei mais uma olhada em "${w.query}": `;
    await notifyUser(w.user_id, `${intro}${out.summary} Próxima olhada ${next}.`);
    await query("UPDATE watches SET notified = notified + 1 WHERE id = $1", [w.id]);
    sent = true;
  }
  return sent;
}

async function checkPrice(w: any, ctx: any): Promise<Outcome> {
  if (!(await isConnected("mercadolivre"))) return { found: false, summary: "não consegui ver os preços agora (Mercado Livre não está conectado)." };
  const r: any = await mercadolivreSearch.run({ query: w.query, limit: 10, sort: "price_asc" }, ctx);
  const items = (r?.items ?? []).filter((i: any) => Number(i.price) > 0);
  if (!items.length) return { found: false, summary: "não achei anúncio desse produto agora." };
  const best = items.reduce((a: any, b: any) => (Number(b.price) < Number(a.price) ? b : a));
  const price = Number(best.price);
  const prev = w.best?.price != null ? Number(w.best.price) : null;
  await query("UPDATE watches SET best = $2 WHERE id = $1", [w.id, { price, title: best.title, link: best.link, at: new Date().toISOString() }]);
  const target = w.target != null ? Number(w.target) : null;
  // primeira olhada só guarda a referência (a pessoa acabou de ver os preços)
  if (prev == null) return { found: false, summary: `hoje o menor preço é ${brl(price)}${target != null ? ` (sua meta é ${brl(target)})` : ""}. ${best.link}` };
  const dropped = price <= prev * 0.97;
  const hitTarget = target != null && price <= target && prev > target;
  if (!dropped && !hitTarget)
    return { found: false, summary: `nada mais barato por enquanto, o menor segue ${brl(price)}${target != null ? ` (meta ${brl(target)})` : ""}.` };
  const facts =
    `Produto acompanhado: ${w.query}. Achei agora: "${best.title}" por ${brl(price)} (antes o melhor era ${brl(prev)})` +
    `${target != null ? `, meta da pessoa: ${brl(target)}` : ""}${best.free_shipping ? ", frete grátis" : ""}. Link: ${best.link}`;
  return {
    found: true,
    summary: `achei mais barato: ${best.title} por ${brl(price)} (antes ${brl(prev)}).`,
    facts,
    fallback: `Achei mais barato: ${best.title} por ${brl(price)} (antes ${brl(prev)}). ${best.link}`,
  };
}

async function checkNews(w: any, ctx: any): Promise<Outcome> {
  // só com busca que devolve links (Tavily/Brave); a busca via IA custaria token a cada checagem
  if (!(await isConnected("tavily")) && !(await isConnected("brave")))
    return { found: false, summary: "não consegui pesquisar agora (falta a busca Tavily ou Brave)." };
  const r: any = await webSearch.run({ query: w.query, max_results: 6 }, ctx);
  const results: { title: string; url: string; content?: string }[] = r?.results ?? [];
  const seen = new Set<string>(w.seen ?? []);
  const fresh = results.filter((x) => x.url && !seen.has(x.url));
  const nextSeen = [...results.map((x) => x.url), ...(w.seen ?? [])].filter(Boolean).slice(0, 60);
  await query("UPDATE watches SET seen = $2 WHERE id = $1", [w.id, nextSeen]);
  if (!seen.size) return { found: false, summary: `marquei ${results.length} resultado(s) que já existiam; aviso quando sair algo novo.` };
  if (!fresh.length) return { found: false, summary: "nada novo desde a última vez." };
  const facts = fresh
    .slice(0, 4)
    .map((x) => `- ${x.title} (${x.url}): ${String(x.content ?? "").slice(0, 240)}`)
    .join("\n");
  return {
    found: true,
    summary: `${fresh.length} resultado(s) novo(s): ${fresh[0]!.title}.`,
    facts: `A pessoa pediu para ser avisada sobre: ${w.query}. Resultados novos desde a última olhada:\n${facts}`,
    fallback: null,
    mayBeIrrelevant: true,
  };
}

/** Escreve a mensagem com o modelo barato (ou usa o texto pronto se a IA falhar) e manda. */
async function send(w: any, facts: string, fallback: string | null, mayBeIrrelevant = false): Promise<boolean> {
  const tracer = await Tracer.start({ trigger: "watch", userId: w.user_id, conversationId: w.conversation_id, input: facts.slice(0, 2000) });
  let text = fallback;
  try {
    const step = await tracer.step({ agent: "acompanhamento", type: "llm", name: "escrever aviso" });
    const r = await chatCompletion(await resolveModel("proactive"), {
      maxTokens: 220,
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente pessoal no WhatsApp avisando a pessoa de algo que ela pediu para você acompanhar. " +
            "Escreva 1 a 3 linhas, português do Brasil, tom de amigo, com o dado principal e o link. Sem markdown." +
            (mayBeIrrelevant ? " Se nada disso for realmente novo e relevante para o pedido, responda exatamente NADA." : ""),
        },
        { role: "user", content: facts },
      ],
    });
    await step.ok(r.message.content, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    const out = (r.message.content ?? "").trim();
    if (out) text = out;
  } catch {
    /* usa o texto pronto */
  }
  if (!text || /^nada\.?$/i.test(text)) {
    await tracer.finish("[nada novo]");
    return false;
  }
  await notifyUser(w.user_id, text);
  await query("UPDATE watches SET notified = notified + 1 WHERE id = $1", [w.id]);
  await tracer.finish(text);
  return true;
}
