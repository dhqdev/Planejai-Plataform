import { config } from "../../config.js";
import { getMeet, listMeets } from "../../meet.js";
import { defineTool, obj } from "./types.js";

/** Atas das reuniões que a secretária acompanhou pelo painel (só leitura). */

const panel = () => `${config.PUBLIC_URL.replace(/\/$/, "")}/especialistas/reunioes`;

export const meetingList = defineTool<Record<string, never>>({
  name: "meeting_list",
  description: "Reuniões do Meet que a secretária acompanhou: id, título, data, status e o começo do resumo.",
  parameters: obj({}),
  async run(_args, ctx) {
    const rows = await listMeets(ctx.user.id);
    return {
      total: rows.length,
      meetings: rows.slice(0, 15).map((m) => ({ id: m.id, title: m.title, started_at: m.started_at, status: m.status, overview: m.overview })),
      como_gravar: "No notebook, aba da secretária no painel, botão Acompanhar reunião.",
      painel: panel(),
    };
  },
});

export const meetingRead = defineTool<{ id: string; transcript?: boolean }>({
  name: "meeting_read",
  description: "Ata completa de uma reunião (id do meeting_list). transcript=true traz também o que foi dito (até 12 mil caracteres).",
  parameters: obj({ id: { type: "string" }, transcript: { type: "boolean" } }, ["id"]),
  async run(args, ctx) {
    const m = await getMeet(ctx.user.id, String(args.id ?? ""));
    if (!m) return { error: "Reunião não encontrada. Use meeting_list para ver os ids." };
    const said = args.transcript ? m.parts.map((p) => p.transcript ?? "").filter(Boolean).join("\n").slice(0, 12_000) : undefined;
    return { title: m.title, started_at: m.started_at, status: m.status, ata: m.summary ?? "(ainda sem ata)", ...(said !== undefined ? { transcricao: said || "(apagada depois de 7 dias)" } : {}) };
  },
});
