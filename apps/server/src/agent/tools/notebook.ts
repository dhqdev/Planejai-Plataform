import { many, one } from "../../db/pool.js";
import { isoLocal } from "../../time.js";
import { defineTool, obj, type ToolContext } from "./types.js";

/**
 * Caderno do especialista sob medida: o único registro dele que dura entre uma conversa e outra
 * (o quadro do time some no fim da execução). Cada nota é da pessoa e do agente que escreveu.
 */
async function agentId(ctx: ToolContext): Promise<string | null> {
  if (!ctx.agent.startsWith("c_")) return null;
  const row = await one<{ id: string }>("SELECT id FROM client_agents WHERE user_id = $1 AND slug = $2", [ctx.user.id, ctx.agent.slice(2)]);
  return row?.id ?? null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const notebookSave = defineTool<{ note: string; day?: string }>({
  name: "notebook_save",
  description:
    "Grava no seu caderno o que precisa durar (presença do dia, valor combinado, pagamento feito). Uma nota por assunto, com os nomes e valores exatos. day = dia a que a nota se refere (AAAA-MM-DD).",
  parameters: obj({ note: { type: "string" }, day: { type: "string", description: "AAAA-MM-DD" } }, ["note"]),
  async run(args, ctx) {
    const id = await agentId(ctx);
    if (!id) return { ok: false, error: "Caderno é só dos especialistas sob medida." };
    const note = String(args.note ?? "").trim().slice(0, 2000);
    if (!note) return { ok: false, error: "Nota vazia." };
    const day = args.day && DAY.test(args.day) ? args.day : isoLocal(new Date(), ctx.timezone).slice(0, 10);
    const row = await one<{ id: string }>("INSERT INTO agent_notebook (user_id, client_agent_id, day, note) VALUES ($1, $2, $3, $4) RETURNING id", [
      ctx.user.id,
      id,
      day,
      note,
    ]);
    return { ok: true, id: row?.id, day };
  },
});

export const notebookRead = defineTool<{ from?: string; to?: string; limit?: number }>({
  name: "notebook_read",
  description: "Lê as notas do seu caderno (as mais novas primeiro). from/to = período (AAAA-MM-DD) pelo dia da nota.",
  parameters: obj({ from: { type: "string" }, to: { type: "string" }, limit: { type: "number" } }),
  async run(args, ctx) {
    const id = await agentId(ctx);
    if (!id) return { ok: false, error: "Caderno é só dos especialistas sob medida." };
    return { ok: true, notes: await notebookNotes(ctx.user.id, id, args) };
  },
});

export async function notebookNotes(userId: string, clientAgentId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  const rows = await many<{ day: string | null; note: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, note FROM agent_notebook
      WHERE user_id = $1 AND client_agent_id = $2
        AND ($3::date IS NULL OR day >= $3::date) AND ($4::date IS NULL OR day <= $4::date)
      ORDER BY created_at DESC LIMIT $5`,
    [userId, clientAgentId, opts.from && DAY.test(opts.from) ? opts.from : null, opts.to && DAY.test(opts.to) ? opts.to : null, limit],
  );
  return rows.map((r) => ({ day: r.day, note: r.note }));
}
