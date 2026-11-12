import { config } from "../../config.js";
import { getMeet, listMeets } from "../../meet.js";
import { defineTool, obj } from "./types.js";

/** Reuniões da Marlene: atas (só leitura) e entrar ou sair de uma reunião pelo link. */

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

export const meetingJoin = defineTool<{ url: string; title?: string }>({
  name: "meeting_join",
  description:
    "Marlene entra sozinha na reunião do Google Meet pelo link (a pessoa não precisa estar lá), ouve e no fim manda a ata em PDF. Alguém da reunião precisa aceitar a entrada dela.",
  parameters: obj({ url: { type: "string", description: "link meet.google.com/abc-defg-hij" }, title: { type: "string", description: "assunto da reunião, se a pessoa disse" } }, ["url"]),
  async run(args, ctx) {
    const { joinMeetByLink } = await import("../../meet-bot.js");
    const r = await joinMeetByLink(ctx.user.id, String(args.url ?? ""), args.title);
    if (!r.ok) return { error: r.error };
    return {
      ok: true,
      title: r.session.title,
      diga:
        "Que já está indo para a reunião com o nome Marlene, que alguém de lá precisa aceitar a entrada dela, " +
        "que ela avisa aqui quando entrar e manda a ata em PDF quando a reunião acabar.",
    };
  },
});

export const meetingLeave = defineTool<Record<string, never>>({
  name: "meeting_leave",
  description: "Tira a Marlene da reunião em que ela entrou pelo link (ou cancela se ainda está esperando entrar). A ata sai com o que ela ouviu.",
  parameters: obj({}),
  async run(_args, ctx) {
    const { one } = await import("../../db/pool.js");
    const { stopMeet } = await import("../../meet.js");
    const s = await one<{ id: string; status: string; title: string }>(
      "SELECT id, status, title FROM meet_sessions WHERE user_id = $1 AND mode = 'robo' AND status IN ('entrando', 'gravando') ORDER BY started_at DESC LIMIT 1",
      [ctx.user.id],
    );
    if (!s) return { error: "A Marlene não está em nenhuma reunião agora." };
    await stopMeet(ctx.user.id, s.id);
    return { ok: true, title: s.title, ata: s.status === "gravando" ? "sai em alguns minutos e chega aqui em PDF" : "nenhuma (ela ainda não tinha entrado)" };
  },
});
