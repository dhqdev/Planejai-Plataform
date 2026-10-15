import type { FastifyInstance } from "fastify";
import { ERRAND_CHECK_PROMPT } from "../../../agent/errand-check.js";
import { conversaPrompt, errandPrompt } from "../../../agent/errand-agent.js";
import { VISION_PROMPT } from "../../../agent/media.js";
import { forgetPromptOverrides, promptHash, promptOverrides, withPrompt, type PromptOverride } from "../../../agent/prompt-overrides.js";
import { CTO_RULES, ctoSystemPrompt, fillPrompt, specialistSystemPrompt, TEAM_RULES } from "../../../agent/prompts.js";
import { CTO, CTO_TOOL_GROUPS, CTO_TOOLS, SPECIALISTS } from "../../../agent/team.js";
import { SPOKEN } from "../../../agent/tools/audio.js";
import { WRITER } from "../../../agent/tools/pdf.js";
import type { Tool, UserRow } from "../../../agent/tools/types.js";
import { many, one, query } from "../../../db/pool.js";
import type { Errand } from "../../../errands.js";
import { isConnected } from "../../../integrations/registry.js";
import { resolveModel } from "../../../llm/router.js";
import { getSettings } from "../../../settings.js";
import { selfUserId } from "../../../sharing.js";

/**
 * Mapa do time em tela cheia (só o dono): o prompt de cada agente nosso (CTO, especialistas e bastidores), quem
 * fala com quem e o último trabalho de cada um nas conversas do próprio dono. Os agentes criados para clientes
 * ficam de fora: as instruções deles são da pessoa. Editar grava em agent_prompts; restaurar apaga a linha.
 */

type FieldKey = "role" | "instructions";
interface Field {
  key: FieldKey;
  label: string;
  help: string;
  value: string;
  default: string;
  edited: boolean;
}

/** Até onde um prompt editado pode ir (o do CTO padrão tem ~9 mil caracteres). */
const MAX_PROMPT_CHARS = 30_000;
const MAX_ROLE_CHARS = 1_200;

const SAMPLE_USER: UserRow = { id: "exemplo", phone: "5500000000000", name: "Pessoa de exemplo", status: "active", timezone: null, profile: {} };
const sampleErrand = (kind: Errand["kind"]) =>
  ({
    kind,
    place: kind === "conversa" ? "Maria (amiga)" : "Pet Shop do bairro",
    goal: kind === "conversa" ? "A Maria está gripada; ver como ela está e ajudar no que der." : "Saber se tem banho e tosa amanhã às 18h para um shih-tzu.",
    allowed: kind === "conversa" ? null : "marcar amanhã às 18h",
    sent: 0,
    agent: kind === "conversa" ? "saude" : null,
  }) as unknown as Errand;

/** Agentes de bastidor: não conversam com a pessoa, fazem uma parte do trabalho para o time. */
interface Backstage {
  id: string;
  name: string;
  persona: string;
  icon: string;
  route: string;
  summary: string;
  /** texto padrão editável; sem ele o prompt é montado na hora e só dá para ver */
  base?: string;
  /** prompt de exemplo quando não é editável */
  sample?: () => string;
  /** quem aciona: ferramenta (quem tem a ferramenta) ou um agente fixo */
  via: { tool?: string; from?: string; label: string }[];
  /** para quem devolve */
  to?: { id: string; label: string }[];
  readOnly?: string;
  warn?: string;
}

