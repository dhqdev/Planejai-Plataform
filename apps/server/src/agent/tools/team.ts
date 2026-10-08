import { many, one, query } from "../../db/pool.js";
import { notify } from "../../notifications.js";
import { delegationTool, noteText } from "../collab.js";
import { availableTools } from "../runner.js";
import { CLIENT_AGENT_TOOLS, clientAgentDef, faceFor, MAX_CLIENT_AGENTS, slugify, SPECIALISTS } from "../team.js";
import { defineTool, obj, type Tool } from "./types.js";

/**
 * O time de cada pessoa é dela: além dos especialistas fixos, o CTO cria, ajusta e aposenta agentes sob medida
 * no meio da conversa ("cria um agente pra cuidar do meu treino"), sem esperar a reunião noturna.
 * Um agente sob medida só enxerga os dados da própria pessoa e só ganha ferramentas de CLIENT_AGENT_TOOLS.
 */

const TOOL_NAMES = Object.keys(CLIENT_AGENT_TOOLS);

function pickTools(names: unknown) {
  return [...new Set((Array.isArray(names) ? names : []).map(String).filter((n) => n in CLIENT_AGENT_TOOLS))].slice(0, 10);
}

const ownSlug = (agent: string) => slugify(String(agent ?? "").replace(/^c_/, ""));

export const teamCreateAgent = defineTool<{
  name: string;
  persona?: string;
  focus: string;
  instructions: string;
  tools: string[];
  first_task?: string;
}>({
  name: "team_create_agent",
  description:
    "Cria um especialista novo só para esta pessoa (ou refaz um que ela já tem com o mesmo nome). Use quando ela pedir um agente " +
    "ou quando um assunto dela volta sempre e pede um jeito próprio de atender (treino, dieta, uma loja, um projeto, estudos). Não crie para pedido avulso. " +
    "Com first_task ele já faz a primeira tarefa agora e devolve o relatório; nas próximas mensagens aparece como ask_c_<nome>. " +
    `Ferramentas possíveis: ${TOOL_NAMES.join(", ")}.`,
  parameters: obj(
    {
      name: { type: "string", description: "Nome curto da área, ex.: Treino, Viagens, Loja" },
      persona: { type: "string", description: "Apelido simpático de personagem, ex.: Fit, Zé Viagem" },
      focus: { type: "string", description: "Uma frase: do que ele cuida para esta pessoa" },
      instructions: {
        type: "string",
        description: "3 a 6 frases práticas: o que ela costuma querer, preferências (cidade, marcas, faixa de preço, horários), onde buscar e como entregar",
      },
      tools: { type: "array", items: { type: "string" }, description: "Só as que ele precisa mesmo (1 a 6)" },
      first_task: { type: "string", description: "Tarefa completa para ele fazer já (opcional)" },
    },
    ["name", "focus", "instructions", "tools"],
  ),
  async run(args, ctx) {
    const slug = slugify(args.name ?? "");
    const tools = pickTools(args.tools);
    const instructions = String(args.instructions ?? "").trim();
    if (!slug) return { ok: false, error: "Dê um nome ao agente" };
    if (SPECIALISTS.some((s) => s.id === slug)) return { ok: false, error: `Já existe ${slug} no time fixo. Para ajustar como ele atende esta pessoa, use team_adjust_agent.` };
    if (!tools.length) return { ok: false, error: `Escolha ao menos uma ferramenta válida: ${TOOL_NAMES.join(", ")}` };
    if (instructions.length < 40) return { ok: false, error: "Instruções curtas demais: escreva o que a pessoa costuma querer e como atender" };

    const existing = await one("SELECT id, active FROM client_agents WHERE user_id = $1 AND slug = $2", [ctx.user.id, slug]);
    if (!existing?.active) {
      const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM client_agents WHERE user_id = $1 AND active", [ctx.user.id]);
      if ((n?.n ?? 0) >= MAX_CLIENT_AGENTS)
        return { ok: false, error: `A pessoa já tem ${n!.n} agentes sob medida (limite ${MAX_CLIENT_AGENTS}). Veja com team_list e ofereça aposentar um.` };
    }
    const row = await one(
      `INSERT INTO client_agents (user_id, slug, name, focus, instructions, tools, persona, face, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pedido')
       ON CONFLICT (user_id, slug) DO UPDATE SET active = true, name = $3, focus = $4, instructions = $5, tools = $6,
         persona = COALESCE($7, client_agents.persona), updated_at = now()
       RETURNING *`,
      [
        ctx.user.id,
        slug,
        String(args.name).trim().slice(0, 40),
        String(args.focus).trim().slice(0, 200),
        instructions.slice(0, 1500),
        tools,
        args.persona ? String(args.persona).trim().slice(0, 24) : null,
        JSON.stringify(faceFor(`${ctx.user.id}:${slug}`)),
      ],
    );
    const def = clientAgentDef(row);
    // entra no time desta execução: os colegas já podem consultá-lo
    ctx.room.team = [...ctx.room.team.filter((a) => a.id !== def.id), def];
    if (!existing) await notify({ userId: ctx.user.id, kind: "agente", title: `Novo agente no seu time: ${row.name}`, body: row.focus, link: "/agents" });

    const usable = (await availableTools(def.tools, ctx.user)).map((t) => t.name);
    const out: Record<string, unknown> = { ok: true, agent: def.id, name: row.name, persona: row.persona, tools: usable, updated: Boolean(existing) };
    if (!usable.length) out.warning = "Nenhuma das ferramentas dele está disponível agora (integração desconectada); ele só entra no time quando houver uma.";
    else if (args.first_task?.trim()) Object.assign(out, await delegationTool(def).run({ message: args.first_task }, ctx));
    return out;
  },
});

