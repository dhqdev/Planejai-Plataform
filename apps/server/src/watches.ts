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
 * e manda mensagem sozinho ao longo do dia quando acha algo melhor. A checagem em si não usa IA: só busca e compara.
 * A IA (modelo barato, poucas linhas) só entra quando há algo novo para contar.
 */

export interface WatchInput {
  userId: string;
  conversationId: string;
  kind: "price" | "news";
  query: string;
  target?: number | null;
  everyHours?: number;
}

const MAX_ACTIVE_PER_USER = 10;

export async function createWatch(w: WatchInput) {
  const n = await one("SELECT COUNT(*)::int AS n FROM watches WHERE user_id = $1 AND active", [w.userId]);
  if (n.n >= MAX_ACTIVE_PER_USER) throw new Error(`Já existem ${n.n} acompanhamentos ativos; cancele algum antes.`);
  // preço muda devagar e notícia menos ainda: intervalo mínimo para não gastar
  const minHours = w.kind === "price" ? 3 : 8;
  const every = Math.max(minHours, Math.min(72, Math.round(w.everyHours ?? (w.kind === "price" ? 6 : 12))));
  return one(
    `INSERT INTO watches (user_id, conversation_id, kind, query, target, every_hours, next_check_at)
     VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id, kind, query, target, every_hours, expires_at`,
    [w.userId, w.conversationId, w.kind, w.query.slice(0, 200), w.target ?? null, every],
  );
}

export async function listWatches(userId: string | null) {
  return many(
    `SELECT w.id, w.kind, w.query, w.target, w.best, w.every_hours, w.next_check_at, w.notified, w.active, w.expires_at, w.created_at,
            COALESCE(u.full_name, u.name) AS user_name
       FROM watches w JOIN users u ON u.id = w.user_id WHERE ($1::uuid IS NULL OR w.user_id = $1) ORDER BY w.active DESC, w.created_at DESC LIMIT 200`,
    [userId],
  );
}

export async function cancelWatch(id: string, userId: string | null) {
  const r = await query("UPDATE watches SET active = false WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

/** Roda no worker a cada 15 min: só os acompanhamentos vencidos. */
export async function checkDueWatches(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  await query("UPDATE watches SET active = false WHERE active AND expires_at < now()");
  const due = await many(
    `UPDATE watches SET next_check_at = now() + make_interval(hours => every_hours)
      WHERE id IN (SELECT id FROM watches WHERE active AND next_check_at <= now() ORDER BY next_check_at LIMIT 20)
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

async function fakeCtx(w: any): Promise<any> {
  const user = await one("SELECT * FROM users WHERE id = $1", [w.user_id]);
  const conversation = await one("SELECT * FROM conversations WHERE id = $1", [w.conversation_id]);
  return { user, conversation, agent: "acompanhamento", callChain: [], timezone: user?.timezone ?? "America/Sao_Paulo" };
}

async function checkOne(w: any): Promise<boolean> {
  const ctx = await fakeCtx(w);
  if (!ctx.user || ctx.user.status !== "active") {
    await query("UPDATE watches SET active = false WHERE id = $1", [w.id]);
    return false;
  }
  if (w.kind === "price") return checkPrice(w, ctx);
  return checkNews(w, ctx);
}

async function checkPrice(w: any, ctx: any): Promise<boolean> {
  if (!(await isConnected("mercadolivre"))) return false;
  const r: any = await mercadolivreSearch.run({ query: w.query, limit: 10, sort: "price_asc" }, ctx);
  const items = (r?.items ?? []).filter((i: any) => Number(i.price) > 0);
  if (!items.length) return false;
  const best = items.reduce((a: any, b: any) => (Number(b.price) < Number(a.price) ? b : a));
  const price = Number(best.price);
  const prev = w.best?.price != null ? Number(w.best.price) : null;
  await query("UPDATE watches SET best = $2 WHERE id = $1", [w.id, { price, title: best.title, link: best.link, at: new Date().toISOString() }]);
  // primeira checagem só guarda a referência (a pessoa acabou de ver os preços)
  if (prev == null) return false;
  const target = w.target != null ? Number(w.target) : null;
  const dropped = price <= prev * 0.97;
  const hitTarget = target != null && price <= target && (prev > target);
  if (!dropped && !hitTarget) return false;
  const facts =
    `Produto acompanhado: ${w.query}. Achei agora: "${best.title}" por ${brl(price)} (antes o melhor era ${brl(prev)})` +
    `${target != null ? `, meta da pessoa: ${brl(target)}` : ""}${best.free_shipping ? ", frete grátis" : ""}. Link: ${best.link}`;
  return send(w, facts, `Achei mais barato: ${best.title} por ${brl(price)} (antes ${brl(prev)}). ${best.link}`);
}

async function checkNews(w: any, ctx: any): Promise<boolean> {
  // só com busca que devolve links (Tavily/Brave); a busca via IA custaria token a cada checagem
  if (!(await isConnected("tavily")) && !(await isConnected("brave"))) return false;
  const r: any = await webSearch.run({ query: w.query, max_results: 6 }, ctx);
  const results: { title: string; url: string; content?: string }[] = r?.results ?? [];
  const seen = new Set<string>(w.seen ?? []);
  const fresh = results.filter((x) => x.url && !seen.has(x.url));
  const nextSeen = [...results.map((x) => x.url), ...(w.seen ?? [])].filter(Boolean).slice(0, 60);
  await query("UPDATE watches SET seen = $2 WHERE id = $1", [w.id, nextSeen]);
  if (!seen.size || !fresh.length) return false; // primeira rodada só marca o que já existia
  const facts = fresh
    .slice(0, 4)
    .map((x) => `- ${x.title} (${x.url}): ${String(x.content ?? "").slice(0, 240)}`)
    .join("\n");
  return send(w, `A pessoa pediu para ser avisada sobre: ${w.query}. Resultados novos desde a última olhada:\n${facts}`, null, true);
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
