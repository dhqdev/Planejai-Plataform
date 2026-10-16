import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ago, api, ms, usd } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi, useMedia } from "../hooks";
import { Icon } from "../icons";
import { Mascote, type Mood, type Outfit } from "../mascote/Mascote";
import { haptic } from "../touch";

/**
 * Esteira de desenvolvimento (só o dono): chamado escrito aqui passa sozinho por entender, planejar,
 * codar, revisar, abrir PR e esperar o CI. Quadro com os chamados por situação e, em cada um,
 * a linha do tempo com o que cada etapa viu, decidiu e custou.
 */

interface TeamMember {
  id: string;
  name: string;
  role: string;
  does: string;
  models: string[];
  working: { id: number; title: string; stage: string; since: string }[];
  last: { to_agent: string; text: string; ticket_id: number; created_at: string } | null;
  week: { calls: number; cost: number };
}
interface Agent {
  name: string;
  role: string;
  route: string;
}
interface Status {
  ready: boolean;
  missing?: string | null;
  problems: string[];
  warnings?: string[];
  tokenFrom: string | null;
  needRepo: boolean;
  repo?: string;
  base?: string;
  costCap?: number;
  stages: Record<string, string>;
  agents: Record<string, Agent>;
  stageAgent: Record<string, string>;
  levels?: Record<string, string>;
  settings: { repo?: string; base_branch?: string; cost_cap?: string };
}
type Msg = { agent: string; to: string; text: string };
interface Ticket {
  id: number;
  title: string;
  spec_title: string | null;
  kind: string;
  stage: string;
  failed_stage: string | null;
  pr_number: number | null;
  pr_url: string | null;
  fix_rounds: number;
  error: string | null;
  cost_usd: number;
  created_at: string;
  stage_started_at: string;
  level?: string | null;
  images?: number | number[];
  last_msg?: Msg | null;
}
interface Step {
  id: number;
  stage: string;
  name: string;
  status: string;
  kind: string;
  agent: string | null;
  to_agent: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  summary: string | null;
  detail: any;
  execution_id: string | null;
  created_at: string;
}
interface Detail extends Ticket {
  description: string;
  spec: any;
  plan: any;
  review: any;
  branch: string | null;
  ci: any;
  tokens_in: number;
  tokens_out: number;
  files: { path: string; deleted: boolean; diff: string }[] | null;
  changes_summary: string | null;
  level_auto?: boolean;
  image_notes?: string | null;
  images?: number[];
  steps: Step[];
}

/** Título que o analista deu, se for um título de verdade; senão o que o dono escreveu. */
const titleOf = (t: { title: string; spec_title?: string | null; spec?: any }) => {
  const s = (t.spec_title ?? t.spec?.titulo ?? "").trim();
  return s.length > 3 ? s : t.title;
};

/** A ordem das etapas na barrinha de progresso de cada chamado. */
const FLOW = ["entendendo", "planejando", "codando", "revisando", "abrindo_pr", "testando", "pronto"];
const WORKING = new Set(["fila", "entendendo", "planejando", "codando", "revisando", "abrindo_pr", "testando", "corrigindo"]);
const STOPPED = new Set(["precisa_de_voce", "falhou", "cancelado"]);
const KIND: Record<string, string> = { bug: "Bug", melhoria: "Melhoria", nova: "Coisa nova" };
/** Nível: decide quantas etapas e qual modelo (simples pula o arquiteto e usa o modelo barato). */
const LEVEL: Record<string, string> = { auto: "Automático", simples: "Simples", medio: "Médio", complexo: "Complexo" };
const LEVEL_HINT: Record<string, string> = {
  auto: "A Lia decide pelo tamanho do pedido.",
  simples: "Texto, estilo ou uma condição: pula o arquiteto, modelo barato e revisão só se o diff crescer.",
  medio: "Alguns arquivos: o time inteiro, uma volta de revisão e até 2 consertos do CI.",
  complexo: "Vários módulos ou migração: lê mais do repositório, o Caio vê as imagens e até 3 consertos.",
};
const MAX_IMAGES = 4;

/** Print ou foto → data URL reduzida (lado maior 1600 px), para subir leve e o modelo ler barato. */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("Não deu para abrir essa imagem."));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL("image/webp", 0.88);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Cada agente tem uma cor fixa: avatar da coluna, recados no card e na conversa. */
const AGENT_TONE: Record<string, string> = { lia: "#c2410c", beto: "#2563eb", caio: "#7c3aed", vera: "#0f766e", tito: "#b45309", dono: "#52525b" };

