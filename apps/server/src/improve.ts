import { CLIENT_AGENT_TOOLS, faceFor, slugify, SPECIALISTS } from "./agent/team.js";
import { getTabs, OPTIONAL, saveTabs, TAB_ICONS, TAB_WIDGETS } from "./tabs.js";
import { Tracer } from "./agent/trace.js";
import { many, one, query } from "./db/pool.js";
import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";
import { MEMORY_CATEGORIES, normalizeCategory, rememberFact } from "./memories.js";
import { notify } from "./notifications.js";
import { planAccess } from "./plan-access.js";

/**
 * Reunião noturna (19h): o CTO revisa o dia de cada cliente com o time e todo mundo melhora para ele.
 * Uma única chamada barata por cliente que usou o assistente no dia decide: como falar com a pessoa,
 * o que cada agente aprendeu sobre ela, o que entra em "O que ele sabe de mim", quais abas liberar no app
 * e se nasce um agente sob medida. Cada reunião vira uma ata (improve_meetings) que a pessoa vê em Reuniões.
 * Assuntos se acumulam dia a dia; um agente só nasce quando o assunto se repete em dias diferentes.
 */

const MAX_AGENTS = 3;
/** basta uma conversa no dia para a reunião aprender algo; agente novo continua exigindo assunto repetido */
const MIN_EXECUTIONS = 1;
/** menos pedidos que isso no dia = dia magro: reunião só a cada LIGHT_EVERY_DAYS dias (folga de 6 h para o horário da fila) */
const LIGHT_ASKS = 3;
const LIGHT_EVERY_DAYS = 3;
/** fatos conhecidos que vão para a reunião (numerados, para ela corrigir ou dar assunto sem gastar com ids) */
const KNOWN_FACTS = 50;
/** atas guardadas por pessoa */
const KEEP_MEETINGS = 60;

type Result = { created: number; updated: number; retired: number; learned: number; meetingId?: string };
/** dias diferentes em que o assunto apareceu antes de virar agente */
const MIN_DAYS = 2;

export async function dailyImprovement(log?: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  // quem conversou pouco no dia (menos de LIGHT_ASKS pedidos) só tem reunião a cada LIGHT_EVERY_DAYS dias: economiza a chamada
  // em dia magro; o que a pessoa contou nesses dias continua no resumo da conversa e nas memórias salvas na hora
  const users = await many(
    `SELECT id FROM (
       SELECT u.id,
              (SELECT COUNT(*) FROM executions e WHERE e.user_id = u.id AND e.trigger = 'message' AND e.started_at > now() - interval '24 hours') AS asks,
              (SELECT MAX(m.created_at) FROM improve_meetings m WHERE m.user_id = u.id) AS last_meeting
         FROM users u WHERE u.status = 'active') x
      WHERE asks >= $1 AND (asks >= $2 OR last_meeting IS NULL OR last_meeting < now() - make_interval(hours => $3))`,
    [MIN_EXECUTIONS, LIGHT_ASKS, LIGHT_EVERY_DAYS * 24 - 6],
  );
  const out = { users: users.length, created: 0, updated: 0, retired: 0, learned: 0 };
  for (const u of users) {
    try {
      const r = await improveUser(u.id);
      out.created += r.created;
      out.updated += r.updated;
      out.retired += r.retired;
      out.learned += r.learned;
    } catch (err) {
      log?.error({ err, userId: u.id }, "falha na melhoria diária");
    }
  }
  log?.info(out, "melhoria diária concluída");
  return out;
}

