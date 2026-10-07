import { CLIENT_AGENT_TOOLS } from "./agent/team.js";
import { Tracer } from "./agent/trace.js";
import { many, one, query } from "./db/pool.js";
import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";

/**
 * Melhoria diária (19h): o sistema aprende com o uso de cada cliente e monta agentes sob medida.
 * Uma única chamada barata por cliente que usou o assistente no dia, com um resumo curto do que ele pediu.
 * Assuntos se acumulam dia a dia; um agente só nasce quando o assunto se repete em dias diferentes.
 */

const MAX_AGENTS = 3;
const MIN_EXECUTIONS = 3;
/** dias diferentes em que o assunto apareceu antes de virar agente */
const MIN_DAYS = 2;

export async function dailyImprovement(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const users = await many(
    `SELECT u.id FROM users u WHERE u.status = 'active'
        AND (SELECT COUNT(*) FROM executions e WHERE e.user_id = u.id AND e.trigger = 'message' AND e.started_at > now() - interval '24 hours') >= $1`,
    [MIN_EXECUTIONS],
  );
  const out = { users: users.length, created: 0, updated: 0, retired: 0 };
  for (const u of users) {
    try {
      const r = await improveUser(u.id);
      out.created += r.created;
      out.updated += r.updated;
      out.retired += r.retired;
    } catch (err) {
      log?.error({ err, userId: u.id }, "falha na melhoria diária");
    }
  }
  log?.info(out, "melhoria diária concluída");
  return out;
}

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24);

