import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { AGENT_ICON, AGENT_LABEL, ErrorBox, Json, Modal, PageHead, Status } from "../components";
import { AgentFace, CORE_FACES, type Face } from "../faces";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import "../executions.css";

/* ================= Formatos ================= */

/** Custo em dólar (como no OpenRouter), no jeito brasileiro: "US$ 0,0012". */
function usdBR(v: number | string | null | undefined) {
  const n = Number(v ?? 0);
  const digits = n === 0 ? 2 : n < 0.0001 ? 6 : n < 1 ? 4 : 2;
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function dur(v: number | null | undefined) {
  if (v == null) return "–";
  if (v < 1000) return `${v} ms`;
  if (v < 60_000) return `${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

function tok(v: number | string | null | undefined) {
  const n = Number(v ?? 0);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: n < 10_000 ? 1 : 0 })} mil`;
  return `${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
}

function agoShort(iso: string | null | undefined) {
  if (!iso) return "–";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 45) return "agora";
  if (s < 3600) return `há ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fullWhen = (iso: string) => new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }).replace(/\./g, "");

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === y.toDateString()) return "Ontem";
  const s = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Primeiras palavras de um texto, numa linha só. */
function firstWords(text: string | null | undefined, words = 14) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  const parts = t.split(" ");
  return parts.length > words ? `${parts.slice(0, words).join(" ")}…` : t;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? one : many}`;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "0%");

/* ================= Rótulos ================= */

const TRIGGER_LABEL: Record<string, string> = { message: "Mensagem", reminder: "Lembrete", playground: "Teste", watch: "De olho", improve: "Reunião noturna" };
const TRIGGER_ICON: Record<string, string> = { message: "send", reminder: "bell", playground: "play", watch: "eye", improve: "sparkle" };
/** Quando não há texto de entrada, o que disparou a execução. */
const TRIGGER_FALLBACK: Record<string, string> = { message: "Mensagem recebida", reminder: "Lembrete disparado", playground: "Teste no painel", watch: "Conferência do De olho", improve: "Reunião noturna do time" };
const CHANNEL_LABEL: Record<string, string> = { baileys: "WhatsApp", evolution: "WhatsApp", cloud: "WhatsApp", telegram: "Telegram", playground: "Painel" };

/** Ferramentas em português, como a pessoa entenderia o que o time fez. */
const TOOL_LABEL: Record<string, string> = {
  add_transaction: "Registrou um lançamento",
  delete_transaction: "Apagou um lançamento",
  list_transactions: "Consultou lançamentos",
  finance_summary: "Montou o resumo financeiro",
  budget_status: "Conferiu os limites do mês",
  set_budget: "Definiu um limite",
  calculate: "Fez uma conta",
  create_payment_link: "Criou um link de pagamento",
  schedule_reminder: "Agendou um lembrete",
  list_reminders: "Consultou lembretes",
  cancel_reminder: "Cancelou um lembrete",
  calendar_create_event: "Criou evento na agenda",
  calendar_list_events: "Consultou a agenda",
  save_memory: "Guardou na memória",
  search_memories: "Buscou na memória",
  forget_memory: "Esqueceu uma memória",
  react_to_message: "Reagiu à mensagem",
  get_datetime: "Conferiu data e hora",
  web_search: "Pesquisou na internet",
  fetch_url: "Abriu uma página",
  screenshot_url: "Tirou print de uma página",
  browser_open: "Abriu o navegador",
  browser_action: "Agiu no navegador",
  browser_screenshot: "Print do navegador",
  browser_close: "Fechou o navegador",
  read_document: "Leu um documento",
  make_chart: "Gerou um gráfico",
  make_image: "Gerou uma imagem",
  attach_image: "Anexou uma imagem",
  mercadolivre_search: "Buscou no Mercado Livre",
  watch_create: "Criou um De olho",
  watch_list: "Consultou o De olho",
  watch_cancel: "Cancelou um De olho",
  send_to_contact: "Enviou para um contato",
  list_contacts: "Consultou contatos",
  invite_person: "Convidou uma pessoa",
  gmail_search: "Buscou no Gmail",
  gmail_read: "Leu um e-mail",
  gmail_send: "Enviou um e-mail",
  notion_search: "Buscou no Notion",
  notion_read_page: "Leu página do Notion",
  notion_create_page: "Criou página no Notion",
  github_search_issues: "Buscou issues no GitHub",
  github_create_issue: "Abriu issue no GitHub",
  linear_search_issues: "Buscou no Linear",
  linear_create_issue: "Criou tarefa no Linear",
  slack_list_channels: "Listou canais do Slack",
  slack_read_channel: "Leu canal do Slack",
  slack_send_message: "Mandou mensagem no Slack",
  automation_save: "Salvou uma automação",
  automation_list: "Consultou automações",
  automation_manage: "Mexeu numa automação",
  n8n_workflows: "Consultou fluxos do n8n",
  n8n_executions: "Consultou execuções do n8n",
  n8n_trigger: "Disparou um fluxo do n8n",
  share_with_team: "Anotou no quadro do time",
  transcrever_audio: "Transcreveu o áudio",
  descrever_imagem: "Olhou a foto",
  ler_documento: "Leu o documento",
  assistir_video: "Assistiu ao vídeo",
  enviar_texto: "Enviou a resposta",
  enviar_imagem: "Enviou uma imagem",
  aviso_andamento: "Avisou que está trabalhando",
};
const TOOL_ICON: [RegExp, string][] = [
  [/transaction|finance|budget|payment/, "wallet"],
  [/calculate/, "hash"],
  [/reminder/, "bell"],
  [/calendar|datetime/, "calendar"],
  [/memor/, "bookmark"],
  [/react/, "heart"],
  [/web_search|search/, "search"],
  [/fetch_url|browser|screenshot/, "globe"],
  [/document|ler_doc/, "book"],
  [/chart/, "trend"],
  [/image|imagem|foto/, "layout"],
  [/mercadolivre/, "shop"],
  [/watch/, "eye"],
  [/contact|invite/, "users"],
  [/gmail|mail/, "mail"],
  [/notion/, "bookmark"],
  [/github/, "github"],
  [/linear/, "target"],
  [/slack/, "hash"],
  [/automation|n8n/, "graph"],
  [/share_with_team/, "edit"],
  [/audio/, "activity"],
  [/video/, "play"],
];
const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** O que o modelo decidiu fazer, em português ("chamar Nico", "pesquisou na internet"). */
function callLabel(name: string, clientAgents: any[], cap = false) {
  const m = /^(ask|consult)_(.+)$/.exec(name);
  const t = m ? `chamar ${who(agentMeta(m[2]!, clientAgents))}` : toolLabel(name).toLowerCase();
  return cap ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
const toolIcon = (name: string) => TOOL_ICON.find(([re]) => re.test(name))?.[1] ?? "settings";

/** Resumo de uma linha dos argumentos de uma ferramenta (o texto que mais diz o que foi feito). */
function argSummary(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return firstWords(input, 18);
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  for (const k of ["query", "q", "text", "message", "question", "description", "title", "note", "content", "url", "expression", "name", "when", "category"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return firstWords(v, 18);
  }
  const parts = Object.entries(o)
    .filter(([k, v]) => !["confirm", "emoji", "reacao"].includes(k) && v != null && typeof v !== "object")
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v)}`);
  return firstWords(parts.join(" · "), 18);
}