export async function improveUser(userId: string): Promise<Result> {
  const asks = await many(
    `SELECT left(regexp_replace(input, '\\s+', ' ', 'g'), 180) AS t FROM executions
      WHERE user_id = $1 AND trigger = 'message' AND started_at > now() - interval '24 hours' AND input IS NOT NULL ORDER BY started_at LIMIT 50`,
    [userId],
  );
  if (asks.length < MIN_EXECUTIONS) return { created: 0, updated: 0, retired: 0, learned: 0 };
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
  // o básico (perfil) sempre entra; o resto, os mais recentes
  const known = await many<{ id: string; content: string; category: string | null }>(
    `SELECT id, content, category FROM memories WHERE user_id = $1
      ORDER BY (category = 'perfil' OR 'perfil' = ANY(tags)) DESC, created_at DESC LIMIT $2`,
    [userId, KNOWN_FACTS],
  );
  const summary = await one("SELECT left(summary, 800) AS s FROM conversations WHERE user_id = $1 AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 1", [userId]);
  const categories = Object.keys(MEMORY_CATEGORIES).join(", ");

  // a reunião noturna é otimização da plataforma: o custo aparece no uso, mas não sai da carteira de grãos da pessoa
  const tracer = await Tracer.start({ trigger: "improve", userId, input: `${asks.length} pedidos nas últimas 24h`, noCharge: true });
  const step = await tracer.step({ agent: "cto", type: "llm", name: "reunião noturna do time" });
  const prompt =
    `Pedidos do cliente nas últimas 24h (um por linha):\n${asks.map((a) => `- ${a.t}`).join("\n")}\n\n` +
    (summary?.s ? `Resumo das conversas anteriores: ${summary.s}\n` : "") +
    `O que já sabemos dele (n. [assunto] fato):\n${known.length ? known.map((m, i) => `${i + 1}. [${m.category ?? "sem assunto"}] ${m.content}`).join("\n") : "nada ainda"}\n\n` +
    `Assuntos acumulados (assunto, pontuação, dias em que apareceu): ${topics.length ? topics.map((t) => `${t.topic} (${t.score}, ${t.days}d)`).join("; ") : "nenhum"}\n` +
    `Agentes do time que trabalharam hoje: ${usedAgents.map((a) => `${a.agent} (${a.n}x)`).join(", ") || "só o CTO"}\n` +
    `Agentes sob medida que ele já tem: ${agents.length ? agents.map((a) => `${a.slug}: ${a.focus} (usado ${a.uses}x)`).join("; ") : "nenhum"}\n` +
    `Jeito de falar com ele hoje: ${person?.style_notes ?? "nada anotado"}\n` +
    `Notas atuais dos agentes: ${notes.map((n) => `${n.agent}: ${n.note}`).join(" | ") || "nenhuma"}\n` +
    `Abas extras já liberadas no app: ${[...tabs.modules, ...tabs.custom.map((c) => `aba "${c.title}"`)].join(", ") || "nenhuma (só o essencial)"}\n` +
    `Ferramentas que um agente sob medida pode ter: ${tools}`;
  const model = await resolveModel("improve");
  const r = await chatCompletion(model, {
    // a ata e os fatos não podem sair cortados (JSON pela metade = reunião perdida), mesmo com teto menor na tela Modelos
    maxTokens: Math.max(model.maxTokens ?? 0, 1400),
    responseFormat: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Você é o CTO de um time de agentes de um assistente pessoal no WhatsApp, na reunião noturna sobre UM cliente. " +
          "Todos melhoram para ele, gastando pouco. Responda só JSON:\n" +
          '{"summary":"...","facts":[{"category":"gostos","fact":"..."}],"fix":[{"n":3,"fact":"..."}],"sort":[{"n":5,"category":"rotina"}],' +
          '"topics":[{"topic":"cinema","weight":1-5}],"style":"...","agent_notes":[{"agent":"financeiro","note":"..."}],' +
          '"tabs":{"enable":["memorias"],"custom":[{"title":"Academia","icon":"heart","widgets":["categories","reminders"]}]},' +
          '"create":[{"topic":"cinema","name":"Cinema","persona":"Pipoca","focus":"sessões, estreias e ingressos na cidade dele","instructions":"...","tools":["web_search"]}],' +
          '"update":[{"slug":"...","instructions":"..."}],"retire":["slug"]}\n' +
          "Regras: summary = a ata da reunião para o próprio cliente ler, em segunda pessoa e tom leve, 1 a 3 frases: o que o time percebeu hoje e o que vai fazer diferente. Sem citar mensagens, sem dados sensíveis. " +
          `facts = o que aprendeu hoje sobre ELE e vale por meses (quem é, cidade, bairro, família e nomes, pets, trabalho, rotina e horários, gostos, comidas, marcas, lojas, saúde, bancos e hábitos de dinheiro, metas), cada um uma frase curta em terceira pessoa; no máximo 8; nunca repita o que já sabemos; nada passageiro (lembrete, compromisso de um dia, pedido isolado); assunto em ${categories}. ` +
          "fix = fato que já sabemos e que hoje mudou (n do fato e o texto novo). sort = assunto para os fatos marcados sem assunto, no máximo 10. " +
          "topics = assuntos concretos do dia (1 a 3 palavras, minúsculas), no máximo 6. " +
          "style = como falar com ele (tamanho das respostas, emojis, formalidade, apelidos), até 250 caracteres; repita o atual se nada mudou. " +
          `agent_notes = só para agentes que trabalharam hoje (ids: ${SPECIALISTS.map((s) => s.id).join(", ")}), o que ele aprendeu sobre o cliente (preferências, cidade, marcas, onde buscar), até 300 caracteres; a nota substitui a atual, então mantenha o que já estava nela e ainda vale; lista vazia se nada novo. ` +
          `tabs.enable só se o uso pede (${Object.entries(OPTIONAL).map(([k, v]) => `${k}: ${v.desc}`).join("; ")}). ` +
          `tabs.custom só para um assunto que se repete muito e merece uma tela (máximo 1 por noite e 3 no total): ícone em ${TAB_ICONS.join(", ")}; widgets em ${TAB_WIDGETS.join(", ")}. ` +
          `create só para assunto que já aparece em ${MIN_DAYS}+ dias nos acumulados e é recorrente hoje, que um especialista atenderia melhor que o time geral e que nenhum agente sob medida dele já cobre; ` +
          `no máximo 1 por dia e ${MAX_AGENTS} no total. persona = nome de pessoa engraçado que combine com o assunto (ex.: Valdirene para academia, Seu Arlindo para viagens). instructions: 3 a 5 frases práticas com o que esse cliente costuma querer (cidade, marcas, faixa de preço, horários) e onde buscar. ` +
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
    return { created: 0, updated: 0, retired: 0, learned: 0 };
  }

  // "O que ele sabe de mim": fatos novos, fatos que mudaram e assunto dos antigos
  const learned: { category: string; fact: string; changed?: boolean }[] = [];
  for (const f of (Array.isArray(plan.facts) ? plan.facts : []).slice(0, 8)) {
    const fact = String(f?.fact ?? "").trim();
    if (fact.length < 4) continue;
    const category = normalizeCategory(f.category) ?? "outros";
    const res = await rememberFact(userId, fact, { category, source: "reuniao" });
    if (res.created || res.updated) learned.push({ category, fact: fact.slice(0, 400) });
  }
  for (const f of (Array.isArray(plan.fix) ? plan.fix : []).slice(0, 5)) {
    const old = known[Number(f?.n) - 1];
    const fact = String(f?.fact ?? "").trim();
    if (!old || fact.length < 4 || fact === old.content) continue;
    await rememberFact(userId, fact, { replacesId: old.id, category: old.category, source: "reuniao" });
    learned.push({ category: old.category ?? "outros", fact: fact.slice(0, 400), changed: true });
  }
  for (const f of (Array.isArray(plan.sort) ? plan.sort : []).slice(0, 10)) {
    const old = known[Number(f?.n) - 1];
    const category = normalizeCategory(f?.category);
    if (old && !old.category && category) await query("UPDATE memories SET category = $3 WHERE id = $1 AND user_id = $2", [old.id, userId, category]);
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
  const changes = {
    style: null as string | null,
    agent_notes: [] as { agent: string; note: string }[],
    created: [] as { name: string; persona: string; focus: string }[],
    updated: [] as string[],
    retired: [] as string[],
    tabs: [] as string[],
    custom: [] as string[],
    topics: [] as string[],
  };
  const active = (await one("SELECT COUNT(*)::int AS n FROM client_agents WHERE user_id = $1 AND active", [userId])).n as number;
  // agente sob medida nasce só para quem tem o Completo (plan-access.ts)
  const owner = await one("SELECT * FROM users WHERE id = $1", [userId]);
  const canCreate = owner ? (await planAccess(owner)).customAgents : false;
  for (const c of canCreate ? (plan.create ?? []).slice(0, 1) : []) {
    if (active + created >= MAX_AGENTS) break;
    const topic = await one("SELECT days FROM user_topics WHERE user_id = $1 AND topic = $2", [userId, String(c.topic ?? "").toLowerCase().trim()]);
    if (!topic || topic.days < MIN_DAYS) continue; // a IA não decide sozinha: o assunto tem que se repetir de verdade
    const slug = slugify(c.name ?? c.topic ?? "");
    const toolNames = (Array.isArray(c.tools) ? c.tools : []).filter((n: string) => n in CLIENT_AGENT_TOOLS).slice(0, 6);
    if (!slug || !toolNames.length || !c.instructions) continue;
    // agente com o mesmo nome que a pessoa pediu ou ligou na loja não é tocado: nada de anunciar "novo agente" que não nasceu
    const res = await query(
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
    if (!res.rowCount) continue;
    created++;
    changes.created.push({ name: String(c.name).slice(0, 40), persona: String(c.persona ?? c.name).slice(0, 24), focus: String(c.focus ?? c.topic).slice(0, 200) });
  }
  for (const u of (plan.update ?? []).slice(0, 3)) {
    if (!u.instructions) continue;
    const res = await query("UPDATE client_agents SET instructions = $3, updated_at = now() WHERE user_id = $1 AND slug = $2 AND active AND origin = 'melhoria'", [
      userId,
      String(u.slug),
      String(u.instructions).slice(0, 1500),
    ]);
    updated += res.rowCount ?? 0;
    if (res.rowCount) changes.updated.push(agentName(agents, String(u.slug)));
  }
  for (const slug of (plan.retire ?? []).slice(0, 3)) {
    // só aposenta o que ela mesma criou e tem pelo menos uma semana; agente que a pessoa pediu só sai a pedido dela
    const res = await query(
      "UPDATE client_agents SET active = false WHERE user_id = $1 AND slug = $2 AND origin = 'melhoria' AND created_at < now() - interval '7 days'",
      [userId, String(slug)],
    );
    retired += res.rowCount ?? 0;
    if (res.rowCount) changes.retired.push(agentName(agents, String(slug)));
  }
  // como falar com a pessoa e o que cada agente aprendeu
  if (typeof plan.style === "string" && plan.style.trim()) {
    const style = plan.style.trim().slice(0, 300);
    if (style !== person?.style_notes) changes.style = style;
    await query("UPDATE users SET style_notes = $2 WHERE id = $1", [userId, style]);
  }
  const oldNotes = new Map(notes.map((n) => [n.agent, n.note]));
  const validAgents = new Set(SPECIALISTS.map((s) => s.id));
  for (const n of (Array.isArray(plan.agent_notes) ? plan.agent_notes : []).slice(0, 5)) {
    if (!validAgents.has(n?.agent) || !n?.note) continue;
    await query(
      `INSERT INTO agent_notes (user_id, agent, note) VALUES ($1, $2, $3) ON CONFLICT (user_id, agent) DO UPDATE SET note = $3, updated_at = now()`,
      [userId, n.agent, String(n.note).slice(0, 400)],
    );
    if (oldNotes.get(n.agent) !== String(n.note).slice(0, 400)) changes.agent_notes.push({ agent: n.agent, note: String(n.note).slice(0, 400) });
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
  changes.tabs = enable.filter((m: string) => !tabs.modules.includes(m)).map((m: string) => OPTIONAL[m]!.label);
  changes.custom = custom.map((c: any) => String(c.title ?? "")).filter(Boolean);
  changes.topics = (plan.topics ?? []).map((t: any) => String(t.topic ?? "").toLowerCase().trim()).filter(Boolean).slice(0, 6);

  // a ata: o que a pessoa lê em Reuniões (só o que mudou, nunca a conversa)
  const summaryText = typeof plan.summary === "string" && plan.summary.trim() ? plan.summary.trim().slice(0, 600) : null;
  const meeting = await one<{ id: string }>(
    "INSERT INTO improve_meetings (user_id, execution_id, asks, summary, learned, changes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [userId, tracer.executionId, asks.length, summaryText, JSON.stringify(learned), JSON.stringify(changes)],
  );
  await query(
    "DELETE FROM improve_meetings WHERE user_id = $1 AND id NOT IN (SELECT id FROM improve_meetings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)",
    [userId, KEEP_MEETINGS],
  );
  const news = learned.length + created + updated + retired + changes.tabs.length + changes.custom.length;
  if (news) {
    const parts = [
      learned.length ? `aprendeu ${learned.length} ${learned.length === 1 ? "coisa" : "coisas"} sobre você` : "",
      created ? `criou ${created === 1 ? "um agente" : `${created} agentes`}` : "",
    ].filter(Boolean);
    await notify({
      userId,
      kind: "reuniao",
      title: parts.length ? `Reunião das 19h: o time ${parts.join(" e ")}` : "Reunião das 19h: o time se ajustou para você",
      body: summaryText,
      link: "/reunioes",
    });
  }
  await tracer.finish(JSON.stringify({ created, updated, retired, learned: learned.length, topics: changes.topics, tabs: enable, custom: changes.custom }));
  return { created, updated, retired, learned: learned.length, meetingId: meeting?.id };
}

function agentName(agents: { slug: string; name: string; persona: string | null }[], slug: string) {
  const a = agents.find((x) => x.slug === slug);
  return a ? (a.persona ? `${a.persona} (${a.name})` : a.name) : slug;
}