export const teamAdjustAgent = defineTool<{ agent: string; instructions?: string; focus?: string; tools?: string[]; note?: string; retire?: boolean }>({
  name: "team_adjust_agent",
  description:
    "Ajusta um agente do time desta pessoa. Agente sob medida (c_<nome>): troque instructions, focus ou tools, ou retire=true para aposentar. " +
    `Especialista fixo (${SPECIALISTS.map((s) => s.id).join(", ")}): passe note com o que ele deve saber ou fazer diferente só para ela ` +
    '(ex.: financeiro: "ela divide tudo com o marido; sempre mostre a parte de cada um"). Vale a partir da próxima conversa com o agente.',
  parameters: obj(
    {
      agent: { type: "string", description: "id do agente: c_<nome> ou o id do especialista fixo" },
      instructions: { type: "string" },
      focus: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      note: { type: "string", description: "Para especialista fixo: o que vale só para esta pessoa (até 400 caracteres)" },
      retire: { type: "boolean" },
    },
    ["agent"],
  ),
  async run(args, ctx) {
    const id = String(args.agent ?? "").trim();
    if (SPECIALISTS.some((s) => s.id === id)) {
      const note = String(args.note ?? args.instructions ?? "").trim();
      if (!note) return { ok: false, error: "Para um especialista fixo, passe note" };
      await query(
        // pedido da pessoa fica em user_note: a reunião noturna só reescreve note
        "INSERT INTO agent_notes (user_id, agent, user_note) VALUES ($1, $2, $3) ON CONFLICT (user_id, agent) DO UPDATE SET user_note = $3, updated_at = now()",
        [ctx.user.id, id, note.slice(0, 400)],
      );
      return { ok: true, agent: id, note: note.slice(0, 400) };
    }
    const slug = ownSlug(id);
    const tools = args.tools ? pickTools(args.tools) : null;
    if (args.tools && !tools!.length) return { ok: false, error: `Nenhuma ferramenta válida. Use: ${TOOL_NAMES.join(", ")}` };
    const row = await one(
      `UPDATE client_agents SET active = CASE WHEN $3 THEN false ELSE active END, instructions = COALESCE($4, instructions),
         focus = COALESCE($5, focus), tools = COALESCE($6, tools), updated_at = now()
       WHERE user_id = $1 AND slug = $2 RETURNING *`,
      [
        ctx.user.id,
        slug,
        args.retire === true,
        args.instructions?.trim() ? args.instructions.trim().slice(0, 1500) : null,
        args.focus?.trim() ? args.focus.trim().slice(0, 200) : null,
        tools,
      ],
    );
    if (!row) return { ok: false, error: `Esta pessoa não tem o agente ${id}. Veja os dela com team_list.` };
    if (!row.active) ctx.room.team = ctx.room.team.filter((a) => a.id !== `c_${slug}`);
    return { ok: true, agent: `c_${slug}`, name: row.name, active: row.active };
  },
});

export const teamList = defineTool<Record<string, never>>({
  name: "team_list",
  description: "Lista o time desta pessoa: especialistas fixos (com o que cada um já aprendeu sobre ela) e os agentes sob medida dela (ativos e aposentados).",
  parameters: obj({}),
  async run(_a, ctx) {
    const notes = await many("SELECT agent, note, user_note FROM agent_notes WHERE user_id = $1", [ctx.user.id]);
    const own = await many("SELECT slug, name, persona, focus, tools, uses, active, origin FROM client_agents WHERE user_id = $1 ORDER BY active DESC, created_at", [ctx.user.id]);
    return {
      fixed: SPECIALISTS.map((s) => ({ agent: s.id, name: s.name, persona: s.persona, note: noteText(notes.find((n) => n.agent === s.id)) })),
      own: own.map((a) => ({ agent: `c_${a.slug}`, name: a.name, persona: a.persona, focus: a.focus, tools: a.tools, uses: a.uses, active: a.active, origin: a.origin })),
      limit: MAX_CLIENT_AGENTS,
    };
  },
});

/** Ferramentas do CTO para montar o time de cada pessoa. */
export const TEAM_TOOLS: Tool[] = [teamCreateAgent, teamAdjustAgent, teamList];