const BACKSTAGE: Backstage[] = [
  {
    id: "visao",
    name: "Leitor de mídia",
    persona: "Lupa",
    icon: "eye",
    route: "vision",
    summary: "Descreve foto, comprovante e documento escaneado uma vez só. O CTO e o Financeiro recebem o texto pronto, nunca a imagem.",
    base: VISION_PROMPT,
    via: [{ from: "pessoa", label: "foto ou documento" }],
    to: [{ id: "cto", label: "descrição pronta" }],
    warn: "A linha FINANCEIRO: é lida pelo sistema para lançar comprovantes. Mude o texto em volta, mas mantenha esse formato.",
  },
  {
    id: "redator_pdf",
    name: "Redator de PDF",
    persona: "Pena",
    icon: "file",
    route: "writer",
    summary: "Escreve o texto inteiro do PDF a partir do pedido (make_pdf). Quem chama só passa o tema e o tom.",
    base: WRITER,
    via: [{ tool: "make_pdf", label: "make_pdf" }],
    warn: "O sistema monta o PDF pelas linhas SUBTÍTULO:, CAPA: e ## das seções. Mantenha esse formato.",
  },
  {
    id: "redator_audio",
    name: "Redator de áudio",
    persona: "Voz",
    icon: "send",
    route: "writer",
    summary: "Escreve o texto falado das mensagens de voz longas (make_audio com brief).",
    base: SPOKEN,
    via: [{ tool: "make_audio", label: "make_audio" }],
  },
  {
    id: "confere_recado",
    name: "Conferente de recados",
    persona: "Fiscal",
    icon: "shield",
    route: "errand_check",
    summary: "Confere cada recado antes de sair para um estabelecimento: barra ofensa, trote, spam e pedido estranho.",
    base: ERRAND_CHECK_PROMPT,
    via: [{ tool: "errand_start", label: "antes de enviar" }],
    warn: 'Responda sempre só JSON {"ok":true} ou {"ok":false,...}: o sistema lê esse formato.',
  },
  {
    id: "recado",
    name: "Recado no estabelecimento",
    persona: "Recadeiro",
    icon: "send",
    route: "agent:recados",
    summary: "Conversa pelo WhatsApp com o lugar (petshop, salão, clínica) em nome da pessoa, depois do sim dela.",
    sample: () => errandPrompt(sampleErrand("recado"), "Ana", "America/Sao_Paulo"),
    via: [{ tool: "errand_start", label: "errand_start" }],
    readOnly: "Montado na hora com o lugar, o objetivo e o que a pessoa liberou. Aqui aparece com um recado de exemplo.",
  },
  {
    id: "conversa",
    name: "Conversa por ela",
    persona: "Amigo do time",
    icon: "heart",
    route: "agent:recados",
    summary: "Um especialista conversa com alguém que a pessoa pediu (ex.: a amiga doente) e avisa ela se for sério.",
    sample: () => conversaPrompt(sampleErrand("conversa"), "Ana", "America/Sao_Paulo"),
    via: [{ tool: "conversa_start", label: "conversa_start" }],
    readOnly: "Montado na hora com quem é, o que a pessoa contou e o jeito do especialista. Aqui aparece com uma conversa de exemplo.",
  },
  {
    id: "reuniao",
    name: "Reunião noturna",
    persona: "Juvenal às 19h",
    icon: "clock",
    route: "improve",
    summary: "Toda noite o CTO revê o dia de cada pessoa: guarda fatos, ajusta o jeito de falar, deixa notas para cada especialista e cria agentes sob medida.",
    via: [],
    to: [{ id: "cto", label: "jeito de falar" }],
    readOnly: "Montado toda noite com os dados do dia de cada pessoa (assuntos, notas, agentes). As notas que ela deixa aparecem no prompt de cada especialista.",
  },
];

/** Quem tem a ferramenta (CTO, inclusive nos grupos por assunto, e especialistas). */
function holders(tool: string) {
  const ids: string[] = [];
  if (CTO_TOOLS.some((t) => t.name === tool) || CTO_TOOL_GROUPS.some((g) => g.tools.some((t) => t.name === tool))) ids.push("cto");
  for (const s of SPECIALISTS) if (s.tools.some((t) => t.name === tool)) ids.push(s.id);
  return ids;
}

async function toolList(tools: Tool[], group?: string) {
  return Promise.all(
    tools.map(async (t) => ({ name: t.name, description: t.description, integration: t.integration ?? null, available: !t.integration || (await isConnected(t.integration)), group: group ?? null })),
  );
}

function field(key: FieldKey, label: string, help: string, base: string, o: PromptOverride | undefined): Field {
  const v = o?.[key];
  const edited = v != null && v.trim() !== "";
  return { key, label, help, value: edited ? v! : base, default: base, edited };
}

/** Prompt padrão de um agente editável (o que o código traria), para conferir o que mudou. */
function baseOf(id: string): string | null {
  if (id === "cto") return CTO_RULES;
  if (id === "_time") return TEAM_RULES;
  const s = SPECIALISTS.find((x) => x.id === id);
  if (s) return `${s.role}\n${s.instructions}`;
  return BACKSTAGE.find((b) => b.id === id)?.base ?? null;
}