interface AgentMeta { id: string; name: string; persona?: string; face?: Face | null; icon: string }
function agentMeta(id: string, clientAgents: any[] = []): AgentMeta {
  const core = CORE_FACES[id];
  if (core) return { id, name: AGENT_LABEL[id] ?? id, persona: core.persona, face: core.face, icon: AGENT_ICON[id] ?? "sparkle" };
  const c = clientAgents.find((a) => a.id === id);
  if (c) return { id, name: c.name, persona: c.persona ?? undefined, face: c.face ?? null, icon: "sparkle" };
  if (id === "acompanhamento") return { id, name: "De olho", icon: "eye" };
  return { id, name: id.replace(/^c_/, ""), icon: id.startsWith("c_") ? "sparkle" : "circle" };
}
const who = (m: AgentMeta) => m.persona ?? m.name;

function AgentAvatar({ meta, size = 24 }: { meta: AgentMeta; size?: number }) {
  if (meta.face !== undefined) return <AgentFace face={meta.face} size={size} title={who(meta)} />;
  return (
    <span className="ex-avatar-ico" style={{ width: size, height: size }} title={meta.name}>
      <Icon name={meta.icon} size={Math.round(size * 0.55)} />
    </span>
  );
}

function PersonAvatar({ name, size = 30 }: { name?: string | null; size?: number }) {
  const initials = String(name ?? "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
  return <span className="ex-person" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>;
}

function StatusIcon({ status, size = 28 }: { status: string; size?: number }) {
  return (
    <span className={`ex-st st-${status}`} style={{ width: size, height: size }} aria-label={status === "success" ? "ok" : status === "error" ? "erro" : "rodando"}>
      {status === "running" ? <span className="ex-spin" /> : <Icon name={status === "success" ? "check" : "x"} size={Math.round(size * 0.5)} />}
    </span>
  );
}

/* ================= Lista ================= */

const PERIODS: [string, string][] = [["", "Todo período"], ["1", "Última hora"], ["24", "Últimas 24 h"], ["168", "Últimos 7 dias"], ["720", "Últimos 30 dias"]];
const STATUSES: [string, string][] = [["", "Todos"], ["success", "OK"], ["error", "Erro"], ["running", "Rodando"]];

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  const conversation = params.get("conversation");
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [user, setUser] = useState(params.get("user") ?? "");
  const [agent, setAgent] = useState(params.get("agent") ?? "");
  const [since, setSince] = useState(params.get("since") ?? "");
  const [trigger, setTrigger] = useState(params.get("trigger") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [limit, setLimit] = useState(60);
  const [cleaning, setCleaning] = useState(false);
  const q = useDebounced(search.trim());
  const nav = useNavigate();

  // os filtros ficam na URL: voltar do detalhe mantém a mesma lista
  useEffect(() => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, user, agent, since, trigger, q, conversation: conversation ?? "" })) if (v) next.set(k, v);
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [status, user, agent, since, trigger, q, conversation, params, setParams]);

  const qs = new URLSearchParams({ limit: String(limit) });
  for (const [k, v] of Object.entries({ status, user, agent, since, trigger, q, conversation: conversation ?? "" })) if (v) qs.set(k, v);
  const { data, error, reload } = useApi<any[]>(`/api/executions?${qs}`, { poll: 5000 });
  const summary = useApi<any>(`/api/executions/summary?since=${since || 24}`, { poll: 15000 });
  const s = summary.data;
  const periodShort = since === "1" ? "1 h" : since === "168" ? "7 dias" : since === "720" ? "30 dias" : "24 h";
  const filtered = Boolean(status || user || agent || since || trigger || q || conversation);
  const clear = () => {
    haptic(6);
    setStatus("");
    setUser("");
    setAgent("");
    setSince("");
    setTrigger("");
    setSearch("");
    if (conversation) setParams(new URLSearchParams(), { replace: true });
  };

  const groups = useMemo(() => {
    const out: [string, any[]][] = [];
    for (const e of data ?? []) {
      const k = dayLabel(e.started_at);
      const g = out.find(([gk]) => gk === k);
      if (g) g[1].push(e);
      else out.push([k, [e]]);
    }
    return out;
  }, [data]);

  return (
    <div className="page exl-page fit">
      <div className="hide-phone">
      <PageHead
        title="Execuções"
        subtitle="Cada mensagem que o time de agentes trabalhou, passo a passo"
        actions={
          <button className="btn btn-ghost" onClick={() => { haptic(); setCleaning(true); }}>
            <Icon name="trash" size={15} /> Limpar antigas
          </button>
        }
      />
      </div>

      <div className="card ex-kpis">
        <div>
          <small>Execuções · {periodShort}</small>
          <strong>{s ? s.total.toLocaleString("pt-BR") : "–"}</strong>
          <span>{s?.running ? `${s.running} rodando agora` : "nenhuma rodando agora"}</span>
        </div>
        <div>
          <small>Taxa de erro</small>
          <strong className={s?.errors ? "neg" : ""}>{s ? pct(s.errors, s.total) : "–"}</strong>
          <span>{s ? (s.errors ? `${s.errors} com erro` : "nenhum erro") : " "}</span>
        </div>
        <div>
          <small>Duração média</small>
          <strong>{s ? dur(s.avg_ms) : "–"}</strong>
          <span>{s?.p95_ms ? `95% em até ${dur(s.p95_ms)}` : " "}</span>
        </div>
        <div>
          <small>Custo · {periodShort}</small>
          <strong>{s ? usdBR(s.cost_usd) : "–"}</strong>
          <span>{s?.total ? `${usdBR(s.cost_usd / s.total)}/execução · ${tok(s.tokens)} tokens` : " "}</span>
        </div>
      </div>

      <div className="ex-filters">
        <label className="ex-search">
          <Icon name="search" size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar" aria-label="Buscar" />
          {search && (
            <button aria-label="Limpar busca" onClick={() => setSearch("")}><Icon name="x" size={13} /></button>
          )}
        </label>
        <div className="ex-pills" role="tablist" aria-label="Status">
          {STATUSES.map(([v, label]) => (
            <button key={v} role="tab" aria-selected={status === v} className={status === v ? "active" : ""} onClick={() => { haptic(5); setStatus(v); }}>
              {v && <span className={`dot ${v === "success" ? "dot-ok" : v === "error" ? "dot-err" : "dot-warn"}`} />}
              {label}
            </button>
          ))}
        </div>
        <select className="select ex-select" value={user} onChange={(e) => setUser(e.target.value)} aria-label="Pessoa">
          <option value="">Pessoas</option>
          {(s?.people ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name ?? `+${p.phone}`}</option>)}
        </select>
        <select className="select ex-select" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agente">
          <option value="">Agentes</option>
          {(s?.agents ?? []).map((a: any) => {
            const m = agentMeta(a.agent);
            return <option key={a.agent} value={a.agent}>{m.persona ? `${m.persona} · ${m.name}` : m.name}</option>;
          })}
        </select>
        <select className="select ex-select" value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="Gatilho">
          <option value="">Gatilhos</option>
          {Object.entries(TRIGGER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="select ex-select ex-period" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Período">
          {PERIODS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {filtered && (
          <button className="icon-btn ex-clear" onClick={clear} aria-label="Limpar filtros" title="Limpar filtros"><Icon name="x" size={15} /></button>
        )}
        <button className="icon-btn phone-only ex-trash" aria-label="Limpar antigas" onClick={() => { haptic(); setCleaning(true); }}><Icon name="trash" size={15} /></button>
      </div>

      <ErrorBox error={error} />

      <div className="card ex-list">
        <div className="ex-row ex-row-head" aria-hidden="true">
          <span />
          <small>Execução</small>
          <small className="ex-c-team">Time</small>
          <small className="ex-c-num">Duração</small>
          <small className="ex-c-num ex-c-tok">Tokens</small>
          <small className="ex-c-num">Custo</small>
          <small className="ex-c-when">Quando</small>
        </div>
        <div className="ex-scroll">
          {!data ? (
            <ListSkeleton />
          ) : !data.length ? (
            <div className="ex-empty">
              <span className="ex-empty-ico"><Icon name="activity" size={22} /></span>
              <strong>{filtered ? "Nada com esses filtros" : "Nenhuma execução ainda"}</strong>
              <p>{filtered ? "Tente outro período ou limpe a busca." : "Quando alguém mandar uma mensagem, cada passo do time aparece aqui."}</p>
              {filtered && <button className="btn" onClick={clear}>Limpar filtros</button>}
            </div>
          ) : (
            <>
              {groups.map(([label, items]) => (
                <Fragment key={label}>
                  <div className="ex-day"><small>{label}</small><small className="mono">{items.length}</small></div>
                  {items.map((e) => <ExecRow key={e.id} e={e} onOpen={() => { haptic(5); nav(`/executions/${e.id}`); }} />)}
                </Fragment>
              ))}
              {data.length >= limit && limit < 200 && (
                <div className="ex-more">
                  <button className="btn" onClick={() => { haptic(); setLimit((l) => Math.min(200, l + 60)); }}>Carregar mais</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {cleaning && (
        <Modal
          title="Limpar execuções antigas"
          icon={<Icon name="trash" size={16} />}
          onClose={() => setCleaning(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCleaning(false)}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  haptic(12);
                  await api("/api/executions?older_than_days=30", { method: "DELETE" });
                  setCleaning(false);
                  void reload();
                  void summary.reload();
                }}
              >
                Apagar
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>Apaga do log as execuções com mais de 30 dias. O custo por pessoa continua guardado nos relatórios.</p>
        </Modal>
      )}
    </div>
  );
}

function ExecRow({ e, onOpen }: { e: any; onOpen: () => void }) {
  const title = e.content_purged ? TRIGGER_FALLBACK[e.trigger] ?? "Execução" : firstWords(e.input, 16) || TRIGGER_FALLBACK[e.trigger] || "Execução";
  const agents: string[] = (e.agents ?? []).filter(Boolean).sort((a: string, b: string) => (a === "cto" ? -1 : b === "cto" ? 1 : 0));
  const channel = e.channel ? CHANNEL_LABEL[e.channel] ?? e.channel : null;
  return (
    <button className={`ex-row ${e.status}`} onClick={onOpen}>
      <StatusIcon status={e.status} />
      <span className="ex-main">
        <span className={`ex-title ${e.content_purged ? "purged" : ""}`}>{title}</span>
        <span className="ex-meta">
          <span className="ex-who">{e.user_name ?? (e.phone ? `+${e.phone}` : "Sistema")}</span>
          {channel && <span className="ex-chan">{channel}</span>}
          <span className="ex-trig"><Icon name={TRIGGER_ICON[e.trigger] ?? "play"} size={11} /> {TRIGGER_LABEL[e.trigger] ?? e.trigger}</span>
          {e.model && <span className="mono ex-model">{String(e.model).replace(/^[^/]+\//, "")}</span>}
          <span className="ex-phone-nums mono">{dur(e.duration_ms)} · {usdBR(e.cost_usd)}</span>
        </span>
        {e.status === "error" && e.error && <span className="ex-err-line">{firstWords(e.error.split("\n")[0], 20)}</span>}
      </span>
      <span className="ex-c-team ex-faces">
        {agents.slice(0, 4).map((a) => <AgentAvatar key={a} meta={agentMeta(a)} size={24} />)}
        {agents.length > 4 && <span className="ex-more-faces">+{agents.length - 4}</span>}
      </span>
      <span className="ex-c-num mono">{e.status === "running" ? "…" : dur(e.duration_ms)}</span>
      <span className="ex-c-num ex-c-tok mono">{tok(Number(e.tokens_in) + Number(e.tokens_out))}</span>
      <span className="ex-c-num mono">{usdBR(e.cost_usd)}</span>
      <span className="ex-c-when" title={fullWhen(e.started_at)}>
        <span>{agoShort(e.started_at)}</span>
        <small className="mono">{clock(e.started_at)}</small>
      </span>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="ex-row ex-skel">
          <span className="sk sk-circle" />
          <span className="ex-main"><span className="sk" style={{ width: `${60 - i * 4}%` }} /><span className="sk sk-sm" style={{ width: "34%" }} /></span>
          <span className="ex-c-team"><span className="sk" style={{ width: 48 }} /></span>
          <span className="ex-c-num"><span className="sk" /></span>
          <span className="ex-c-num ex-c-tok"><span className="sk" /></span>
          <span className="ex-c-num"><span className="sk" /></span>
          <span className="ex-c-when"><span className="sk" /></span>
        </div>
      ))}
    </div>
  );
}

/* ================= Detalhe ================= */

interface Step {
  id: number;
  parent_id: number | null;
  agent: string;
  type: string;
  name: string;
  model: string | null;
  status: string;
  input: any;
  output: any;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number | null;
  started_at: string;
}

const TYPE_ICON: Record<string, string> = { llm: "sparkle", tool: "settings", delegate: "arrow", channel: "send", info: "shield" };

export function ExecutionDetailPage() {
  const { id } = useParams();
  const { data, error } = useApi<any>(`/api/executions/${id}`, { poll: 3000 });
  const [view, setView] = useState<"story" | "canvas">(() => {
    try {
      return localStorage.getItem("pj:exec-view") === "canvas" ? "canvas" : "story";
    } catch {
      return "story";
    }
  });
  const [selected, setSelected] = useState<number | null>(null);
  const nav = useNavigate();
  const pick = (v: "story" | "canvas") => {
    haptic(5);
    setView(v);
    try {
      localStorage.setItem("pj:exec-view", v);
    } catch {
      /* sem armazenamento */
    }
  };

  const steps: Step[] = data?.steps ?? [];
  const clientAgents: any[] = data?.client_agents ?? [];

  if (error) return <div className="page"><ErrorBox error={error} /><Link className="btn" to="/executions" style={{ marginTop: 12 }}>Voltar</Link></div>;
  if (!data) return <DetailSkeleton />;

  const llm = steps.filter((s) => s.type === "llm");
  const actions = steps.filter((s) => s.type === "tool" || s.type === "delegate");
  const models = [...new Set(llm.map((s) => s.model).filter(Boolean) as string[])];
  const channel = data.channel ? CHANNEL_LABEL[data.channel] ?? data.channel : null;
  const title = data.content_purged ? TRIGGER_FALLBACK[data.trigger] ?? "Execução" : firstWords(data.input, 12) || TRIGGER_FALLBACK[data.trigger] || "Execução";

  return (
    <div className="page exd-page fit">
      <div className="exd-head">
        <button className="icon-btn" aria-label="Voltar" onClick={() => { haptic(5); nav(-1); }}><Icon name="chevron-left" size={18} /></button>
        <div className="exd-title">
          <small>
            <Icon name={TRIGGER_ICON[data.trigger] ?? "play"} size={12} /> {TRIGGER_LABEL[data.trigger] ?? data.trigger}
            {channel ? ` · ${channel}` : ""} · {fullWhen(data.started_at)}
          </small>
          <h1 className={data.content_purged ? "purged" : ""}>{title}</h1>
        </div>
        <Status status={data.status} />
        <div className="ex-pills exd-toggle" role="tablist" aria-label="Visualização">
          <button role="tab" aria-selected={view === "story"} className={view === "story" ? "active" : ""} onClick={() => pick("story")}><Icon name="list" size={14} /> História</button>
          <button role="tab" aria-selected={view === "canvas"} className={view === "canvas" ? "active" : ""} onClick={() => pick("canvas")}><Icon name="graph" size={14} /> Canvas</button>
        </div>
      </div>

      <div className="card ex-kpis exd-kpis">
        <div><small>Duração</small><strong>{data.status === "running" ? "rodando" : dur(data.duration_ms)}</strong><span>{plural(steps.length, "passo", "passos")}</span></div>
        <div><small>Custo</small><strong>{usdBR(data.cost_usd)}</strong><span>{plural(llm.length, "chamada de IA", "chamadas de IA")}</span></div>
        <div><small>Tokens</small><strong>{tok(Number(data.tokens_in) + Number(data.tokens_out))}</strong><span className="mono">{tok(data.tokens_in)} entrada · {tok(data.tokens_out)} saída</span></div>
        <div><small>Modelo</small><strong className="exd-model" title={models.join(", ")}>{models[0] ? models[0].replace(/^[^/]+\//, "") : "–"}</strong><span>{models.length > 1 ? `+${models.length - 1} outro${models.length > 2 ? "s" : ""}` : plural(actions.length, "ação do time", "ações do time")}</span></div>
      </div>

      {view === "story" ? (
        <div className="exd-body">
          <div className="card exd-story">
            <Story data={data} steps={steps} clientAgents={clientAgents} />
          </div>
          <aside className="exd-side">
            <TeamCard steps={steps} clientAgents={clientAgents} />
            <ToolsCard steps={steps} />
            <InfoCard data={data} channel={channel} />
          </aside>
        </div>
      ) : (
        <div className="exd-canvas">
          <FlowCanvas data={data} steps={steps} onSelect={setSelected} selected={steps.find((s) => s.id === selected) ?? null} />
          <StepPanel step={steps.find((s) => s.id === selected) ?? null} data={data} clientAgents={clientAgents} />
        </div>
      )}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="page exd-page fit" aria-busy="true" aria-label="Carregando">
      <div className="exd-head"><span className="sk sk-circle" style={{ width: 38, height: 38 }} /><div className="exd-title"><span className="sk sk-sm" style={{ width: 180 }} /><span className="sk" style={{ width: 320, height: 22, marginTop: 8 }} /></div></div>
      <div className="card ex-kpis">{[0, 1, 2, 3].map((i) => <div key={i}><span className="sk sk-sm" style={{ width: 70 }} /><span className="sk" style={{ width: 110, height: 22 }} /></div>)}</div>
      <div className="card exd-story" style={{ padding: 20 }}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="row" style={{ marginBottom: 18 }}><span className="sk sk-circle" /><span className="sk" style={{ width: `${70 - i * 8}%` }} /></div>)}</div>
    </div>
  );
}

/* ---------- História (linha do tempo) ---------- */

function Story({ data, steps, clientAgents }: { data: any; steps: Step[]; clientAgents: any[] }) {
  const tree = useMemo(() => {
    const m = new Map<number | null, Step[]>();
    const ids = new Set(steps.map((s) => s.id));
    for (const s of steps) {
      const k = s.parent_id != null && ids.has(s.parent_id) ? s.parent_id : null;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [steps]);
  const roots = tree.get(null) ?? [];
  const sentText = steps.some((s) => s.type === "channel" && s.name === "enviar_texto");
  const silent = data.output === "[[silencio]]";
  const person = data.user_name ?? (data.phone ? `+${data.phone}` : null);

  return (
    <div className="tl">
      {data.content_purged && (
        <div className="tl-purged"><Icon name="shield" size={14} /> O texto desta execução foi apagado por privacidade. Ficaram os passos, tempos e custos.</div>
      )}

      <div className="tl-item tl-in">
        <div className="tl-rail"><PersonAvatar name={person ?? TRIGGER_LABEL[data.trigger]} size={30} /></div>
        <div className="tl-body">
          <div className="tl-head static">
            <span className="tl-title">{data.trigger === "message" || data.trigger === "playground" ? `${person ?? "Pessoa"} mandou` : TRIGGER_FALLBACK[data.trigger] ?? "Início"}</span>
            <span className="spacer" />
            <span className="tl-time mono">{clock(data.started_at)}</span>
          </div>
          {data.content_purged ? null : data.input ? <div className="bubble in">{data.input}</div> : <div className="tl-sub">sem texto</div>}
        </div>
      </div>

      <Steps list={roots} tree={tree} data={data} clientAgents={clientAgents} />

      {data.status === "running" ? (
        <div className="tl-item tl-running">
          <div className="tl-rail"><span className="tl-dot"><span className="ex-spin" /></span></div>
          <div className="tl-body"><div className="tl-head static"><span className="tl-title">Trabalhando…</span></div></div>
        </div>
      ) : data.status === "error" ? (
        <div className="tl-item tl-end err">
          <div className="tl-rail"><StatusIcon status="error" size={30} /></div>
          <div className="tl-body">
            <div className="tl-head static"><span className="tl-title">Parou com erro</span><span className="spacer" /><span className="tl-time mono">{dur(data.duration_ms)}</span></div>
            {data.error && (steps.some((st) => st.error && String(data.error).startsWith(st.error)) ? <div className="tl-sub">Mesmo erro do passo destacado acima.</div> : <ErrorText text={data.error} />)}
          </div>
        </div>
      ) : (
        <div className="tl-item tl-end">
          <div className="tl-rail"><StatusIcon status="success" size={30} /></div>
          <div className="tl-body">
            <div className="tl-head static">
              <span className="tl-title">{silent ? "Concluída só com a reação" : "Resposta final"}</span>
              <span className="spacer" />
              <span className="tl-time mono">em {dur(data.duration_ms)}</span>
            </div>
            {!silent && !data.content_purged && data.output && !sentText && <div className="bubble out">{data.output}</div>}
            {!silent && sentText && <div className="tl-sub">Enviada acima, em {steps.filter((s) => s.type === "channel" && s.name === "enviar_texto").length} balão(ões).</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ErrorText({ text }: { text: string }) {
  const [first, ...rest] = String(text).split("\n");
  const [open, setOpen] = useState(false);
  return (
    <div className="tl-error">
      <Icon name="x" size={13} />
      <div>
        <strong>{first}</strong>
        {rest.join("").trim() && (
          <>
            <button className="tl-link" onClick={() => setOpen(!open)}>{open ? "esconder detalhes" : "ver detalhes"}</button>
            {open && <pre>{rest.join("\n")}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function Steps({ list, tree, data, clientAgents }: { list: Step[]; tree: Map<number | null, Step[]>; data: any; clientAgents: any[] }) {
  return (
    <>
      {list.map((s) => (
        <StepItem key={s.id} step={s} kids={tree.get(s.id) ?? []} tree={tree} data={data} clientAgents={clientAgents} />
      ))}
    </>
  );
}

function Chips({ s }: { s: Step }) {
  return (
    <span className="tl-chips">
      {s.model && <span className="tl-chip mono">{s.model.replace(/^[^/]+\//, "")}</span>}
      {Number(s.tokens_in) + Number(s.tokens_out) > 0 && <span className="tl-chip mono">{tok(s.tokens_in)} → {tok(s.tokens_out)}</span>}
      {Number(s.cost_usd) > 0 && <span className="tl-chip mono">{usdBR(s.cost_usd)}</span>}
    </span>
  );
}

function StepItem({ step: s, kids, tree, data, clientAgents }: { step: Step; kids: Step[]; tree: Map<number | null, Step[]>; data: any; clientAgents: any[] }) {
  const [open, setOpen] = useState(false);
  const me = agentMeta(s.agent, clientAgents);
  const toggle = () => { haptic(4); setOpen(!open); };
  const err = s.status === "error";
  const running = s.status === "running";
  const time = <span className="tl-time mono">{running ? "…" : dur(s.duration_ms)}</span>;

  // Delegação: o CTO (ou um colega) chama um especialista; o trabalho dele fica aninhado
  if (s.type === "delegate") {
    const target = agentMeta(s.name.replace(/^(ask|consult)_/, ""), clientAgents);
    const ask = s.input?.message ?? s.input?.question;
    const answer = s.output?.report ?? s.output?.answer;
    return (
      <div className={`tl-item tl-delegate ${err ? "err" : ""} ${running ? "running" : ""}`}>
        <div className="tl-rail"><AgentAvatar meta={target} size={30} /></div>
        <div className="tl-body">
          <div className="tl-head static">
            <span className="tl-title">{who(me)} chamou {who(target)}</span>
            <span className="tl-role">{target.name}</span>
            <span className="spacer" />
            {time}
          </div>
          {ask && <div className="tl-quote">{ask}</div>}
          {err && s.error && <ErrorText text={s.error} />}
          {kids.length > 0 && (
            <div className="tl-group">
              <Steps list={kids} tree={tree} data={data} clientAgents={clientAgents} />
            </div>
          )}
          {answer && (
            <div className={`tl-answer ${open ? "open" : ""}`}>
              <div className="tl-answer-head"><AgentAvatar meta={target} size={18} /> <strong>{who(target)}</strong> respondeu</div>
              <div className="tl-answer-text">{answer}</div>
              {String(answer).length > 280 && <button className="tl-link" onClick={toggle}>{open ? "mostrar menos" : "mostrar tudo"}</button>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Mensagem enviada para a pessoa
  if (s.type === "channel") {
    const text = s.input?.text;
    const progress = s.name === "aviso_andamento";
    return (
      <div className={`tl-item tl-send ${err ? "err" : ""}`}>
        <div className="tl-rail"><span className="tl-dot"><Icon name="send" size={13} /></span></div>
        <div className="tl-body">
          <div className="tl-head static">
            <span className="tl-title">{toolLabel(s.name)}</span>
            <span className="spacer" />
            <span className="tl-time mono">{clock(s.started_at)}</span>
          </div>
          {text ? <div className={`bubble out ${progress ? "soft" : ""}`}>{text}</div> : s.input?.media ? <div className="tl-sub">imagem anexada</div> : null}
          {err && s.error && <ErrorText text={s.error} />}
        </div>
      </div>
    );
  }

  // Trava ou atalho (sem IA)
  if (s.type === "info") {
    const guard = s.name.startsWith("trava");
    return (
      <div className={`tl-item tl-info ${guard ? "guard" : ""}`}>
        <div className="tl-rail"><span className="tl-dot"><Icon name={guard ? "shield" : "check"} size={13} /></span></div>
        <div className="tl-body">
          <div className="tl-head" onClick={toggle} role="button" aria-expanded={open}>
            <span className="tl-title">{s.name.charAt(0).toUpperCase() + s.name.slice(1)}</span>
            <span className="tl-sub inline">{argSummary(s.input)}</span>
            <span className="spacer" />
            <Icon name="chevron-right" size={14} className={`tl-chev ${open ? "open" : ""}`} />
          </div>
          {open && <IO step={s} />}
        </div>
      </div>
    );
  }

  // Chamada de IA: discreta e fechada por padrão
  if (s.type === "llm") {
    const said = typeof s.output?.content === "string" ? s.output.content.trim() : "";
    const calls: string[] = (s.output?.tool_calls ?? []).map((c: any) => c?.function?.name).filter(Boolean);
    return (
      <div className={`tl-item tl-llm ${err ? "err" : ""} ${running ? "running" : ""}`}>
        <div className="tl-rail"><span className="tl-dot small"><Icon name="sparkle" size={11} /></span></div>
        <div className="tl-body">
          <div className="tl-head" onClick={toggle} role="button" aria-expanded={open}>
            <span className="tl-title">{running ? `${who(me)} está pensando` : `${who(me)} pensou`}</span>
            {!open && calls.length > 0 && <span className="tl-sub inline">e decidiu: {calls.map((c) => callLabel(c, clientAgents)).join(", ")}</span>}
            <span className="spacer" />
            <Chips s={s} />
            {time}
            <Icon name="chevron-right" size={14} className={`tl-chev ${open ? "open" : ""}`} />
          </div>
          {err && s.error && <ErrorText text={s.error} />}
          {open && (
            <div className="tl-detail">
              {said && <div className="tl-said">{said}</div>}
              {calls.length > 0 && <div className="tl-calls">{calls.map((c, i) => <span key={i} className="chip"><Icon name={c.startsWith("ask_") || c.startsWith("consult_") ? "arrow" : toolIcon(c)} size={12} /> {callLabel(c, clientAgents, true)}</span>)}</div>}
              <IO step={s} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Ferramenta
  const summary = argSummary(s.input);
  return (
    <div className={`tl-item tl-tool ${err ? "err" : ""} ${running ? "running" : ""}`}>
      <div className="tl-rail"><span className="tl-dot"><Icon name={toolIcon(s.name)} size={13} /></span></div>
      <div className="tl-body">
        <div className="tl-head" onClick={toggle} role="button" aria-expanded={open}>
          <span className="tl-title">{toolLabel(s.name)}</span>
          {s.output?.cache && <span className="chip-mini">cache</span>}
          <span className="spacer" />
          <Chips s={s} />
          {time}
          <Icon name="chevron-right" size={14} className={`tl-chev ${open ? "open" : ""}`} />
        </div>
        {summary && <div className="tl-sub">{summary}</div>}
        {err && s.error && <ErrorText text={s.error} />}
        {open && <IO step={s} />}
        {kids.length > 0 && (
          <div className="tl-group">
            <Steps list={kids} tree={tree} data={data} clientAgents={clientAgents} />
          </div>
        )}
      </div>
    </div>
  );
}

function IO({ step }: { step: Step }) {
  return (
    <div className="tl-io">
      <div>
        <small>Entrada</small>
        <Json value={step.input} />
      </div>
      <div>
        <small>Saída</small>
        <Json value={step.output} />
      </div>
    </div>
  );
}

/* ---------- Coluna lateral ---------- */

function SideCard({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <div className="card exd-card">
      <div className="exd-card-head"><Icon name={icon} size={14} /><small>{title}</small></div>
      {children}
    </div>
  );
}

function TeamCard({ steps, clientAgents }: { steps: Step[]; clientAgents: any[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { agent: string; actions: number; llm: number; cost: number; ms: number; errors: number }>();
    for (const s of steps) {
      const r = m.get(s.agent) ?? { agent: s.agent, actions: 0, llm: 0, cost: 0, ms: 0, errors: 0 };
      if (s.type === "llm") {
        r.llm++;
        r.ms += Number(s.duration_ms ?? 0);
      } else if (s.type === "tool" || s.type === "delegate") r.actions++;
      r.cost += Number(s.cost_usd ?? 0);
      if (s.status === "error") r.errors++;
      m.set(s.agent, r);
    }
    return [...m.values()].sort((a, b) => (a.agent === "cto" ? -1 : b.agent === "cto" ? 1 : b.cost - a.cost));
  }, [steps]);
  const total = rows.reduce((a, r) => a + r.cost, 0);
  return (
    <SideCard title="Quem trabalhou" icon="users">
      {rows.length ? (
        <div className="exd-team">
          {rows.map((r) => {
            const m = agentMeta(r.agent, clientAgents);
            return (
              <div key={r.agent} className="exd-team-row">
                <AgentAvatar meta={m} size={32} />
                <div className="exd-team-text">
                  <strong>{who(m)}</strong>
                  <small>{m.persona ? m.name : ""}{m.persona ? " · " : ""}{r.llm} IA · {plural(r.actions, "ação", "ações")}{r.errors ? ` · ${r.errors} erro${r.errors > 1 ? "s" : ""}` : ""}</small>
                  <span className="exd-bar"><i style={{ width: `${total ? Math.max(3, (r.cost / total) * 100) : 0}%` }} /></span>
                </div>
                <span className="mono exd-team-cost">{usdBR(r.cost)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted exd-none">Ninguém do time precisou entrar.</p>
      )}
    </SideCard>
  );
}

function ToolsCard({ steps }: { steps: Step[] }) {
  const tools = new Map<string, { n: number; err: number }>();
  for (const s of steps) {
    if (s.type !== "tool") continue;
    const t = tools.get(s.name) ?? { n: 0, err: 0 };
    t.n++;
    if (s.status === "error") t.err++;
    tools.set(s.name, t);
  }
  if (!tools.size) return null;
  return (
    <SideCard title="Ferramentas usadas" icon="settings">
      <div className="exd-tools">
        {[...tools.entries()].map(([name, t]) => (
          <span key={name} className={`exd-tool ${t.err ? "err" : ""}`} title={name}>
            <Icon name={toolIcon(name)} size={13} /> {toolLabel(name)}
            {t.n > 1 && <b className="mono">{t.n}×</b>}
          </span>
        ))}
      </div>
    </SideCard>
  );
}

function InfoCard({ data, channel }: { data: any; channel: string | null }) {
  return (
    <SideCard title="Detalhes" icon="hash">
      <dl className="exd-kv">
        <dt>Pessoa</dt><dd>{data.user_name ?? (data.phone ? `+${data.phone}` : "Sistema")}</dd>
        {channel && <><dt>Canal</dt><dd>{channel}</dd></>}
        <dt>Gatilho</dt><dd>{TRIGGER_LABEL[data.trigger] ?? data.trigger}</dd>
        <dt>Início</dt><dd className="mono">{new Date(data.started_at).toLocaleString("pt-BR")}</dd>
        {data.finished_at && <><dt>Fim</dt><dd className="mono">{new Date(data.finished_at).toLocaleString("pt-BR")}</dd></>}
        <dt>ID</dt><dd className="mono exd-id" title={data.id}>{String(data.id).slice(0, 8)}</dd>
      </dl>
      {data.conversation_id && (
        <Link className="btn btn-sm exd-conv" to={`/executions?conversation=${data.conversation_id}`}>
          <Icon name="list" size={13} /> Outras desta conversa
        </Link>
      )}
    </SideCard>
  );
}

/* ---------- Canvas (estilo n8n) ---------- */

function StepPanel({ step, data, clientAgents }: { step: Step | null; data: any; clientAgents: any[] }) {
  if (!step) {
    return (
      <div className="card exd-step">
        <div className="exd-card-head"><Icon name="send" size={14} /><small>Entrada e saída</small><span className="spacer" /><span className="muted exd-hint">toque num nó para ver o passo</span></div>
        <div className="tl-io">
          <div><small>Mensagens recebidas</small><Json value={data.content_purged ? "apagado por privacidade" : data.input} /></div>
          <div><small>Resposta do CTO</small><Json value={data.content_purged ? "apagado por privacidade" : data.output} /></div>
        </div>
      </div>
    );
  }
  const m = agentMeta(step.agent, clientAgents);
  return (
    <div className="card exd-step">
      <div className="exd-card-head">
        <Icon name={step.type === "tool" ? toolIcon(step.name) : TYPE_ICON[step.type] ?? "circle"} size={14} />
        <strong>{step.type === "tool" || step.type === "channel" ? toolLabel(step.name) : step.type === "delegate" ? `${who(m)} chamou ${who(agentMeta(step.name.replace(/^(ask|consult)_/, ""), clientAgents))}` : step.type === "llm" ? `${who(m)} pensou` : step.name}</strong>
        {step.type !== "delegate" && step.type !== "llm" && <span className="muted">{who(m)}</span>}
        <Status status={step.status} />
        <span className="spacer" />
        <Chips s={step} />
        <span className="tl-time mono">{dur(step.duration_ms)}</span>
      </div>
      {step.error && <ErrorText text={step.error} />}
      <IO step={step} />
    </div>
  );
}

/**
 * Desenho da execução no estilo do canvas do n8n: gatilho → CTO → especialistas → resposta.
 * Setas entre especialistas mostram quando um consultou o outro; o número é quantas vezes conversaram.
 */
function FlowCanvas({ data, steps, onSelect, selected }: { data: any; steps: Step[]; onSelect: (id: number | null) => void; selected: Step | null }) {
  const talks = steps.filter((s) => s.type === "delegate");
  const targetOf = (s: Step) => s.name.replace(/^(ask|consult)_/, "");
  const agents: string[] = [];
  for (const t of talks) for (const a of [t.agent, targetOf(t)]) if (a !== "cto" && !agents.includes(a)) agents.push(a);
  const sends = steps.filter((s) => s.type === "channel");
  const ctoLlm = steps.filter((s) => s.agent === "cto" && s.type === "llm");
  const W = 190;
  const H = 64;
  const col = (i: number) => 30 + i * 232;
  const rows = Math.max(1, agents.length);
  const height = Math.max(200, rows * 92 + 50);
  const midY = height / 2 - H / 2;

  const statusOf = (list: Step[]) => (list.some((s) => s.status === "error") ? "err" : list.length && list.every((s) => s.status === "success") ? "ok" : "");
  type N = { key: string; x: number; y: number; icon: string; face?: Face | null; title: string; sub: string; status: string; step?: Step };
  const nodes: N[] = [
    { key: "trigger", x: col(0), y: midY, icon: TRIGGER_ICON[data.trigger] ?? "play", title: "Gatilho", sub: TRIGGER_LABEL[data.trigger] ?? data.trigger, status: "ok" },
    { key: "cto", x: col(1), y: midY, icon: "brain", face: CORE_FACES.cto?.face, title: "Téo · CTO", sub: `${ctoLlm.length} chamadas · ${(ctoLlm[0]?.model ?? "").replace(/^[^/]+\//, "")}`, status: statusOf(ctoLlm), step: ctoLlm[0] },
    ...agents.map((a, i) => {
      const own = steps.filter((s) => s.agent === a);
      const tools = [...new Set(own.filter((s) => s.type === "tool").map((s) => toolLabel(s.name).toLowerCase()))];
      const first = talks.find((t) => targetOf(t) === a);
      const m = agentMeta(a, data.client_agents ?? []);
      return {
        key: a,
        x: col(2),
        y: 25 + i * 92 + (rows - agents.length) * 46,
        icon: m.icon,
        face: m.face,
        title: m.persona ? `${m.persona} · ${m.name}` : m.name,
        sub: tools.join(", ") || "conversou",
        status: statusOf(own),
        step: first,
      };
    }),
    { key: "out", x: col(agents.length ? 3 : 2) + (agents.length ? 36 : 0), y: midY, icon: "send", title: "Resposta", sub: sends.length ? `${sends.length} mensagem(ns)` : data.output === "[[silencio]]" ? "silêncio (só reação)" : "–", status: statusOf(sends), step: sends[0] },
  ];
  const pos = new Map(nodes.map((n) => [n.key, n]));
  const running = data.status === "running";

  // conversas únicas (de -> para) com contagem
  const pairs = new Map<string, { from: string; to: string; n: number; active: boolean }>();
  for (const t of talks) {
    const k = `${t.agent}>${targetOf(t)}`;
    const p = pairs.get(k) ?? { from: t.agent, to: targetOf(t), n: 0, active: false };
    p.n++;
    p.active ||= t.status === "running";
    pairs.set(k, p);
  }

  const curve = (a: string, b: string, active = false, label?: string) => {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) return null;
    if (p.x === q.x) {
      // colega -> colega: arco pela direita
      const x = p.x + W;
      const y1 = p.y + H / 2;
      const y2 = q.y + H / 2;
      const bulge = 40 + Math.abs(y2 - y1) * 0.25;
      return (
        <g key={`${a}-${b}`}>
          <path className={`edge peer ${active ? "active" : ""}`} d={`M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`} markerEnd="url(#arrow)" />
          {label && <text className="edge-label" x={x + bulge * 0.8} y={(y1 + y2) / 2}>{label}</text>}
        </g>
      );
    }
    const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, dx = (x2 - x1) / 2;
    return (
      <g key={`${a}-${b}`}>
        <path className={`edge ${active ? "active" : ""}`} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} />
        {label && <text className="edge-label" x={x1 + dx} y={(y1 + y2) / 2 - 6}>{label}</text>}
      </g>
    );
  };
  const width = (pos.get("out")!.x) + W + 40;

  return (
    <div className="canvas exd-flow">
      <div style={{ position: "relative", width, height, margin: "0 auto" }}>
        <svg className="edges" width={width} height={height}>
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
            </marker>
          </defs>
          {curve("trigger", "cto", running)}
          {[...pairs.values()].map((p) => curve(p.from, p.to, running && p.active, p.n > 1 ? `${p.n}×` : undefined))}
          {curve("cto", "out")}
        </svg>
        {nodes.map((n) => (
          <div
            key={n.key}
            className={`node ${n.status} ${selected && n.step && selected.id === n.step.id ? "selected" : ""}`}
            style={{ left: n.x, top: n.y, width: W }}
            onClick={() => { haptic(4); onSelect(n.step?.id ?? null); }}
          >
            {n.status && (
              <div className="node-badge" style={{ background: n.status === "ok" ? "var(--ok)" : "var(--err)" }}>
                <Icon name={n.status === "ok" ? "check" : "x"} size={11} />
              </div>
            )}
            <div className="node-title">
              {n.face !== undefined ? <AgentFace face={n.face} size={30} /> : <div className="node-icon"><Icon name={n.icon} size={16} /></div>}
              <span className="ellipsis" style={{ maxWidth: W - 64 }}>{n.title}</span>
            </div>
            <div className="node-sub ellipsis" style={{ maxWidth: W - 24 }} title={n.sub}>{n.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
