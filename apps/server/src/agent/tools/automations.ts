import { config } from "../../config.js";
import { many, one, query } from "../../db/pool.js";
import { isOwner } from "../../ingest.js";
import { getCredentials } from "../../integrations/registry.js";
import { BlockedUrlError, assertPublicUrl } from "../../net.js";
import { notify } from "../../notifications.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation } from "./types.js";

/**
 * Automações no n8n criadas pelo assistente a pedido de qualquer pessoa ("me avisa todo dia às 8h das notícias de X").
 * O modelo descreve o fluxo num formato curto (nós + ligações); aqui ele é validado, completado e salvo no n8n do dono.
 *
 * Para clientes o fluxo é seguro por construção: só nós da lista CLIENT_NODES, sem credenciais, sem $env/$vars,
 * HTTP só para endereço público fixo, e o aviso (planejai.notify / planejai.agent) sempre vai para a própria pessoa.
 * O dono pode usar qualquer nó do n8n.
 */

const VERSIONS: Record<string, number> = {
  scheduleTrigger: 1.2,
  webhook: 2,
  respondToWebhook: 1.1,
  set: 3.4,
  if: 2.2,
  filter: 2.2,
  switch: 3.2,
  merge: 3,
  wait: 1.1,
  noOp: 1,
  splitInBatches: 3,
  splitOut: 1,
  aggregate: 1,
  limit: 1,
  sort: 1,
  removeDuplicates: 2,
  dateTime: 2,
  rssFeedRead: 1.1,
  httpRequest: 4.2,
  html: 1.2,
  markdown: 1,
  xml: 1,
};
const CLIENT_NODES = new Set(Object.keys(VERSIONS));

/**
 * Nomes no n8n: fluxos do sistema (feitos à mão, ninguém de fora mexe) começam com "[Sistema]";
 * os que o assistente cria começam com "[Cliente] Nome ·" ou "[Dono]", e ganham a etiqueta certa.
 */
export const TAG_CLIENT = "Planejai Cliente";
export const TAG_OWNER = "Planejai Dono";
export function flowName(owner: boolean, who: string, label: string) {
  return owner ? `[Dono] ${label}` : `[Cliente] ${who} · ${label}`;
}