export async function studioData() {
  const [settings, ov] = await Promise.all([getSettings(), promptOverrides()]);
  const tz = settings.timezone;
  const team = SPECIALISTS.map((s) => withPrompt(s, ov));
  const meta = (id: string) => {
    const o = ov.get(id);
    const base = baseOf(id);
    return { edited: Boolean(o), updatedAt: o?.updated_at ?? null, baseChanged: Boolean(o?.base_hash && base && o.base_hash !== promptHash(base)) };
  };
  const activity = Object.fromEntries(
    (
      await many(`SELECT agent, COUNT(*)::int AS n FROM execution_steps WHERE type = 'llm' AND started_at > now() - interval '7 days' GROUP BY 1`).catch(() => [])
    ).map((a) => [a.agent, a.n]),
  );
  const model = async (route: string) => (await resolveModel(route).catch(() => null))?.model ?? null;

  const nodes: any[] = [
    {
      id: "pessoa",
      kind: "pessoa",
      name: "Pessoa no WhatsApp",
      persona: "Mensagem chega",
      icon: "phone",
      summary: "Texto, áudio, foto ou documento de quem usa o Planejai. Áudio vira texto e foto vira descrição antes de chegar no CTO.",
      fields: [],
      tools: [],
      preview: "",
      receives: "O que a pessoa manda no WhatsApp (ou no Telegram).",
      returns: "Recebe a resposta do CTO, em até 3 balões, com figurinha, foto, PDF ou áudio quando couber.",
      calls7d: 0,
      edited: false,
    },
    {
      id: "cto",
      kind: "cto",
      name: CTO.name,
      persona: CTO.persona,
      face: CTO.face,
      icon: CTO.icon,
      model: await model("agent:cto"),
      summary: CTO.role,
      fields: [field("instructions", "Prompt do CTO", "Regras fixas que o CTO lê em toda mensagem. Use {assistente} e {mascote} para os nomes.", CTO_RULES, ov.get("cto"))],
      auto: [
        "Regras por assunto (mensagens, mídia, time sob medida e GIF) entram só quando a mensagem toca no assunto.",
        settings.persona ? "Instruções do dono (Configurações) entram logo depois." : "Instruções do dono (Configurações) entram logo depois, quando tiver.",
        "Contexto: data e hora, o time da pessoa, nome, jeito de falar, recados em andamento, memórias e resumo das conversas.",
      ],
      tools: [...(await toolList(CTO_TOOLS)), ...(await Promise.all(CTO_TOOL_GROUPS.map((g) => toolList(g.tools, g.id)))).flat()],
      preview: ctoSystemPrompt({
        rules: ov.get("cto")?.instructions,
        settings,
        user: SAMPLE_USER,
        timezone: tz,
        memories: [{ id: "1", content: "(as memórias da pessoa entram aqui)" }],
        summary: null,
        specialists: team,
        disconnected: [],
      }),
      receives: "As mensagens novas da pessoa (com msg_id), o histórico curto já interpretado e avisos do sistema ([evento do sistema], sim/não de confirmação).",
      returns: "A resposta final para a pessoa. No meio do caminho, conversa com os especialistas pelos ask_*.",
      calls7d: activity.cto ?? 0,
      ...meta("cto"),
    },
    ...(await Promise.all(
      team.map(async (s, i) => {
        const base = SPECIALISTS[i]!;
        return {
          id: s.id,
          kind: "specialist",
          name: s.name,
          persona: s.persona,
          face: s.face,
          icon: s.icon,
          model: await model(s.task ?? `agent:${s.id}`),
          summary: s.role,
          fields: [
            field("role", "Papel (o que o CTO lê para decidir chamar)", "Vai na descrição do ask_ que o CTO vê e na lista de colegas dos outros especialistas.", base.role, ov.get(s.id)),
            field("instructions", "Instruções", "Como ele trabalha: ordem das ferramentas, limites, o que devolver.", base.instructions, ov.get(s.id)),
          ],
          auto: [
            "Regras do time (card próprio no mapa) entram depois das instruções.",
            "Notas das reuniões noturnas sobre a pessoa e o que ela contou no cadastro entram no fim.",
          ],
          tools: [
            ...(await toolList(s.tools)),
            { name: "consult_colega", description: "Pergunta algo direto a um colega do time.", integration: null, available: true, group: "time" },
            { name: "share_with_team", description: "Anota uma descoberta no quadro do time.", integration: null, available: true, group: "time" },
          ],
          preview: specialistSystemPrompt(s, { timezone: tz, user: SAMPLE_USER, settings, teamRules: ov.get("_time")?.instructions }),
          receives: "[CTO] a tarefa completa com o contexto, ou a pergunta de um colega, mais o quadro do time.",
          returns: "Um relatório curto para quem chamou: o que fez, dados, links e media_ids.",
          calls7d: activity[s.id] ?? 0,
          ...meta(s.id),
        };
      }),
    )),
    {
      id: "_time",
      kind: "regras",
      name: "Regras do time",
      persona: "Vale para todos",
      icon: "list",
      summary: "As regras que todo especialista recebe depois das próprias instruções.",
      fields: [field("instructions", "Regras comuns", "Entram no prompt de todos os especialistas. Use {assistente} para o nome do assistente.", TEAM_RULES, ov.get("_time"))],
      tools: [],
      preview: fillPrompt(ov.get("_time")?.instructions?.trim() ? ov.get("_time")!.instructions! : TEAM_RULES, settings.assistantName),
      receives: "Não conversa: é um pedaço do prompt dos especialistas.",
      returns: "",
      calls7d: 0,
      ...meta("_time"),
    },
    ...(await Promise.all(
      BACKSTAGE.map(async (b) => {
        let preview = "";
        try {
          preview = b.base ? (ov.get(b.id)?.instructions?.trim() ? ov.get(b.id)!.instructions! : b.base) : (b.sample?.() ?? "");
        } catch {
          preview = "";
        }
        return {
          id: b.id,
          kind: "bastidor",
          name: b.name,
          persona: b.persona,
          icon: b.icon,
          model: await model(b.route),
          summary: b.summary,
          fields: b.base ? [field("instructions", "Prompt", "Texto que o modelo recebe a cada vez.", b.base, ov.get(b.id))] : [],
          readOnly: b.readOnly ?? null,
          warn: b.warn ?? null,
          tools: [],
          preview,
          receives: b.via.map((v) => v.label).join(", ") || "Roda sozinho toda noite às 19h.",
          returns: b.to?.map((t) => t.label).join(", ") ?? "Devolve o resultado para quem chamou.",
          calls7d: 0,
          ...meta(b.id),
        };
      }),
    )),
  ];

  // quem fala com quem: o CTO com cada especialista, consultas entre colegas que aconteceram e quem aciona os bastidores
  const counts = await many(
    `SELECT p.agent AS "from", s.agent AS "to", COUNT(*)::int AS n FROM execution_steps s JOIN execution_steps p ON p.id = s.parent_id
      WHERE s.type = 'llm' AND p.type = 'delegate' AND s.agent <> p.agent AND s.started_at > now() - interval '7 days' GROUP BY 1, 2`,
  ).catch(() => []);
  const n = (a: string, b: string) => counts.find((c) => c.from === a && c.to === b)?.n ?? 0;
  const edges: { from: string; to: string; kind: string; label: string; n: number }[] = [{ from: "pessoa", to: "cto", kind: "mensagem", label: "mensagem", n: 0 }];
  for (const s of team) edges.push({ from: "cto", to: s.id, kind: "ask", label: `ask_${s.id}`, n: n("cto", s.id) });
  for (const c of counts) if (c.from !== "cto" && team.some((s) => s.id === c.from) && team.some((s) => s.id === c.to)) edges.push({ from: c.from, to: c.to, kind: "consult", label: "consult_colega", n: c.n });
  for (const b of BACKSTAGE) {
    for (const v of b.via) for (const from of v.tool ? holders(v.tool) : v.from ? [v.from] : []) edges.push({ from, to: b.id, kind: "usa", label: v.label, n: 0 });
    for (const t of b.to ?? []) if (!b.via.some((v) => v.from === t.id)) edges.push({ from: b.id, to: t.id, kind: "usa", label: t.label, n: 0 });
  }
  // reunião noturna deixa nota para cada especialista
  for (const s of team) edges.push({ from: "reuniao", to: s.id, kind: "nota", label: "nota da noite", n: 0 });
  return { nodes, edges };
}