/** Colunas: fila, um agente por etapa (o card fica com quem está trabalhando nele) e o fim. */
function columnsOf(st: Status): { key: string; label: string; agent?: string; has: (s: string) => boolean }[] {
  return [
    { key: "fila", label: "Na fila", has: (s) => s === "fila" },
    ...Object.keys(st.agents).map((id) => ({ key: id, label: st.agents[id]!.name, agent: id, has: (s: string) => st.stageAgent[s] === id })),
    { key: "pronto", label: "Pronto para revisar", has: (s) => s === "pronto" },
    { key: "parado", label: "Parado", has: (s) => STOPPED.has(s) },
  ];
}

/** Cada agente é um Mascote com a roupa do trabalho dele, numa bolinha da cor dele. */
const AGENT_LOOK: Record<string, Outfit> = {
  lia: { eyes: "glasses", head: "flower" },
  beto: { head: "hardhat", neck: "toolbelt" },
  caio: { head: "headphones", neck: "bandana" },
  vera: { eyes: "monocle", neck: "pearls" },
  tito: { head: "cap", neck: "stethoscope" },
};

function AgentDot({ id, agents, size = 26, mood, live = false }: { id: string; agents: Record<string, Agent>; size?: number; mood?: Mood; live?: boolean }) {
  const name = id === "dono" ? "Você" : agents[id]?.name ?? id;
  if (!AGENT_LOOK[id]) {
    return (
      <span className="dev-agent" style={{ width: size, height: size, background: AGENT_TONE[id] ?? "#71717a", fontSize: size * 0.46 }} title={name} aria-hidden>
        {name.slice(0, 1)}
      </span>
    );
  }
  return (
    <span className="dev-agent dev-agent-face" style={{ width: size, height: size, background: AGENT_TONE[id] }} title={name} aria-hidden>
      <Mascote size={Math.round(size * 0.86)} outfit={AGENT_LOOK[id]} mood={mood ?? "idle"} still={!live} crop />
    </span>
  );
}
const who = (id: string | null | undefined, agents: Record<string, Agent>) => (id === "dono" ? "você" : id ? agents[id]?.name ?? id : "");

function progress(stage: string, failed: string | null) {
  const at = stage === "corrigindo" ? "testando" : STOPPED.has(stage) ? failed ?? "entendendo" : stage;
  return Math.max(0, FLOW.indexOf(at));
}

function StageBadge({ stage, label }: { stage: string; label: string }) {
  const cls = stage === "pronto" ? "badge-ok" : stage === "falhou" ? "badge-err" : stage === "precisa_de_voce" ? "badge-warn" : WORKING.has(stage) ? "badge-info" : "";
  return (
    <span className={`badge ${cls}`}>
      {WORKING.has(stage) && stage !== "fila" && <span className="dot dot-warn dev-live" />}
      {label}
    </span>
  );
}

function Flow({ stage, failed }: { stage: string; failed: string | null }) {
  const at = progress(stage, failed);
  return (
    <div className={`dev-flow${stage === "falhou" ? " bad" : ""}`} aria-hidden>
      {FLOW.map((s, i) => <i key={s} className={i < at || stage === "pronto" ? "done" : i === at && stage !== "fila" ? "now" : ""} />)}
    </div>
  );
}