/** Etiqueta o fluxo (cria a etiqueta se não existir). Falhar aqui não derruba a automação. */
async function tagWorkflow(api: (m: string, p: string, b?: unknown) => Promise<any>, workflowId: string, tag: string) {
  try {
    const all = await api("GET", "/tags?limit=250");
    let t = (all?.data ?? []).find((x: any) => x.name === tag);
    if (!t) t = await api("POST", "/tags", { name: tag });
    const cur = await api("GET", `/workflows/${workflowId}/tags`).catch(() => []);
    const ids = new Set([...(Array.isArray(cur) ? cur : []).map((x: any) => x.id), t.id]);
    await api("PUT", `/workflows/${workflowId}/tags`, [...ids].map((id) => ({ id })));
  } catch {
    /* n8n antigo sem etiquetas na API */
  }
}
const PLANEJAI_NODES = new Set(["planejai.notify", "planejai.agent"]);
/** Nada que leia segredo da instância ou rode código fora do sandbox das expressões. */
const FORBIDDEN = /\$env|\$vars|\$secrets|process\.|require\s*\(|constructor|__proto__|\$getWorkflowStaticData|\$execution\.customData/i;

export interface ShortNode {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
}
export interface ShortLink {
  from: string;
  to: string;
  output?: number;
}

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

const typeName = (t: string) => t.replace(/^n8n-nodes-base\./, "");

/** Texto do usuário vira expressão do n8n só se tiver {{ }} dentro. */
const expr = (s: string) => (s.includes("{{") ? `=${s}` : s);

function planejaiNode(n: ShortNode, userId: string): Record<string, unknown> {
  const p = n.parameters ?? {};
  const agent = n.type === "planejai.agent";
  const field = agent ? "instruction" : "text";
  const value = String(p[field] ?? "").trim();
  if (!value) throw new Error(`O nó "${n.name}" precisa de ${field}`);
  return {
    type: "n8n-nodes-base.httpRequest",
    typeVersion: VERSIONS.httpRequest,
    parameters: {
      method: "POST",
      url: `={{ $env.PLANEJAI_API_URL }}/api/internal/${agent ? "agent" : "send"}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: "X-Planejai-Key", value: "={{ $env.PLANEJAI_API_KEY }}" }] },
      sendBody: true,
      bodyParameters: {
        parameters: [
          { name: "user_id", value: userId },
          { name: field, value: expr(value) },
        ],
      },
      options: {},
    },
  };
}

/** Valida e completa o fluxo curto no formato do n8n. Lança erro com o motivo (o agente corrige e tenta de novo). */
export async function buildWorkflow(input: { nodes: ShortNode[]; connections: ShortLink[]; userId: string; owner: boolean; webhookPrefix: string }) {
  const { nodes, connections, userId, owner } = input;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("O fluxo precisa de pelo menos um nó");
  if (nodes.length > 25) throw new Error("Fluxo grande demais (máx. 25 nós)");
  const names = new Set<string>();
  const out: Record<string, unknown>[] = [];
  let triggers = 0;
  for (const [i, n] of nodes.entries()) {
    if (!n?.name || !n.type) throw new Error("Cada nó precisa de name e type");
    if (names.has(n.name)) throw new Error(`Nome de nó repetido: ${n.name}`);
    names.add(n.name);
    const short = typeName(n.type);
    const params = n.parameters ?? {};
    let node: Record<string, unknown>;
    if (PLANEJAI_NODES.has(n.type)) {
      if (!owner && FORBIDDEN.test(JSON.stringify(params))) throw new Error(`O nó "${n.name}" usa algo que não é permitido`);
      node = planejaiNode(n, userId);
    } else if (owner && !CLIENT_NODES.has(short)) {
      // dono: qualquer nó, com a versão que ele informar (ou 1)
      node = { type: n.type.includes(".") ? n.type : `n8n-nodes-base.${n.type}`, typeVersion: Number((n as any).typeVersion ?? 1), parameters: params };
    } else {
      if (!CLIENT_NODES.has(short)) throw new Error(`Nó "${n.type}" não permitido. Use: ${[...CLIENT_NODES, ...PLANEJAI_NODES].join(", ")}`);
      if (!owner) {
        if (FORBIDDEN.test(JSON.stringify(params))) throw new Error(`O nó "${n.name}" usa algo que não é permitido ($env, $vars, código)`);
        if (short === "httpRequest") {
          const url = String(params.url ?? "");
          if (!url || url.includes("{{") || url.startsWith("=")) throw new Error(`O nó "${n.name}" precisa de uma URL fixa (sem expressão)`);
          try {
            await assertPublicUrl(url);
          } catch (e) {
            throw new Error(e instanceof BlockedUrlError ? e.message : `URL inválida em "${n.name}"`);
          }
          if (params.authentication && params.authentication !== "none") throw new Error(`O nó "${n.name}" não pode usar credenciais`);
        }
        if (short === "rssFeedRead") {
          const url = String(params.url ?? "");
          if (url.includes("{{")) throw new Error(`O nó "${n.name}" precisa de uma URL fixa`);
          await assertPublicUrl(url).catch(() => {
            throw new Error(`URL do RSS bloqueada ou inválida em "${n.name}"`);
          });
        }
      }
      node = { type: `n8n-nodes-base.${short}`, typeVersion: VERSIONS[short], parameters: { ...params } };
      if (short === "webhook") {
        const path = String(params.path ?? "").replace(/[^a-z0-9-]/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "gatilho";
        (node.parameters as any).path = owner ? path : `${input.webhookPrefix}-${path}`;
        (node as any).webhookId = crypto.randomUUID();
      }
    }
    if (short === "scheduleTrigger" || short === "webhook") triggers++;
    out.push({ id: crypto.randomUUID(), name: n.name, position: [i * 260, 0], ...node });
  }
  if (!owner && triggers === 0) throw new Error("O fluxo precisa começar com scheduleTrigger ou webhook");

  const conns: Record<string, { main: { node: string; type: "main"; index: number }[][] }> = {};
  for (const l of connections ?? []) {
    if (!names.has(l.from) || !names.has(l.to)) throw new Error(`Ligação com nó que não existe: ${l.from} -> ${l.to}`);
    const o = Math.max(0, Math.min(10, Math.floor(l.output ?? 0)));
    const main = (conns[l.from] ??= { main: [] }).main;
    while (main.length <= o) main.push([]);
    main[o]!.push({ node: l.to, type: "main", index: 0 });
  }
  return { nodes: out, connections: conns };
}

async function ownAutomation(workflowId: string, ctx: { user: { id: string; phone: string } }) {
  const row = await one("SELECT * FROM automations WHERE workflow_id = $1", [workflowId]);
  if (row && (row.user_id === ctx.user.id || isOwner(ctx.user.phone))) return row;
  if (!row && isOwner(ctx.user.phone)) return { workflow_id: workflowId, user_id: ctx.user.id, name: workflowId };
  throw new Error("Automação não encontrada");
}

const NODE_GUIDE =
  "Formato curto: nodes=[{name,type,parameters}], connections=[{from,to,output?}] (output 1 = ramo falso do if). " +
  "Tipos: scheduleTrigger, webhook, set, if, filter, switch, merge, wait, noOp, splitInBatches, splitOut, aggregate, limit, sort, removeDuplicates, dateTime, rssFeedRead, httpRequest, html, markdown, xml, respondToWebhook, " +
  "e os especiais planejai.notify {text} (manda mensagem para a pessoa) e planejai.agent {instruction} (o assistente escreve a mensagem do jeito dele). " +
  'Exemplos de parameters: scheduleTrigger {"rule":{"interval":[{"field":"cronExpression","expression":"0 8 * * *"}]}} ou {"rule":{"interval":[{"field":"hours","hoursInterval":2}]}}; ' +
  'rssFeedRead {"url":"https://g1.globo.com/rss/g1/"}; limit {"maxItems":3}; httpRequest {"url":"https://api.exemplo.com/x","method":"GET"}; ' +
  'planejai.agent {"instruction":"Resuma para a pessoa estas notícias: {{ $json.title }} {{ $json.link }}"}; ' +
  'if {"conditions":{"options":{"caseSensitive":true,"typeValidation":"loose"},"combinator":"and","conditions":[{"leftValue":"={{ $json.preco }}","rightValue":100,"operator":{"type":"number","operation":"lt"}}]}}. ' +
  "Texto com {{ }} vira expressão do n8n. Para juntar vários itens numa mensagem, use aggregate antes do planejai.agent.";

export const automationSave = defineTool<{
  name: string;
  description?: string;
  nodes: ShortNode[];
  connections: ShortLink[];
  workflow_id?: string;
  activate?: boolean;
}>({
  name: "automation_save",
  description:
    "Cria (ou substitui, com workflow_id) uma automação no n8n para a pessoa: avisos agendados, acompanhar RSS/sites/APIs, gatilhos por webhook. " +
    "Já sai ativa. Se o n8n recusar, corrija pelo erro e chame de novo com o mesmo workflow_id. " +
    NODE_GUIDE,
  integration: "n8n",
  ownerOnly: false,
  parameters: obj(
    {
      name: { type: "string", description: "Nome curto, ex.: Notícias de IA às 8h" },
      description: { type: "string" },
      nodes: { type: "array", items: { type: "object" }, description: "Nós no formato curto" },
      connections: { type: "array", items: { type: "object" }, description: "Ligações {from,to,output?}" },
      workflow_id: { type: "string", description: "Para substituir uma automação existente" },
      activate: { type: "boolean", description: "Padrão true" },
    },
    ["name", "nodes", "connections"],
  ),
  async run(args, ctx) {
    const api = await n8nApi();
    const owner = isOwner(ctx.user.phone);
    const existing = args.workflow_id ? await ownAutomation(args.workflow_id, ctx) : null;
    if (!existing && !owner && config.AUTOMATIONS_PER_USER > 0) {
      const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM automations WHERE user_id = $1", [ctx.user.id]);
      if ((n?.n ?? 0) >= config.AUTOMATIONS_PER_USER)
        return { ok: false, error: `A pessoa já tem ${n!.n} automações (limite ${config.AUTOMATIONS_PER_USER}). Ofereça apagar uma antes.` };
    }
    const built = await buildWorkflow({ nodes: args.nodes, connections: args.connections, userId: ctx.user.id, owner, webhookPrefix: `pj-${ctx.user.id.slice(0, 8)}` });
    const label = String(args.name).trim().slice(0, 80) || "Automação";
    const who = String(ctx.user.name ?? ctx.user.phone).split(" ")[0];
    const body = {
      name: flowName(owner, who, label),
      nodes: built.nodes,
      connections: built.connections,
      settings: {
        executionOrder: "v1",
        timezone: ctx.timezone,
        // execução de cliente não fica guardada com dados (privacidade); erro fica para dar para ver o que quebrou
        ...(owner ? {} : { saveDataSuccessExecution: "none", saveManualExecutions: false, executionTimeout: 300 }),
      },
    };
    const wf = existing ? await api("PUT", `/workflows/${existing.workflow_id}`, body) : await api("POST", "/workflows", body);
    await tagWorkflow(api, String(wf.id), owner ? TAG_OWNER : TAG_CLIENT);
    await query(
      `INSERT INTO automations (workflow_id, user_id, name, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()`,
      [String(wf.id), existing?.user_id ?? ctx.user.id, label, args.description ?? null],
    );
    let active = false;
    let activationError: string | null = null;
    if (args.activate !== false) {
      try {
        await api("POST", `/workflows/${wf.id}/activate`);
        active = true;
      } catch (e) {
        activationError = (e as Error).message;
      }
    }
    await query("UPDATE automations SET active = $2, updated_at = now() WHERE workflow_id = $1", [String(wf.id), active]);
    if (!existing) {
      const who = ctx.user.name ?? `+${ctx.user.phone}`;
      await notify({ userId: ctx.user.id, kind: "automacao", title: `Automação criada: ${label}`, body: args.description ?? null });
      if (!isOwner(ctx.user.phone)) await notify({ userId: null, kind: "automacao", title: `${who} criou uma automação`, body: label, link: "/clients" });
    }
    const webhooks = built.nodes
      .filter((n: any) => n.type === "n8n-nodes-base.webhook")
      .map((n: any) => `/webhook/${n.parameters.path}`);
    return {
      ok: !activationError,
      workflow_id: String(wf.id),
      name: label,
      active,
      ...(webhooks.length ? { webhooks } : {}),
      ...(activationError ? { error: `Salvo, mas o n8n não ativou: ${activationError}. Corrija e salve de novo com este workflow_id.` } : {}),
    };
  },
});

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
  description: "Liga, desliga ou apaga uma automação da pessoa (workflow_id de automation_list). Apagar só com confirmed_by_user=true.",
  integration: "n8n",
  ownerOnly: false,
  parameters: obj(
    { workflow_id: { type: "string" }, action: { type: "string", enum: ["activate", "deactivate", "delete"] }, ...CONFIRM_PARAM },
    ["workflow_id", "action"],
  ),
  async run(args, ctx) {
    const row = await ownAutomation(args.workflow_id, ctx);
    if (args.action === "delete") {
      const blocked = requireConfirmation(args, `apagar a automação ${row.name}`);
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