/** Texto padrão de cada campo editável (vazio = agente sem prompt editável). */
function defaultsOf(id: string): Partial<Record<FieldKey, string>> {
  if (id === "cto") return { instructions: CTO_RULES };
  if (id === "_time") return { instructions: TEAM_RULES };
  const s = SPECIALISTS.find((x) => x.id === id);
  if (s) return { role: s.role, instructions: s.instructions };
  const b = BACKSTAGE.find((x) => x.id === id)?.base;
  return b ? { instructions: b } : {};
}

/** Onde fica o último trabalho de cada agente em execution_steps (filtro extra além do dono). */
function stepFilter(id: string): { sql: string; args: unknown[] } {
  switch (id) {
    case "visao":
      return { sql: "s.agent = 'cto' AND s.type = 'tool' AND s.name IN ('descrever_imagem', 'ler_documento')", args: [] };
    case "redator_pdf":
      return { sql: "s.agent = 'redator' AND s.name = 'texto do PDF'", args: [] };
    case "redator_audio":
      return { sql: "s.agent = 'redator' AND s.name = 'texto do áudio'", args: [] };
    case "confere_recado":
      return { sql: "s.type = 'llm' AND s.name = 'trava: recado'", args: [] };
    case "recado":
    case "conversa":
      return { sql: "s.agent = 'recados' AND s.type = 'llm' AND e.trigger = 'errand'", args: [] };
    case "reuniao":
      return { sql: "s.type = 'llm' AND s.name = 'reunião noturna do time'", args: [] };
    default:
      return { sql: "s.agent = $2 AND s.type = 'llm' AND s.name LIKE $2 || ' · passo%'", args: [id] };
  }
}

