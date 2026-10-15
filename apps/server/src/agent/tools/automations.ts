import { many, one, query } from "../../db/pool.js";
import { isOwner } from "../../ingest.js";
import { getCredentials } from "../../integrations/registry.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/**
 * Automações no n8n que já existem (feitas antes, quando o assistente ainda criava fluxos).
 * O assistente não cria nem reescreve fluxo no n8n (decisão do dono, 2026-10-15): só lista, liga, desliga,
 * apaga (com o "sim") e mostra se está rodando bem.
 */

async function n8nApi() {
  const c = await getCredentials("n8n");
  if (!c?.base_url) throw new Error("n8n não está ligado à plataforma");
  if (!c.api_key) throw new Error("Falta a chave da API do n8n (N8N_API_KEY na stack ou Integrações > n8n)");
  const base = c.base_url.replace(/\/$/, "");
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { "X-N8N-API-KEY": c.api_key!, accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`n8n ${res.status}: ${String(json?.message ?? JSON.stringify(json)).slice(0, 300)}`);
    return json;
  };
}

async function ownAutomation(workflowId: string, ctx: { user: { id: string; phone: string } }) {
  const row = await one("SELECT * FROM automations WHERE workflow_id = $1", [workflowId]);
  if (row && (row.user_id === ctx.user.id || isOwner(ctx.user.phone))) return row;
  if (!row && isOwner(ctx.user.phone)) return { workflow_id: workflowId, user_id: ctx.user.id, name: workflowId };
  throw new Error("Automação não encontrada");
}

export const automationList = defineTool<{ all?: boolean }>({
  name: "automation_list",
  description: "Lista as automações da pessoa no n8n (id, nome, ativa). O dono pode pedir all=true para ver as de todos.",
  integration: "n8n",
  ownerOnly: false,
  parameters: obj({ all: { type: "boolean" } }),
  async run(args, ctx) {
    const all = args.all && isOwner(ctx.user.phone);
    const rows = await many(
      `SELECT a.workflow_id, a.name, a.description, a.active, a.created_at, coalesce(u.full_name, u.name, u.phone) AS who
       FROM automations a JOIN users u ON u.id = a.user_id ${all ? "" : "WHERE a.user_id = $1"} ORDER BY a.created_at DESC LIMIT 50`,
      all ? [] : [ctx.user.id],
    );
    return rows.map((r) => ({ workflow_id: r.workflow_id, name: r.name, description: r.description, active: r.active, ...(all ? { who: r.who } : {}) }));
  },
});

export const automationManage = defineTool<{ workflow_id: string; action: "activate" | "deactivate" | "delete"; confirmed_by_user?: boolean }>({
  name: "automation_manage",
  description: "Liga, desliga ou apaga uma automação da pessoa (workflow_id de automation_list). Apagar pede o \"sim\" da pessoa (o sistema confirma sozinho).",
  integration: "n8n",
  ownerOnly: false,
  parameters: obj(
    { workflow_id: { type: "string" }, action: { type: "string", enum: ["activate", "deactivate", "delete"] }, ...CONFIRM_PARAM },
    ["workflow_id", "action"],
  ),
  async run(args, ctx) {
    const row = await ownAutomation(args.workflow_id, ctx);
    if (args.action === "delete") {
      const blocked = await requireConfirmation(args, `apagar a automação ${row.name}`, ctx);
      if (blocked) return blocked;
    }
    const api = await n8nApi();
    if (args.action === "delete") {
      await api("DELETE", `/workflows/${row.workflow_id}`).catch((e: Error) => {
        if (!/404/.test(e.message)) throw e;
      });
      await query("DELETE FROM automations WHERE workflow_id = $1", [row.workflow_id]);
      return { ok: true, deleted: row.name };
    }
    await api("POST", `/workflows/${row.workflow_id}/${args.action}`);
    await query("UPDATE automations SET active = $2, updated_at = now() WHERE workflow_id = $1", [row.workflow_id, args.action === "activate"]);
    return { ok: true, name: row.name, active: args.action === "activate" };
  },
});

export const automationStatus = defineTool<{ workflow_id: string }>({
  name: "automation_status",
  description:
    "Mostra se uma automação da pessoa está rodando bem: as últimas execuções no n8n e, se alguma falhou, em que nó e por quê. " +
    "Use quando a pessoa disser que o aviso não chegou; com o erro em mãos, explique o que falhou (o assistente não edita o fluxo).",
  integration: "n8n",
  ownerOnly: false,
  parameters: obj({ workflow_id: { type: "string" } }, ["workflow_id"]),
  async run(args, ctx) {
    const row = await ownAutomation(args.workflow_id, ctx);
    const api = await n8nApi();
    const wf = await api("GET", `/workflows/${row.workflow_id}`).catch((e: Error) => {
      if (/404/.test(e.message)) return null;
      throw e;
    });
    if (!wf) return { ok: false, name: row.name, error: "O fluxo não existe mais no n8n. Ofereça apagar da lista com automation_manage." };
    if (row.active !== undefined && Boolean(wf.active) !== Boolean(row.active))
      await query("UPDATE automations SET active = $2, updated_at = now() WHERE workflow_id = $1", [row.workflow_id, Boolean(wf.active)]);
    const list = await api("GET", `/executions?workflowId=${encodeURIComponent(row.workflow_id)}&limit=5`);
    const runs = [];
    for (const e of list?.data ?? []) {
      const run: Record<string, unknown> = { status: e.status ?? (e.finished ? "success" : "error"), started: e.startedAt, stopped: e.stoppedAt };
      if (run.status === "error" || run.status === "crashed") {
        // só o motivo da falha: os dados que passaram pelo fluxo não voltam para a conversa
        const full = await api("GET", `/executions/${e.id}?includeData=true`).catch(() => null);
        const err = full?.data?.resultData?.error;
        run.failed_node = full?.data?.resultData?.lastNodeExecuted ?? err?.node?.name ?? null;
        run.error = String(err?.message ?? err?.description ?? "erro sem detalhe").slice(0, 300);
      }
      runs.push(run);
    }
    return { ok: true, name: row.name, active: Boolean(wf.active), runs, ...(runs.length ? {} : { note: "Ainda não disparou nenhuma vez." }) };
  },
});

/** Ao apagar os dados de alguém (LGPD), apaga também os fluxos dela no n8n. Melhor esforço. */
export async function deleteUserAutomations(userId: string) {
  const rows = await many<{ workflow_id: string }>("SELECT workflow_id FROM automations WHERE user_id = $1", [userId]);
  if (!rows.length) return;
  try {
    const api = await n8nApi();
    for (const r of rows) await api("DELETE", `/workflows/${r.workflow_id}`).catch(() => {});
  } catch {
    /* n8n fora: os fluxos ficam desligados do usuário apagado */
  }
}