export async function improveUser(userId: string) {
  const asks = await many(
    `SELECT left(regexp_replace(input, '\\s+', ' ', 'g'), 180) AS t FROM executions
      WHERE user_id = $1 AND trigger = 'message' AND started_at > now() - interval '24 hours' AND input IS NOT NULL ORDER BY started_at LIMIT 50`,
    [userId],
  );
  if (asks.length < MIN_EXECUTIONS) return { created: 0, updated: 0, retired: 0 };
  const topics = await many("SELECT topic, round(score::numeric, 1) AS score, days FROM user_topics WHERE user_id = $1 ORDER BY score DESC LIMIT 15", [userId]);
  const agents = await many("SELECT slug, name, focus, uses, created_at FROM client_agents WHERE user_id = $1 AND active", [userId]);
  const tools = Object.keys(CLIENT_AGENT_TOOLS).join(", ");

  const tracer = await Tracer.start({ trigger: "improve", userId, input: `${asks.length} pedidos nas últimas 24h` });
  const step = await tracer.step({ agent: "melhoria", type: "llm", name: "analisar o dia do cliente" });
  const prompt =
    `Pedidos do cliente nas últimas 24h (um por linha):\n${asks.map((a) => `- ${a.t}`).join("\n")}\n\n` +
    `Assuntos acumulados (assunto, pontuação, dias em que apareceu): ${topics.length ? topics.map((t) => `${t.topic} (${t.score}, ${t.days}d)`).join("; ") : "nenhum"}\n` +
    `Agentes que ele já tem: ${agents.length ? agents.map((a) => `${a.slug}: ${a.focus} (usado ${a.uses}x)`).join("; ") : "nenhum"}\n` +
    `Ferramentas que um agente pode ter: ${tools}`;
  const r = await chatCompletion(await resolveModel("improve"), {
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Você melhora o time de agentes de um assistente pessoal para UM cliente. Responda só JSON:\n" +
          '{"topics":[{"topic":"cinema","weight":1-5}],"create":[{"topic":"cinema","name":"Cinema","focus":"sessões, estreias e ingressos na cidade dele","instructions":"...","tools":["web_search"]}],' +
          '"update":[{"slug":"...","instructions":"..."}],"retire":["slug"]}\n' +
          "Regras: topics = assuntos concretos do dia (1 a 3 palavras, minúsculas, ex.: cinema, celulares, academia), no máximo 6. " +
          `create só para assunto que já aparece em ${MIN_DAYS}+ dias nos acumulados e é recorrente hoje, e que um especialista atenderia melhor que o time geral; ` +
          `no máximo 1 por dia e ${MAX_AGENTS} no total. instructions: 3 a 5 frases práticas com o que esse cliente costuma querer (cidade, marcas, faixa de preço, horários) e onde buscar. ` +
          "update só se aprendeu algo novo e útil sobre o gosto dele. retire agentes sem uso há muito tempo. Na dúvida, não crie nada: listas vazias são a resposta normal.",
      },
      { role: "user", content: prompt },
    ],
  });
  await step.ok(r.message.content, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });

  let plan: any = {};
  try {
    plan = JSON.parse(String(r.message.content ?? "{}").replace(/^```(json)?|```$/g, ""));
  } catch {
    await tracer.error(new Error("resposta não era JSON"));
    return { created: 0, updated: 0, retired: 0 };
  }

  // assuntos: pontuação com decaimento (o que ele parou de pedir vai sumindo)
  await query("UPDATE user_topics SET score = score * 0.85 WHERE user_id = $1", [userId]);
  for (const t of (plan.topics ?? []).slice(0, 6)) {
    const topic = String(t.topic ?? "").toLowerCase().trim().slice(0, 40);
    if (!topic) continue;
    const w = Math.min(5, Math.max(1, Number(t.weight) || 1));
    await query(
      `INSERT INTO user_topics (user_id, topic, score, days, last_at) VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (user_id, topic) DO UPDATE SET score = user_topics.score + $3,
         days = user_topics.days + CASE WHEN user_topics.last_at::date < current_date THEN 1 ELSE 0 END, last_at = now()`,
      [userId, topic, w],
    );
  }
  await query("DELETE FROM user_topics WHERE user_id = $1 AND score < 0.5", [userId]);

  let created = 0;
  let updated = 0;
  let retired = 0;
  const active = (await one("SELECT COUNT(*)::int AS n FROM client_agents WHERE user_id = $1 AND active", [userId])).n as number;
  for (const c of (plan.create ?? []).slice(0, 1)) {
    if (active + created >= MAX_AGENTS) break;
    const topic = await one("SELECT days FROM user_topics WHERE user_id = $1 AND topic = $2", [userId, String(c.topic ?? "").toLowerCase().trim()]);
    if (!topic || topic.days < MIN_DAYS) continue; // a IA não decide sozinha: o assunto tem que se repetir de verdade
    const slug = slugify(c.name ?? c.topic ?? "");
    const toolNames = (Array.isArray(c.tools) ? c.tools : []).filter((n: string) => n in CLIENT_AGENT_TOOLS).slice(0, 6);
    if (!slug || !toolNames.length || !c.instructions) continue;
    await query(
      `INSERT INTO client_agents (user_id, slug, name, focus, instructions, tools) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, slug) DO UPDATE SET active = true, focus = $4, instructions = $5, tools = $6, updated_at = now()`,
      [userId, slug, String(c.name).slice(0, 40), String(c.focus ?? c.topic).slice(0, 200), String(c.instructions).slice(0, 1500), toolNames],
    );
    created++;
  }
  for (const u of (plan.update ?? []).slice(0, 3)) {
    if (!u.instructions) continue;
    const res = await query("UPDATE client_agents SET instructions = $3, updated_at = now() WHERE user_id = $1 AND slug = $2 AND active", [
      userId,
      String(u.slug),
      String(u.instructions).slice(0, 1500),
    ]);
    updated += res.rowCount ?? 0;
  }
  for (const slug of (plan.retire ?? []).slice(0, 3)) {
    // só aposenta o que tem pelo menos uma semana (dar tempo de ser usado)
    const res = await query("UPDATE client_agents SET active = false WHERE user_id = $1 AND slug = $2 AND created_at < now() - interval '7 days'", [userId, String(slug)]);
    retired += res.rowCount ?? 0;
  }
  await tracer.finish(JSON.stringify({ created, updated, retired, topics: (plan.topics ?? []).map((t: any) => t.topic) }));
  return { created, updated, retired };
}
