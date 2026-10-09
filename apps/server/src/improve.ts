import { CLIENT_AGENT_TOOLS, faceFor, slugify, SPECIALISTS } from "./agent/team.js";
import { getTabs, OPTIONAL, saveTabs, TAB_ICONS, TAB_WIDGETS } from "./tabs.js";
import { Tracer } from "./agent/trace.js";
import { many, one, query } from "./db/pool.js";
import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";

/**
 * Reunião noturna (19h): o CTO revisa o dia de cada cliente com o time e todo mundo melhora para ele.
 * Uma única chamada barata por cliente que usou o assistente no dia decide: como falar com a pessoa,
 * o que cada agente aprendeu sobre ela, quais abas liberar no app e se nasce um agente sob medida.
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

export async function improveUser(userId: string) {
  const asks = await many(
    `SELECT left(regexp_replace(input, '\\s+', ' ', 'g'), 180) AS t FROM executions
      WHERE user_id = $1 AND trigger = 'message' AND started_at > now() - interval '24 hours' AND input IS NOT NULL ORDER BY started_at LIMIT 50`,
    [userId],
  );
  if (asks.length < MIN_EXECUTIONS) return { created: 0, updated: 0, retired: 0 };
  const topics = await many("SELECT topic, round(score::numeric, 1) AS score, days FROM user_topics WHERE user_id = $1 ORDER BY score DESC LIMIT 15", [userId]);
  const agents = await many("SELECT slug, name, persona, focus, uses, created_at FROM client_agents WHERE user_id = $1 AND active", [userId]);
  const tools = Object.keys(CLIENT_AGENT_TOOLS).join(", ");
  const person = await one("SELECT style_notes FROM users WHERE id = $1", [userId]);
  const notes = await many("SELECT agent, note FROM agent_notes WHERE user_id = $1 AND note IS NOT NULL", [userId]);
  const usedAgents = await many(
    `SELECT s.agent, COUNT(*)::int AS n FROM execution_steps s JOIN executions e ON e.id = s.execution_id
      WHERE e.user_id = $1 AND s.type = 'llm' AND s.started_at > now() - interval '24 hours' GROUP BY 1`,
    [userId],
  );
  const tabs = await getTabs(userId);

  // a reunião noturna é otimização da plataforma: o custo aparece no uso, mas não sai da carteira de grãos da pessoa
  const tracer = await Tracer.start({ trigger: "improve", userId, input: `${asks.length} pedidos nas últimas 24h`, noCharge: true });
  const step = await tracer.step({ agent: "cto", type: "llm", name: "reunião noturna do time" });
  const prompt =
    `Pedidos do cliente nas últimas 24h (um por linha):\n${asks.map((a) => `- ${a.t}`).join("\n")}\n\n` +
    `Assuntos acumulados (assunto, pontuação, dias em que apareceu): ${topics.length ? topics.map((t) => `${t.topic} (${t.score}, ${t.days}d)`).join("; ") : "nenhum"}\n` +
    `Agentes do time que trabalharam hoje: ${usedAgents.map((a) => `${a.agent} (${a.n}x)`).join(", ") || "só o CTO"}\n` +
    `Agentes sob medida que ele já tem: ${agents.length ? agents.map((a) => `${a.slug}: ${a.focus} (usado ${a.uses}x)`).join("; ") : "nenhum"}\n` +
    `Jeito de falar com ele hoje: ${person?.style_notes ?? "nada anotado"}\n` +
    `Notas atuais dos agentes: ${notes.map((n) => `${n.agent}: ${n.note}`).join(" | ") || "nenhuma"}\n` +
    `Abas extras já liberadas no app: ${[...tabs.modules, ...tabs.custom.map((c) => `aba "${c.title}"`)].join(", ") || "nenhuma (só o essencial)"}\n` +
    `Ferramentas que um agente sob medida pode ter: ${tools}`;
  const r = await chatCompletion(await resolveModel("improve"), {
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Você é o CTO de um time de agentes de um assistente pessoal no WhatsApp, na reunião noturna sobre UM cliente. " +
          "Todos melhoram para ele, gastando pouco. Responda só JSON:\n" +
          '{"topics":[{"topic":"cinema","weight":1-5}],"style":"...","agent_notes":[{"agent":"financeiro","note":"..."}],' +
          '"tabs":{"enable":["convites"],"custom":[{"title":"Academia","icon":"heart","widgets":["categories","reminders"]}]},' +
          '"create":[{"topic":"cinema","name":"Cinema","persona":"Pipoca","focus":"sessões, estreias e ingressos na cidade dele","instructions":"...","tools":["web_search"]}],' +
          '"update":[{"slug":"...","instructions":"..."}],"retire":["slug"]}\n' +
          "Regras: topics = assuntos concretos do dia (1 a 3 palavras, minúsculas), no máximo 6. " +
          "style = como falar com ele (tamanho das respostas, emojis, formalidade, apelidos), até 250 caracteres; repita o atual se nada mudou. " +
          `agent_notes = só para agentes que trabalharam hoje (ids: ${SPECIALISTS.map((s) => s.id).join(", ")}), o que ele aprendeu sobre o cliente (preferências, cidade, marcas, onde buscar), até 300 caracteres; a nota substitui a atual, então mantenha o que já estava nela e ainda vale; lista vazia se nada novo. ` +
          `tabs.enable só se o uso pede (${Object.entries(OPTIONAL).map(([k, v]) => `${k}: ${v.desc}`).join("; ")}). ` +
          `tabs.custom só para um assunto que se repete muito e merece uma tela (máximo 1 por noite e 3 no total): ícone em ${TAB_ICONS.join(", ")}; widgets em ${TAB_WIDGETS.join(", ")}. ` +
          `create só para assunto que já aparece em ${MIN_DAYS}+ dias nos acumulados e é recorrente hoje, que um especialista atenderia melhor que o time geral e que nenhum agente sob medida dele já cobre; ` +
          `no máximo 1 por dia e ${MAX_AGENTS} no total. persona = apelido curto e simpático de personagem (ex.: Pipoca, Fit, Zé Viagem). instructions: 3 a 5 frases práticas com o que esse cliente costuma querer (cidade, marcas, faixa de preço, horários) e onde buscar. ` +
          "update só se aprendeu algo novo e útil sobre o gosto dele. retire agentes sem uso há muito tempo. Na dúvida, não mude: listas vazias são a resposta normal.",
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
      `INSERT INTO client_agents (user_id, slug, name, focus, instructions, tools, persona, face) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, slug) DO UPDATE SET active = true, focus = $4, instructions = $5, tools = $6, persona = COALESCE(client_agents.persona, $7), updated_at = now()
       WHERE client_agents.origin = 'melhoria'`,
      [
        userId,
        slug,
        String(c.name).slice(0, 40),
        String(c.focus ?? c.topic).slice(0, 200),
        String(c.instructions).slice(0, 1500),
        toolNames,
        String(c.persona ?? c.name).slice(0, 24),
        JSON.stringify(faceFor(`${userId}:${slug}`)),
      ],
    );
    created++;
  }
  for (const u of (plan.update ?? []).slice(0, 3)) {
    if (!u.instructions) continue;
    const res = await query("UPDATE client_agents SET instructions = $3, updated_at = now() WHERE user_id = $1 AND slug = $2 AND active AND origin = 'melhoria'", [
      userId,
      String(u.slug),
      String(u.instructions).slice(0, 1500),
    ]);
    updated += res.rowCount ?? 0;
  }
  for (const slug of (plan.retire ?? []).slice(0, 3)) {
    // só aposenta o que ela mesma criou e tem pelo menos uma semana; agente que a pessoa pediu só sai a pedido dela
    const res = await query(
      "UPDATE client_agents SET active = false WHERE user_id = $1 AND slug = $2 AND origin = 'melhoria' AND created_at < now() - interval '7 days'",
      [userId, String(slug)],
    );
    retired += res.rowCount ?? 0;
  }
  // como falar com a pessoa e o que cada agente aprendeu
  if (typeof plan.style === "string" && plan.style.trim()) await query("UPDATE users SET style_notes = $2 WHERE id = $1", [userId, plan.style.trim().slice(0, 300)]);
  const validAgents = new Set(SPECIALISTS.map((s) => s.id));
  for (const n of (Array.isArray(plan.agent_notes) ? plan.agent_notes : []).slice(0, 5)) {
    if (!validAgents.has(n?.agent) || !n?.note) continue;
    await query(
      `INSERT INTO agent_notes (user_id, agent, note) VALUES ($1, $2, $3) ON CONFLICT (user_id, agent) DO UPDATE SET note = $3, updated_at = now()`,
      [userId, n.agent, String(n.note).slice(0, 400)],
    );
  }
  // abas do app: libera módulos e no máximo uma aba sob medida por noite
  const enable = (plan.tabs?.enable ?? []).filter((m: string) => m in OPTIONAL);
  const custom = (plan.tabs?.custom ?? []).slice(0, 1);
  if (enable.length || custom.length) {
    await saveTabs(userId, {
      modules: [...tabs.modules, ...enable],
      custom: [...tabs.custom, ...custom].slice(0, 3),
    });
  }
  await tracer.finish(JSON.stringify({ created, updated, retired, topics: (plan.topics ?? []).map((t: any) => t.topic), tabs: enable, custom: custom.map((c: any) => c.title) }));
  return { created, updated, retired };
}