export function studioRoutes(api: FastifyInstance) {
  api.get("/api/studio", async () => studioData());

  api.put<{ Params: { id: string }; Body: { role?: string | null; instructions?: string | null } }>("/api/studio/:id", async (req, reply) => {
    const defaults = defaultsOf(req.params.id);
    if (defaults.instructions == null) return reply.code(404).send({ error: "Este agente não tem prompt editável." });
    const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim() : "");
    const role = defaults.role != null ? clean(req.body?.role) : "";
    const instructions = clean(req.body?.instructions);
    if (role.length > MAX_ROLE_CHARS) return reply.code(400).send({ error: `O papel passa de ${MAX_ROLE_CHARS} caracteres.` });
    if (instructions.length > MAX_PROMPT_CHARS) return reply.code(400).send({ error: `O prompt passa de ${MAX_PROMPT_CHARS.toLocaleString("pt-BR")} caracteres.` });
    // vazio ou igual ao padrão = sem edição naquele campo (volta a seguir o código)
    const newRole = role && role !== defaults.role ? role : null;
    const newText = instructions && instructions !== defaults.instructions ? instructions : null;
    if (!newRole && !newText) await query("DELETE FROM agent_prompts WHERE agent = $1", [req.params.id]);
    else
      await query(
        `INSERT INTO agent_prompts (agent, role, instructions, base_hash, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (agent) DO UPDATE SET role = EXCLUDED.role, instructions = EXCLUDED.instructions, base_hash = EXCLUDED.base_hash, updated_at = now()`,
        [req.params.id, newRole, newText, promptHash(baseOf(req.params.id)!)],
      );
    forgetPromptOverrides();
    return { ok: true, edited: Boolean(newRole || newText) };
  });

  api.delete<{ Params: { id: string } }>("/api/studio/:id", async (req) => {
    await query("DELETE FROM agent_prompts WHERE agent = $1", [req.params.id]);
    forgetPromptOverrides();
    return { ok: true };
  });

  // último trabalho do agente, só nas conversas do próprio dono (as de clientes ficam só em métrica, em Execuções)
  api.get<{ Params: { id: string } }>("/api/studio/:id/last", async (req) => {
    const self = await selfUserId(req.account);
    if (!self) return { run: null, reason: "Ligue seu WhatsApp ao painel para ver o trabalho dos agentes nas suas conversas." };
    const f = stepFilter(req.params.id);
    const run = await one(
      `SELECT s.execution_id, s.started_at, s.name, s.model, s.status, s.input, s.output, s.error, s.tokens_in, s.tokens_out, s.cost_usd, s.duration_ms, e.content_purged
         FROM execution_steps s JOIN executions e ON e.id = s.execution_id
        WHERE e.user_id = $1 AND ${f.sql} ORDER BY s.id DESC LIMIT 1`,
      [self, ...f.args],
    );
    return { run: run ?? null, reason: run ? null : "Ele ainda não trabalhou nas suas conversas (ou o registro já foi apagado)." };
  });
}

