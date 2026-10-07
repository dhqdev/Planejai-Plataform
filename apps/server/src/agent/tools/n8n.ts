import { isOwner } from "../../ingest.js";
import { getCredentials } from "../../integrations/registry.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/** n8n do dono: só ele usa (é a VM dele); para os clientes as ferramentas respondem que não está disponível. */
async function n8n(ctx: { user: { phone: string } }) {
  if (!isOwner(ctx.user.phone)) throw new Error("As automações do n8n são só do dono da plataforma.");
  const c = await getCredentials("n8n");
  if (!c?.base_url || !c.api_key) throw new Error("n8n não conectado (Integrações > n8n)");
  const base = c.base_url.replace(/\/$/, "");
  const api = async (path: string) => {
    const res = await fetch(`${base}/api/v1${path}`, { headers: { "X-N8N-API-KEY": c.api_key!, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`n8n ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  };
  const auth = c.webhook_user ? `Basic ${Buffer.from(`${c.webhook_user}:${c.webhook_password ?? ""}`).toString("base64")}` : null;
  return { base, api, auth };
}

/** Caminhos de webhook de um fluxo (é por eles que se dispara um fluxo de fora). */
function webhooks(w: any) {
  return (w.nodes ?? [])
    .filter((n: any) => n.type === "n8n-nodes-base.webhook" && n.parameters?.path)
    .map((n: any) => ({ node: n.name, path: n.parameters.path, method: n.parameters.httpMethod ?? "GET" }));
}

export const n8nWorkflows = defineTool<{ search?: string }>({
  name: "n8n_workflows",
  description: "Lista os fluxos do n8n do dono (nome, ativo, webhooks para disparar). Só funciona para o dono.",
  integration: "n8n",
  parameters: obj({ search: { type: "string", description: "Parte do nome para filtrar" } }),
  async run(args, ctx) {
    const { api } = await n8n(ctx);
    const json = await api("/workflows?limit=250");
    const q = (args.search ?? "").toLowerCase();
    return (json.data ?? [])
      .filter((w: any) => !q || String(w.name).toLowerCase().includes(q))
      .slice(0, 40)
      .map((w: any) => ({ id: w.id, name: w.name, active: w.active, webhooks: webhooks(w), updated: w.updatedAt }));
  },
});

export const n8nExecutions = defineTool<{ status?: "error" | "success" | "waiting"; workflow_id?: string; limit?: number }>({
  name: "n8n_executions",
  description: "Últimas execuções do n8n do dono (para ver o que falhou). Só funciona para o dono.",
  integration: "n8n",
  parameters: obj({
    status: { type: "string", enum: ["error", "success", "waiting"] },
    workflow_id: { type: "string" },
    limit: { type: "number", description: "Padrão 10, máx. 30" },
  }),
  async run(args, ctx) {
    const { api } = await n8n(ctx);
    const p = new URLSearchParams({ limit: String(Math.min(30, Math.max(1, Math.floor(args.limit ?? 10)))) });
    if (args.status) p.set("status", args.status);
    if (args.workflow_id) p.set("workflowId", args.workflow_id);
    const json = await api(`/executions?${p}`);
    return (json.data ?? []).map((e: any) => ({ id: e.id, workflow_id: e.workflowId, status: e.status, started: e.startedAt, stopped: e.stoppedAt, mode: e.mode }));
  },
});

export const n8nTrigger = defineTool<{ path: string; method?: "POST" | "GET"; data?: Record<string, unknown>; test?: boolean; confirmed_by_user?: boolean }>({
  name: "n8n_trigger",
  description:
    "Dispara um fluxo do n8n do dono pelo webhook (path vem de n8n_workflows) enviando data em JSON. " +
    "Como pode mandar mensagens ou mexer em dados, só com confirmed_by_user=true. Só funciona para o dono.",
  integration: "n8n",
  parameters: obj(
    {
      path: { type: "string", description: "Caminho do webhook, ex.: criar-trial" },
      method: { type: "string", enum: ["POST", "GET"] },
      data: { type: "object", description: "Corpo JSON enviado ao fluxo" },
      test: { type: "boolean", description: "true usa /webhook-test (fluxo aberto no editor)" },
      ...CONFIRM_PARAM,
    },
    ["path"],
  ),
  async run(args, ctx) {
    const blocked = requireConfirmation(args, `disparar o fluxo ${args.path} no n8n`);
    if (blocked) return blocked;
    const { base, auth } = await n8n(ctx);
    const path = args.path.replace(/^\/+/, "").replace(/^webhook(-test)?\//, "");
    const method = args.method ?? "POST";
    const url = `${base}/${args.test ? "webhook-test" : "webhook"}/${path}${method === "GET" && args.data ? `?${new URLSearchParams(args.data as Record<string, string>)}` : ""}`;
    const res = await fetch(url, {
      method,
      headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(auth ? { Authorization: auth } : {}) },
      body: method === "POST" ? JSON.stringify(args.data ?? {}) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: unknown = text.slice(0, 2000);
    try {
      body = JSON.parse(text);
    } catch {
      /* resposta em texto */
    }
    return { ok: res.ok, status: res.status, response: body };
  },
});