export function EsteiraPage() {
  const status = useApi<Status>("/api/dev/status");
  const list = useApi<Ticket[]>("/api/dev/tickets", { poll: 5000 });
  const [params, setParams] = useSearchParams();
  const open = Number(params.get("t")) || null;
  const [creating, setCreating] = useState(false);
  const phone = useMedia("(max-width: 767px)");
  const [view, setView] = useState<"quadro" | "time">("quadro");
  const labels = status.data?.stages ?? {};

  const openTicket = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("t", String(id));
    else p.delete("t");
    setParams(p, { replace: !id });
  };

  if (list.error) return <div className="page"><ErrorBox error={list.error} /></div>;
  if (!list.data || !status.data) return <Loading />;
  const tickets = list.data;

  return (
    <div className="page page-wide dev-page">
      <PageHead
        title="Esteira"
        subtitle={`Cada coluna é um agente: a Lia entende, o Beto planeja, o Caio coda, a Vera revisa e o Tito testa${status.data.ready ? ` em ${status.data.repo}` : ""}. Eles conversam no card e você só revisa e mescla o PR.`}
        actions={
          <button className="btn btn-primary" onClick={() => { haptic(); setCreating(true); }} disabled={!status.data.ready}>
            <Icon name="plus" size={16} /> Novo chamado
          </button>
        }
      />
      {!status.data.ready && <Setup st={status.data} onSaved={(d) => status.setData(d)} />}
      {status.data.ready && Boolean(status.data.warnings?.length) && (
        <div className="card card-pad dev-warn">{status.data.warnings!.map((w) => <p key={w}>{w}</p>)}</div>
      )}

      {phone && (
        <div className="seg dev-view" role="tablist" aria-label="Ver">
          <button className={view === "quadro" ? "active" : ""} aria-pressed={view === "quadro"} onClick={() => setView("quadro")}>Chamados ({tickets.length})</button>
          <button className={view === "time" ? "active" : ""} aria-pressed={view === "time"} onClick={() => setView("time")}>O time</button>
        </div>
      )}
      <div className="dev-layout">
        {(!phone || view === "quadro") && (
          <div className="dev-main">
            {!tickets.length ? (
              <div className="card">
                <Empty>Nenhum chamado ainda. Escreva o que quer mudar, do jeito que você falaria para um dev, e a esteira cuida do resto.</Empty>
              </div>
            ) : (
              <div className="dev-board">
                {columnsOf(status.data).map((col) => {
                  const items = tickets.filter((t) => col.has(t.stage));
                  const a = col.agent ? status.data!.agents[col.agent] : null;
                  if (phone && !items.length) return null;
                  return (
                    <section key={col.key} className={`dev-col${a ? " dev-col-agent" : ""}`}>
                      <header>
                        {a ? (
                          <span className="dev-col-who">
                            <AgentDot id={col.agent!} agents={status.data!.agents} size={phone ? 34 : 28} mood={items.length ? "working" : "idle"} />
                            <span>
                              <strong>{a.name}</strong>
                              <small className="muted">{a.role}</small>
                            </span>
                          </span>
                        ) : (
                          <span>{col.label}</span>
                        )}
                        <span className="dev-col-count">{items.length}</span>
                      </header>
                      {items.map((t) => (
                        <button key={t.id} className="dev-card" onClick={() => { haptic(5); openTicket(t.id); }}>
                          <div className="dev-card-top">
                            <span className="muted mono">#{t.id}</span>
                            <span className="spacer" />
                            <span className="muted mono">{usd(t.cost_usd)}</span>
                          </div>
                          <strong className="dev-card-title">{titleOf(t)}</strong>
                          <div className="dev-card-tags muted">
                            {KIND[t.kind] ?? t.kind}
                            {t.level && ` · ${LEVEL[t.level] ?? t.level}`}
                            {Number(t.images) > 0 && ` · ${Number(t.images)} 📎`}
                          </div>
                          <Flow stage={t.stage} failed={t.failed_stage} />
                          {t.last_msg && (
                            <div className="dev-card-msg">
                              <AgentDot id={t.last_msg.agent} agents={status.data!.agents} size={18} />
                              <span><b>{who(t.last_msg.agent, status.data!.agents)} → {who(t.last_msg.to, status.data!.agents)}:</b> {t.last_msg.text}</span>
                            </div>
                          )}
                          <div className="dev-card-foot">
                            <StageBadge stage={t.stage} label={labels[t.stage] ?? t.stage} />
                            {t.pr_number && <span className="muted">PR #{t.pr_number}</span>}
                            <span className="spacer" />
                            <span className="muted">{ago(t.stage_started_at)}</span>
                          </div>
                        </button>
                      ))}
                      {!items.length && <div className="dev-col-empty muted">Nada aqui</div>}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {(!phone || view === "time") && <TeamPanel agents={status.data.agents} labels={labels} onOpen={openTicket} />}
      </div>

      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); void list.reload(); openTicket(id); }} />}
      {open && <TicketModal id={open} labels={labels} agents={status.data.agents} onClose={() => openTicket(null)} onChange={() => void list.reload()} />}
    </div>
  );
}

/** Sem GitHub pronto: diz exatamente o que falta e deixa escolher o repositório aqui mesmo. */
function Setup({ st, onSaved }: { st: Status; onSaved: (s: Status) => void }) {
  const [repo, setRepo] = useState(st.settings.repo || st.repo || "");
  const [base, setBase] = useState(st.settings.base_branch || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (save: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      onSaved(save ? await api<Status>("/api/dev/settings", { method: "PUT", json: { repo, base_branch: base } }) : await api<Status>("/api/dev/status?fresh=1"));
      haptic();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const problems = st.problems.length ? st.problems : st.missing ? [st.missing] : [];
  return (
    <div className="card card-pad dev-setup">
      <div className="dev-setup-head">
        <Icon name="github" size={20} />
        <div>
          <strong>{st.tokenFrom ? "Quase lá: falta acertar o GitHub da esteira" : "Falta conectar o GitHub"}</strong>
          <p className="muted">{st.tokenFrom ? `Usando o token de ${st.tokenFrom}.` : "A esteira usa o token do GitHub que você conecta em Integrações."}</p>
        </div>
      </div>
      <ul className="dev-setup-list">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      {st.tokenFrom ? (
        <div className="dev-setup-form">
          <div className="field">
            <label htmlFor="dev-repo">Repositório</label>
            <input id="dev-repo" className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="dono/repositorio" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="dev-base">Branch base</label>
            <input id="dev-base" className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" autoComplete="off" />
          </div>
          <div className="dev-setup-acts">
            <button className="btn btn-primary" disabled={busy || !repo.trim()} onClick={() => run(true)}>{busy ? "Conferindo…" : "Salvar e conferir"}</button>
            <Link className="btn" to="/integrations">Trocar o token</Link>
          </div>
        </div>
      ) : (
        <div className="dev-setup-acts">
          <Link className="btn btn-primary" to="/integrations">Abrir Integrações</Link>
          <button className="btn" disabled={busy} onClick={() => run(false)}>Conferir de novo</button>
        </div>
      )}
      {err && <ErrorBox error={err} />}
    </div>
  );
}

/** Painel do lado do quadro (no celular, aba "O time"): quem é cada um, o que faz e o que está fazendo agora. */
function TeamPanel({ agents, labels, onOpen }: { agents: Record<string, Agent>; labels: Record<string, string>; onOpen: (id: number) => void }) {
  const team = useApi<TeamMember[]>("/api/dev/team", { poll: 5000 });
  return (
    <aside className="dev-team" aria-label="O time da esteira">
      <h3>O time</h3>
      {team.error && <ErrorBox error={team.error} />}
      {!team.data ? (
        <Loading />
      ) : (
        team.data.map((m) => (
          <article key={m.id} className={`dev-member${m.working.length ? " busy" : ""}`} style={{ ["--tone" as string]: AGENT_TONE[m.id] }}>
            <div className="dev-member-head">
              <AgentDot id={m.id} agents={agents} size={56} mood={m.working.length ? "working" : "sleepy"} live />
              <div>
                <strong>{m.name}</strong>
                <span className="muted">{m.role}</span>
                <span className={`dev-member-state${m.working.length ? " on" : ""}`}>{m.working.length ? `Trabalhando em ${m.working.length}` : "Livre"}</span>
              </div>
            </div>
            <p className="dev-member-does">{m.does}</p>
            {m.working.length > 0 && (
              <ul className="dev-member-now">
                {m.working.map((w) => (
                  <li key={w.id}>
                    <button onClick={() => onOpen(w.id)}>
                      <span className="mono muted">#{w.id}</span> <span className="ellipsis">{w.title}</span>
                      <small className="muted">{labels[w.stage] ?? w.stage} · {ago(w.since)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {m.last && (
              <button className="dev-member-last" onClick={() => onOpen(m.last!.ticket_id)}>
                <small className="muted">Último recado para {who(m.last.to_agent, agents)} · #{m.last.ticket_id} · {ago(m.last.created_at)}</small>
                <span>{m.last.text}</span>
              </button>
            )}
            <div className="dev-member-meta muted">
              <span className="mono ellipsis" title={m.models.join(", ")}>{m.models.map((x) => x.split("/").pop()).join(" · ")}</span>
              <span>{m.week.calls} chamadas · {usd(m.week.cost)} em 7 dias</span>
            </div>
          </article>
        ))
      )}
    </aside>
  );
}

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState("melhoria");
  const [level, setLevel] = useState("auto");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const addFiles = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/") && f.type !== "image/svg+xml");
    if (!pics.length) return;
    setErr(null);
    try {
      const room = MAX_IMAGES - images.length;
      if (pics.length > room) setErr(`Até ${MAX_IMAGES} imagens por chamado.`);
      const added = await Promise.all(pics.slice(0, Math.max(0, room)).map(shrinkImage));
      setImages((cur) => [...cur, ...added].slice(0, MAX_IMAGES));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: number }>("/api/dev/tickets", { method: "POST", json: { title, description, kind, level: level === "auto" ? "" : level, images } });
      haptic();
      onCreated(r.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo chamado"
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn" onClick={close}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy || title.trim().length < 3 || description.trim().length < 10} onClick={send}>
            {busy ? "Mandando…" : "Mandar para a esteira"}
          </button>
        </>
      )}
    >
      <div className="seg dev-kind" role="group" aria-label="Tipo">
        {Object.entries(KIND).map(([k, v]) => (
          <button key={k} className={kind === k ? "active" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>{v}</button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="dev-title">Título</label>
        <input id="dev-title" className="input" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: lembrete repetido não para depois de cancelar" autoFocus />
      </div>
      <div className="field">
        <label htmlFor="dev-desc">O que acontece e o que você quer</label>
        <textarea
          id="dev-desc"
          className="input"
          rows={7}
          value={description}
          maxLength={8000}
          onChange={(e) => setDescription(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder="Conte como falaria para um dev: onde aparece, o que esperava e, se souber, como reproduzir. Dá para colar um print aqui."
        />
      </div>
      <div className="field">
        <label>Imagens <span className="muted">(prints ou fotos, até {MAX_IMAGES})</span></label>
        <div className="dev-pics">
          {images.map((src, i) => (
            <div key={i} className="dev-pic">
              <img src={src} alt={`Imagem ${i + 1}`} />
              <button type="button" aria-label="Tirar imagem" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
            </div>
          ))}
          {images.length < MAX_IMAGES && (
            <label className="dev-pic dev-pic-add">
              <Icon name="plus" size={18} />
              <span>Anexar</span>
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
            </label>
          )}
        </div>
      </div>
      <div className="field">
        <label>Nível</label>
        <div className="seg dev-kind" role="group" aria-label="Nível">
          {Object.entries(LEVEL).map(([k, v]) => (
            <button key={k} className={level === k ? "active" : ""} aria-pressed={level === k} onClick={() => setLevel(k)}>{v}</button>
          ))}
        </div>
        <p className="muted dev-hint">{LEVEL_HINT[level]}</p>
      </div>
      <p className="muted dev-hint">A esteira descreve melhor o problema, planeja, escreve o código, revisa, abre um PR em rascunho e espera o CI. Nada vai para a main sem você mesclar.</p>
      {err && <ErrorBox error={err} />}
    </Modal>
  );
}

function TicketModal({ id, labels, agents, onClose, onChange }: { id: number; labels: Record<string, string>; agents: Record<string, Agent>; onClose: () => void; onChange: () => void }) {
  const { data, error, reload } = useApi<Detail>(`/api/dev/tickets/${id}`, { poll: 4000 });
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setErr(null), [id]);

  const act = async (path: string, json?: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/dev/tickets/${id}/${path}`, { method: "POST", json });
      haptic();
      setAnswer("");
      await reload();
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const t = data;
  return (
    <Modal title={t ? `#${t.id} ${titleOf(t)}` : "Chamado"} wide onClose={onClose} className="dev-modal">
      {error && <ErrorBox error={error} />}
      {!t ? (
        <Loading />
      ) : (
        <div className="dev-detail">
          <div className="dev-detail-head">
            <StageBadge stage={t.stage} label={labels[t.stage] ?? t.stage} />
            <span className="muted">
              {KIND[t.kind] ?? t.kind}
              {t.level ? ` · ${LEVEL[t.level] ?? t.level}${t.level_auto ? " (a Lia decidiu)" : ""}` : ""} · aberto {ago(t.created_at)}
            </span>
            <span className="spacer" />
            <span className="mono">{usd(t.cost_usd)}</span>
          </div>
          <Flow stage={t.stage} failed={t.failed_stage} />

          <div className="dev-actions">
            {t.pr_url && (
              <a className="btn btn-sm btn-primary" href={t.pr_url} target="_blank" rel="noreferrer">
                <Icon name="github" size={14} /> Abrir PR #{t.pr_number}
              </a>
            )}
            {(t.stage === "falhou" || t.stage === "cancelado") && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act("retry")}>
                <Icon name="refresh" size={14} /> Tentar de novo
              </button>
            )}
            {WORKING.has(t.stage) && (
              <button className="btn btn-sm" disabled={busy} onClick={() => act("cancel")}>
                <Icon name="x" size={14} /> Parar
              </button>
            )}
          </div>

          {t.error && <div className="dev-error">{t.error}</div>}

          {t.stage === "precisa_de_voce" && (
            <div className="dev-ask">
              <strong>A esteira precisa saber</strong>
              <ul>{(t.spec?.perguntas ?? []).map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>
              <textarea className="input" rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Sua resposta" />
              <button className="btn btn-sm btn-primary" disabled={busy || !answer.trim()} onClick={() => act("answer", { text: answer })}>Responder e continuar</button>
            </div>
          )}
          {err && <ErrorBox error={err} />}

          {t.steps.some((s) => s.kind === "msg") && (
            <section className="dev-sec">
              <h4>Conversa do time</h4>
              <ol className="dev-talk">
                {t.steps.filter((s) => s.kind === "msg").map((s) => (
                  <li key={s.id} className={s.to_agent === "dono" ? "to-you" : ""}>
                    <AgentDot id={s.agent ?? ""} agents={agents} size={28} />
                    <div className="dev-bubble">
                      <div className="dev-bubble-who">
                        <b>{who(s.agent, agents)}</b>
                        <span className="muted">{s.agent && agents[s.agent] ? agents[s.agent]!.role.toLowerCase() : ""} → {who(s.to_agent, agents)}</span>
                        <span className="spacer" />
                        <span className="muted">{ago(s.created_at)}</span>
                      </div>
                      <p>{s.summary}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {Boolean(t.images?.length) && (
            <section className="dev-sec">
              <h4>Imagens</h4>
              <div className="dev-pics">
                {t.images!.map((img) => (
                  <a key={img} className="dev-pic" href={`/api/dev/tickets/${t.id}/images/${img}`} target="_blank" rel="noreferrer">
                    <img src={`/api/dev/tickets/${t.id}/images/${img}`} alt="Imagem do chamado" loading="lazy" />
                  </a>
                ))}
              </div>
              {t.image_notes && <p className="muted dev-notes"><b>O que a Lia viu:</b> {t.image_notes}</p>}
            </section>
          )}

          {t.spec?.problema && (
            <section className="dev-sec">
              <h4>Como a esteira entendeu</h4>
              <dl className="kv">
                <dt>Problema</dt><dd>{t.spec.problema}</dd>
                <dt>Esperado</dt><dd>{t.spec.esperado}</dd>
                {t.spec.riscos?.length > 0 && <><dt>Riscos</dt><dd>{t.spec.riscos.join("; ")}</dd></>}
              </dl>
              {t.spec.criterios?.length > 0 && (
                <ul className="dev-checks">{t.spec.criterios.map((c: string, i: number) => <li key={i}><Icon name="check" size={13} /> {c}</li>)}</ul>
              )}
            </section>
          )}

          {t.plan?.passos?.length > 0 && (
            <section className="dev-sec">
              <h4>Plano</h4>
              <ol className="dev-plan">{t.plan.passos.map((p: string, i: number) => <li key={i}>{p}</li>)}</ol>
              {t.plan.testes && <p className="muted">Teste: {t.plan.testes}</p>}
            </section>
          )}

          {t.files?.length ? (
            <section className="dev-sec">
              <h4>Código ({t.files.length} {t.files.length === 1 ? "arquivo" : "arquivos"})</h4>
              {t.changes_summary && <p>{t.changes_summary}</p>}
              {t.files.map((f) => (
                <details key={f.path} className="dev-file">
                  <summary><span className="mono ellipsis">{f.path}</span>{f.deleted && <span className="badge badge-err">apagado</span>}</summary>
                  <pre className="dev-diff">{f.diff.split("\n").map((l, i) => <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l}{"\n"}</span>)}</pre>
                </details>
              ))}
            </section>
          ) : null}

          {t.review?.problemas?.length > 0 && (
            <section className="dev-sec">
              <h4>Revisor</h4>
              <ul>{t.review.problemas.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>
            </section>
          )}

          {t.ci?.log && (
            <section className="dev-sec">
              <h4>Log do CI</h4>
              <pre className="dev-diff">{t.ci.log}</pre>
            </section>
          )}

          <section className="dev-sec">
            <h4>Linha do tempo</h4>
            <ol className="dev-steps">
              {t.steps.filter((s) => s.kind !== "msg").map((s) => (
                <li key={s.id} className={s.status === "error" ? "bad" : ""}>
                  <span className="dev-step-dot" />
                  <div className="dev-step-main">
                    <div className="dev-step-top">
                      <strong>{s.name}</strong>
                      <span className="muted">{s.agent ? `${who(s.agent, agents)} · ` : ""}{labels[s.stage] ?? s.stage}</span>
                      <span className="spacer" />
                      {s.cost_usd > 0 && <span className="mono">{usd(s.cost_usd)}</span>}
                    </div>
                    {s.summary && <div className="dev-step-sum">{s.summary}</div>}
                    <div className="muted dev-step-meta">
                      {s.model && <span className="mono">{s.model}</span>}
                      {s.tokens_in + s.tokens_out > 0 && <span>{s.tokens_in.toLocaleString("pt-BR")} entrada · {s.tokens_out.toLocaleString("pt-BR")} saída</span>}
                      {s.duration_ms > 0 && <span>{ms(s.duration_ms)}</span>}
                      {s.execution_id && <Link to={`/executions/${s.execution_id}`}>ver em Execuções</Link>}
                    </div>
                  </div>
                </li>
              ))}
              {!t.steps.length && <li className="muted dev-steps-empty">Ainda na fila.</li>}
            </ol>
          </section>

          <details className="dev-file">
            <summary>Pedido original</summary>
            <p className="dev-original">{t.description}</p>
          </details>
        </div>
      )}
    </Modal>
  );
}

interface Costs {
  days: number;
  total: { cost: number; tokens_in: number; tokens_out: number; calls: number; tickets: number };
  done: { ready: number; failed: number; avg_ready: number };
  byStage: { stage: string; label: string; cost: number; calls: number; tickets: number; avg_ms: number }[];
  byAgent: { agent: string; name: string; role: string; cost: number; calls: number }[];
  byModel: { model: string; cost: number; calls: number; tokens_in: number; tokens_out: number }[];
  byDay: { day: string; cost: number }[];
  top: { id: number; title: string; stage: string; pr_number: number | null; cost: number }[];
}

const int = (n: number | string) => Number(n ?? 0).toLocaleString("pt-BR");

/** Quanto a esteira custa: por etapa, por modelo, por dia e por chamado (só o dono). */
export function EsteiraCustosPage() {
  const [days, setDays] = useState(30);
  const { data, error } = useApi<Costs>(`/api/dev/costs?days=${days}`);
  const [hover, setHover] = useState<{ day: string; cost: number } | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const fmtDay = (d: string) => d.split("-").reverse().slice(0, 2).join("/");
  const max = Math.max(1e-9, ...data.byDay.map((d) => d.cost));
  const topStage = Math.max(1e-9, ...data.byStage.map((s) => s.cost));
  const topModel = Math.max(1e-9, ...data.byModel.map((s) => s.cost));
  const topTicket = Math.max(1e-9, ...data.top.map((s) => s.cost));
  const perTicket = data.total.tickets ? data.total.cost / data.total.tickets : 0;
  return (
    <div className="page page-wide dev-page">
      <PageHead
        title="Custos da esteira"
        subtitle="Cada chamada de modelo da esteira, somada pelo custo real do OpenRouter. Os modelos de cada etapa se trocam em Agentes > Modelos (rotas Esteira)."
        actions={
          <div className="seg" role="group" aria-label="Período">
            {[7, 30, 90].map((d) => (
              <button key={d} className={days === d ? "active" : ""} aria-pressed={days === d} onClick={() => setDays(d)}>{d} dias</button>
            ))}
          </div>
        }
      />
      <div className="grid grid-4 dev-stats">
        <div className="card card-pad stat"><div className="label">Total no período</div><div className="value">{usd(data.total.cost)}</div><div className="sub">{data.total.tickets} {data.total.tickets === 1 ? "chamado" : "chamados"}</div></div>
        <div className="card card-pad stat"><div className="label">Por chamado</div><div className="value">{usd(perTicket)}</div><div className="sub">pronto custa em média {usd(data.done.avg_ready)}</div></div>
        <div className="card card-pad stat"><div className="label">Resultado</div><div className="value">{data.done.ready}<small className="muted"> / {data.done.ready + data.done.failed}</small></div><div className="sub">prontos · {data.done.failed} parados</div></div>
        <div className="card card-pad stat"><div className="label">Chamadas de modelo</div><div className="value">{int(data.total.calls)}</div><div className="sub">{int(data.total.tokens_in)} entrada · {int(data.total.tokens_out)} saída</div></div>
      </div>

      <div className="card card-pad costs-card">
        <div className="costs-label">Por dia</div>
        <div className="muted" style={{ fontSize: 13 }}>{hover ? `${fmtDay(hover.day)}: ${usd(hover.cost)}` : `últimos ${data.days} dias`}</div>
        {data.byDay.length ? (
          <>
            <div className="costs-bars" onMouseLeave={() => setHover(null)} aria-label="Custo por dia">
              {data.byDay.map((d) => (
                <span key={d.day} className={hover?.day === d.day ? "on" : ""} onMouseEnter={() => setHover(d)} onClick={() => setHover(d)} title={`${fmtDay(d.day)}: ${usd(d.cost)}`}>
                  <i style={{ height: `${Math.max(d.cost > 0 ? 3 : 0, (d.cost / max) * 100)}%` }} />
                </span>
              ))}
            </div>
            <div className="costs-axis muted"><span>{fmtDay(data.byDay[0]!.day)}</span><span>{fmtDay(data.byDay[data.byDay.length - 1]!.day)}</span></div>
          </>
        ) : (
          <Empty>Sem gasto no período.</Empty>
        )}
      </div>

      <div className="card card-pad dev-cost-agents">
        <div className="costs-label">Por agente</div>
        <div className="dev-agent-costs">
          {data.byAgent.map((a) => (
            <div key={a.agent} className="dev-agent-cost">
              <span className="dev-agent" style={{ width: 30, height: 30, background: AGENT_TONE[a.agent] ?? "#71717a", fontSize: 14 }} aria-hidden>{a.name.slice(0, 1)}</span>
              <div>
                <strong>{a.name}</strong> <span className="muted">{a.role}</span>
                <div className="mono">{usd(a.cost)} <span className="muted">· {a.calls} chamadas</span></div>
              </div>
            </div>
          ))}
          {!data.byAgent.length && <Empty>Nada ainda.</Empty>}
        </div>
      </div>

      <div className="dev-cost-grid">
        <div className="card card-pad">
          <div className="costs-label">Por etapa</div>
          {data.byStage.map((s) => (
            <div key={s.stage} className="costs-row" role="row">
              <span className="ellipsis costs-name">{s.label}</span>
              <span className="costs-track"><i style={{ width: `${(s.cost / topStage) * 100}%` }} /></span>
              <span className="costs-val">{usd(s.cost)}</span>
              <span className="costs-sub muted hide-phone">{s.calls} chamadas · média {ms(s.avg_ms)}</span>
            </div>
          ))}
          {!data.byStage.length && <Empty>Nada ainda.</Empty>}
        </div>
        <div className="card card-pad">
          <div className="costs-label">Por modelo</div>
          {data.byModel.map((m) => (
            <div key={m.model} className="costs-row" role="row">
              <span className="ellipsis costs-name mono" title={m.model}>{m.model}</span>
              <span className="costs-track"><i style={{ width: `${(m.cost / topModel) * 100}%` }} /></span>
              <span className="costs-val">{usd(m.cost)}</span>
              <span className="costs-sub muted hide-phone">{m.calls} chamadas · {int(m.tokens_in)} / {int(m.tokens_out)} tokens</span>
            </div>
          ))}
          {!data.byModel.length && <Empty>Nada ainda.</Empty>}
        </div>
      </div>

      <div className="card card-pad">
        <div className="costs-label">Chamados mais caros</div>
        {data.top.map((t) => (
          <Link key={t.id} to={`/esteira?t=${t.id}`} className="costs-row">
            <span className="ellipsis costs-name">#{t.id} {t.title}</span>
            <span className="costs-track"><i style={{ width: `${(t.cost / topTicket) * 100}%` }} /></span>
            <span className="costs-val">{usd(t.cost)}</span>
            <span className="costs-sub muted hide-phone">{t.pr_number ? `PR #${t.pr_number}` : t.stage}</span>
          </Link>
        ))}
        {!data.top.length && <Empty>Nada ainda.</Empty>}
      </div>
    </div>
  );
}
