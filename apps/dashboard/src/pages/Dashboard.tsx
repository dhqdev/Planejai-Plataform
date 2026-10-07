import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ago, brl, ms, usd, when } from "../api";
import type { Me } from "../App";
import { AgentTag, CATEGORY_COLORS, Donut, Empty, Modal, PageHead, Status } from "../components";
import { FIT_QUERY, useApi, useMedia } from "../hooks";
import { Icon } from "../icons";
import { TeamMap } from "../TeamMap";
import { haptic } from "../touch";
import { InviteForm } from "./Invites";

type Size = "s" | "m" | "l" | "xl";
interface Widget {
  id: string;
  type: string;
  size: Size;
}
interface Ctx {
  sys: any;
  mine: any;
  isSuper: boolean;
}
interface WidgetDef {
  title: string;
  desc: string;
  icon: string;
  sizes: Size[];
  only?: "super" | "admin";
  render: (c: Ctx) => ReactNode;
}

const SIZE_LABEL: Record<Size, string> = { s: "Pequeno", m: "Médio", l: "Grande", xl: "Largura toda" };

/** Cada número do painel ganha uma cor da paleta (sempre a mesma para o mesmo indicador). */
const TONES = ["#FF7A1A", "#FF4458", "#E23382", "#B830C8", "#8B2BE2", "#5B45E8", "#2F7BEA", "#16A3A3"];
const tone = (key: string) => TONES[[...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length]!;

function Num({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon: string }) {
  return (
    <div className="card card-pad stat" style={{ height: "100%", ["--c" as any]: tone(label) }}>
      <div className="label">
        <span className="tone-ico"><Icon name={icon} size={14} /></span> {label}
      </div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function Box({ title, icon, to, children }: { title: string; icon: string; to?: string; children: ReactNode }) {
  return (
    <div className="card card-pad" style={{ height: "100%" }}>
      <div className="widget-head" style={{ ["--c" as any]: tone(title) }}>
        <span className="tone-ico"><Icon name={icon} size={15} /></span>
        <h3>{title}</h3>
        <span className="spacer" />
        {to && (
          <Link to={to} className="icon-btn" aria-label="Abrir">
            <Icon name="chevron-right" size={16} />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

function RecentExecutions() {
  const { data } = useApi<any[]>("/api/executions?limit=6", { poll: 15000 });
  const nav = useNavigate();
  if (!data) return null;
  if (!data.length) return <Empty>Nenhuma execução ainda.</Empty>;
  return (
    <>
      {data.map((e) => (
        <div key={e.id} className="line-item clickable" onClick={() => nav(`/executions/${e.id}`)}>
          <Status status={e.status} />
          <span className="ellipsis" style={{ flex: 1 }}>{e.input}</span>
          <span className="muted" style={{ fontSize: 12 }}>{ago(e.started_at)}</span>
        </div>
      ))}
    </>
  );
}

function WatchesList() {
  const { data } = useApi<any[]>("/api/watches");
  const active = (data ?? []).filter((w) => w.active);
  if (!data) return null;
  if (!active.length) return <Empty>Diga no WhatsApp "fica de olho no preço do iPhone 16" e ele avisa quando baixar.</Empty>;
  return (
    <>
      {active.slice(0, 5).map((w) => (
        <div key={w.id} className="line-item">
          <Icon name={w.kind === "price" ? "target" : "globe"} size={15} />
          <span className="ellipsis" style={{ flex: 1 }}>{w.query}</span>
          <span className="muted" style={{ fontSize: 12 }}>a cada {w.every_hours}h</span>
        </div>
      ))}
    </>
  );
}

function InvitesBox() {
  const { data } = useApi<any>("/api/invites");
  const s = data?.stats ?? {};
  return (
    <div className="row row-wrap" style={{ gap: 18 }}>
      <div><div className="muted" style={{ fontSize: 12 }}>Convidados</div><strong style={{ fontSize: 22 }}>{s.total ?? 0}</strong></div>
      <div><div className="muted" style={{ fontSize: 12 }}>Entraram</div><strong style={{ fontSize: 22 }}>{s.accepted ?? 0}</strong></div>
      <div><div className="muted" style={{ fontSize: 12 }}>Aguardando</div><strong style={{ fontSize: 22 }}>{s.pending ?? 0}</strong></div>
    </div>
  );
}

const WIDGETS: Record<string, WidgetDef> = {
  team: {
    title: "Mapa do time",
    desc: "Os agentes e quem conversa com quem",
    icon: "graph",
    sizes: ["l", "xl"],
    render: ({ isSuper }) => (
      <Box title="Mapa do time" icon="graph" to={isSuper ? "/agents" : undefined}>
        <TeamMap />
      </Box>
    ),
  },
  executions: {
    title: "Execuções 24h",
    desc: "Quantas vezes o agente trabalhou",
    icon: "activity",
    sizes: ["s", "m"],
    only: "super",
    render: ({ sys }) => <Num icon="activity" label="Execuções (24h)" value={sys?.stats.executions_24h ?? "–"} sub={`${sys?.stats.errors_24h ?? 0} com erro`} />,
  },
  speed: {
    title: "Tempo de resposta",
    desc: "Média das últimas 24h",
    icon: "refresh",
    sizes: ["s", "m"],
    only: "super",
    render: ({ sys }) => <Num icon="refresh" label="Tempo médio" value={ms(Math.round(Number(sys?.stats.avg_ms_24h ?? 0)))} sub="últimas 24h" />,
  },
  cost: {
    title: "Custo",
    desc: "Gasto com modelos (OpenRouter)",
    icon: "card",
    sizes: ["s", "m"],
    only: "super",
    render: ({ sys }) => <Num icon="card" label="Custo (24h)" value={usd(sys?.stats.cost_24h)} sub={`${usd(sys?.stats.cost_month)} no mês`} />,
  },
  messages: {
    title: "Mensagens hoje",
    desc: "Mensagens recebidas hoje",
    icon: "send",
    sizes: ["s", "m"],
    render: ({ sys, mine }) => (
      <Num icon="send" label="Mensagens hoje" value={sys?.counts.messages_24h ?? mine?.counts.messages_24h ?? 0} sub={sys ? `${sys.counts.people} pessoas ativas` : undefined} />
    ),
  },
  people: {
    title: "Clientes",
    desc: "Pessoas ativas e convites aceitos",
    icon: "users",
    sizes: ["s", "m"],
    only: "super",
    render: ({ sys }) => <Num icon="users" label="Clientes ativos" value={sys?.counts.people ?? 0} sub={`${sys?.counts.invites_accepted ?? 0} entraram por convite`} />,
  },
  clientAgents: {
    title: "Agentes dos clientes",
    desc: "Criados pela melhoria diária das 19h",
    icon: "sparkle",
    sizes: ["s", "m"],
    only: "super",
    render: ({ sys }) => <Num icon="sparkle" label="Agentes dos clientes" value={sys?.counts.client_agents ?? 0} sub="melhoria diária às 19h" />,
  },
  expenses: {
    title: "Gastos do mês",
    desc: "Total gasto no mês e comparação",
    icon: "wallet",
    sizes: ["s", "m"],
    render: ({ mine }) => {
      const exp = Number(mine?.money.expenses_month ?? 0);
      const prev = Number(mine?.money.expenses_prev ?? 0);
      return <Num icon="wallet" label="Gastos no mês" value={brl(exp)} sub={prev ? `${exp > prev ? "+" : "-"}${brl(Math.abs(exp - prev))} vs mês passado` : "este mês"} />;
    },
  },
  income: {
    title: "Receitas do mês",
    desc: "Entradas registradas no mês",
    icon: "arrow",
    sizes: ["s", "m"],
    render: ({ mine }) => <Num icon="arrow" label="Receitas no mês" value={brl(mine?.money.income_month)} />,
  },
  watchCount: {
    title: "Acompanhando",
    desc: "Quantas coisas o agente vigia para você",
    icon: "eye",
    sizes: ["s", "m"],
    only: "admin",
    render: ({ mine }) => <Num icon="eye" label="Acompanhando" value={mine?.counts.watches ?? 0} sub="preços e notícias" />,
  },
  reminders: {
    title: "Próximos lembretes",
    desc: "O que vem por aí",
    icon: "bell",
    sizes: ["m", "l"],
    render: ({ mine }) => (
      <Box title="Próximos lembretes" icon="bell" to="/agenda">
        {(mine?.nextReminders ?? []).map((r: any) => (
          <div key={r.id} className="line-item">
            <span className="ellipsis" style={{ flex: 1 }}>{r.intent}</span>
            <span className="muted" style={{ fontSize: 12 }}>{r.cron ? "recorrente" : when(r.due_at)}</span>
          </div>
        ))}
        {mine && !mine.nextReminders.length && <Empty>Diga "me lembra de pagar a luz dia 10".</Empty>}
      </Box>
    ),
  },
  categories: {
    title: "Gastos por categoria",
    desc: "Rosca com as categorias do mês",
    icon: "circle",
    sizes: ["m", "l"],
    render: ({ mine }) => {
      const cats = (mine?.byCategory ?? []).map((c: any) => ({ label: c.category, value: Number(c.total) }));
      return (
        <Box title="Gastos por categoria" icon="circle" to="/finance">
          {cats.length ? (
            <div className="donut-wrap">
              <Donut items={cats} size={130} center={<strong>{brl(cats.reduce((a: number, c: any) => a + c.value, 0))}</strong>} />
              <div className="legend">
                {cats.slice(0, 6).map((c: any, i: number) => (
                  <div className="item" key={c.label}>
                    <span className="sw" style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                    {c.label}
                    <strong>{brl(c.value)}</strong>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Empty>Mande "gastei 25 no almoço" no WhatsApp.</Empty>
          )}
        </Box>
      );
    },
  },
  recentTx: {
    title: "Últimos lançamentos",
    desc: "Gastos e receitas mais recentes",
    icon: "list",
    sizes: ["m", "l"],
    render: ({ mine }) => (
      <Box title="Últimos lançamentos" icon="list" to="/finance">
        {(mine?.recent ?? []).map((t: any) => (
          <div key={t.id} className="line-item">
            <span className="chip">{t.category}</span>
            <span className="ellipsis" style={{ flex: 1 }}>{t.description ?? t.merchant ?? ""}</span>
            <span className={t.kind === "income" ? "amount-in" : "amount-out"}>{brl(t.amount)}</span>
          </div>
        ))}
        {mine && !mine.recent.length && <Empty>Nada lançado ainda.</Empty>}
      </Box>
    ),
  },
  daily: {
    title: "Execuções por dia",
    desc: "Últimos 14 dias",
    icon: "activity",
    sizes: ["m", "l", "xl"],
    only: "super",
    render: ({ sys }) => {
      const daily = sys?.daily ?? [];
      const max = Math.max(1, ...daily.map((d: any) => Number(d.executions)));
      return (
        <Box title="Execuções por dia" icon="activity" to="/executions">
          <div className="bars">
            {daily.map((d: any) => (
              <div key={d.day} className="bar" title={`${d.day}: ${d.executions} execuções, ${usd(d.cost)}`} style={{ height: `${(Number(d.executions) / max) * 100}%` }} />
            ))}
          </div>
          <div className="bars-labels">
            {daily.map((d: any) => (
              <span key={d.day}>{d.day.slice(8)}</span>
            ))}
          </div>
        </Box>
      );
    },
  },
  byAgent: {
    title: "Uso por agente",
    desc: "Chamadas e custo em 7 dias",
    icon: "cpu",
    sizes: ["m", "l"],
    only: "super",
    render: ({ sys }) => (
      <Box title="Uso por agente (7 dias)" icon="cpu" to="/agents">
        {(sys?.byAgent ?? []).map((a: any) => (
          <div key={a.agent} className="line-item">
            <span style={{ flex: 1 }}><AgentTag id={a.agent} /></span>
            <span className="muted" style={{ fontSize: 12 }}>{a.llm_calls} chamadas</span>
            <strong style={{ width: 80, textAlign: "right" }}>{usd(a.cost)}</strong>
          </div>
        ))}
        {sys && !sys.byAgent.length && <Empty>Sem dados ainda.</Empty>}
      </Box>
    ),
  },
  recentExec: {
    title: "Últimas execuções",
    desc: "O que o agente fez agora há pouco",
    icon: "list",
    sizes: ["m", "l", "xl"],
    only: "super",
    render: () => (
      <Box title="Últimas execuções" icon="list" to="/executions">
        <RecentExecutions />
      </Box>
    ),
  },
  memory: {
    title: "Memória e cache",
    desc: "Redis: conversas curtas e resultados reaproveitados",
    icon: "database",
    sizes: ["s", "m", "l"],
    only: "super",
    render: ({ sys }) => {
      const c = sys?.cache;
      const total = c ? c.hits + c.writes : 0;
      return (
        <Box title="Memória e cache" icon="database">
          <dl className="kv">
            <dt>Redis</dt>
            <dd>{sys?.redis?.ok ? `ligado, ${sys.redis.memory}` : sys?.redis?.enabled ? "fora do ar" : "não configurado"}</dd>
            <dt>Itens guardados</dt>
            <dd>{c?.keys ?? 0}</dd>
            <dt>Reaproveitados</dt>
            <dd>{c ? `${c.hits} (${total ? Math.round((c.hits / total) * 100) : 0}%)` : "–"}</dd>
          </dl>
        </Box>
      );
    },
  },
  invites: {
    title: "Convites",
    desc: "Quantas pessoas você convidou",
    icon: "user-plus",
    sizes: ["s", "m", "l"],
    render: () => (
      <Box title="Convites" icon="user-plus" to="/invites">
        <InvitesBox />
      </Box>
    ),
  },
  watches: {
    title: "Acompanhamentos",
    desc: "Preços e notícias que o agente vigia",
    icon: "eye",
    sizes: ["m", "l"],
    render: () => (
      <Box title="Acompanhamentos" icon="eye" to="/watches">
        <WatchesList />
      </Box>
    ),
  },
};

let seq = 0;
const w = (type: string, size: Size): Widget => ({ id: `${type}-${Date.now().toString(36)}-${seq++}`, type, size });

const DEFAULT_SUPER = (): Widget[] => [
  w("executions", "s"),
  w("cost", "s"),
  w("messages", "s"),
  w("people", "s"),
  w("team", "xl"),
  w("recentExec", "l"),
  w("byAgent", "l"),
  w("daily", "l"),
  w("memory", "m"),
  w("invites", "m"),
];
const DEFAULT_ADMIN = (): Widget[] => [
  w("expenses", "s"),
  w("income", "s"),
  w("messages", "s"),
  w("watchCount", "s"),
  w("team", "xl"),
  w("categories", "l"),
  w("reminders", "l"),
  w("recentTx", "l"),
  w("watches", "l"),
];

function allowed(def: WidgetDef, isSuper: boolean) {
  return !def.only || def.only === (isSuper ? "super" : "admin");
}

export function DashboardPage({ me, theme, onTheme }: { me: Me; theme: string; onTheme: () => void }) {
  const isSuper = me.role === "superadmin";
  const sys = useApi<any>(isSuper ? "/api/overview" : null, { poll: 20000 });
  const mine = useApi<any>("/api/me/overview", { poll: 30000 });
  const saved = useApi<{ widgets: Widget[] } | null>("/api/me/dashboard");
  const [widgets, setWidgets] = useState<Widget[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [modal, setModal] = useState<"add" | "invite" | "quick" | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    if (saved.loading || widgets) return;
    const list = (saved.data?.widgets ?? []).filter((x) => WIDGETS[x.type] && allowed(WIDGETS[x.type]!, isSuper));
    setWidgets(list.length ? list : isSuper ? DEFAULT_SUPER() : DEFAULT_ADMIN());
  }, [saved.loading, saved.data, widgets, isSuper]);

  const persist = (list: Widget[]) => {
    setWidgets(list);
    api("/api/me/dashboard", { method: "PUT", json: { widgets: list } }).catch(() => {});
  };

  // arrastar pela alça: troca de lugar com o widget que está embaixo do dedo/mouse
  const onGripDown = (id: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragging.current = id;
    setDragId(id);
    haptic(10);
  };
  const onGripMove = (e: React.PointerEvent) => {
    const id = dragging.current;
    if (!id || !widgets) return;
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((n) => (n as HTMLElement).dataset?.wid && (n as HTMLElement).dataset.wid !== id) as HTMLElement | undefined;
    if (!el) return;
    const from = widgets.findIndex((x) => x.id === id);
    const to = widgets.findIndex((x) => x.id === el.dataset.wid);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...widgets];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setWidgets(next);
    haptic(4);
  };
  const onGripUp = () => {
    if (!dragging.current) return;
    dragging.current = null;
    setDragId(null);
    if (widgets) persist(widgets);
  };

  const resize = (id: string) => {
    if (!widgets) return;
    persist(
      widgets.map((x) => {
        if (x.id !== id) return x;
        const sizes = WIDGETS[x.type]!.sizes;
        return { ...x, size: sizes[(sizes.indexOf(x.size) + 1) % sizes.length]! };
      }),
    );
  };
  const remove = (id: string) => widgets && persist(widgets.filter((x) => x.id !== id));
  const add = (type: string) => {
    const def = WIDGETS[type]!;
    persist([...(widgets ?? []), w(type, def.sizes[Math.min(1, def.sizes.length - 1)]!)]);
    setModal(null);
  };

  const ctx: Ctx = { sys: sys.data, mine: mine.data, isSuper };
  // no notebook a tela cabe inteira: números em cima, mapa do time à esquerda e o resto numa coluna que rola por dentro
  const fit = useMedia(FIT_QUERY) && !editing && !!widgets?.length;
  const renderWidget = (x: Widget) => {
    const def = WIDGETS[x.type]!;
    return (
      <div key={x.id} data-wid={x.id} className={`widget ${x.size} w-${x.type} ${dragId === x.id ? "dragging" : ""}`}>
        {editing && (
          <div className="widget-tools">
            <button className="grip" aria-label="Mover" onPointerDown={onGripDown(x.id)}>
              <Icon name="grip" size={15} />
            </button>
            {def.sizes.length > 1 && (
              <button aria-label={`Tamanho: ${SIZE_LABEL[x.size]}`} title={SIZE_LABEL[x.size]} onClick={() => resize(x.id)}>
                <Icon name="resize" size={14} />
              </button>
            )}
            <button className="remove" aria-label="Remover" onClick={() => remove(x.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        {def.render(ctx)}
      </div>
    );
  };
  const stats = fit ? widgets!.filter((x) => x.size === "s") : [];
  const lead = fit ? widgets!.find((x) => x.type === "team") : undefined;
  const rest = fit ? widgets!.filter((x) => x.size !== "s" && x !== lead) : [];
  const first = (me.name ?? "").split(" ")[0];

  return (
    <div className={`page page-wide ${fit ? "fit dash-fit" : ""}`}>
      <PageHead
        title={isSuper ? "Painel" : first ? `Olá, ${first}` : "Início"}
        subtitle={editing ? "Arraste pela alça para mudar de lugar. Toque no tamanho para alternar." : isSuper ? "Como o Planejai está trabalhando agora" : "Seu Planejai em um lugar"}
        actions={
          editing ? (
            <>
              <button className="btn" onClick={() => setModal("add")}>
                <Icon name="plus" size={16} /> Adicionar
              </button>
              <button className="btn btn-primary" onClick={() => setEditing(false)}>
                <Icon name="check" size={16} /> Pronto
              </button>
            </>
          ) : (
            <div className="dash-actions">
              <button className={`btn ${fit ? "" : "phone-only"}`} onClick={() => setModal("quick")}>
                <Icon name="settings" size={16} /> Ajustes
              </button>
              <button className="btn" onClick={() => setEditing(true)}>
                <Icon name="layout" size={16} /> Editar<span className="hide-phone"> painel</span>
              </button>
              <button className={`btn btn-brand ${fit ? "" : "phone-only"}`} onClick={() => setModal("invite")}>
                <Icon name="user-plus" size={16} /> Convidar
              </button>
            </div>
          )
        }
      />

      {fit ? (
        <div className="board-fit">
          {!!stats.length && <div className="board fit-stats">{stats.map(renderWidget)}</div>}
          <div className={`fit-body ${lead ? "" : "no-lead"}`}>
            {lead && <div className="fit-main">{renderWidget(lead)}</div>}
            {!!rest.length && <div className="fit-side">{rest.map(renderWidget)}</div>}
          </div>
        </div>
      ) : widgets && (
        <div ref={board} className={`board ${editing ? "editing" : ""}`} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>
          {widgets.map(renderWidget)}
          {!widgets.length && (
            <div className="widget xl">
              <Empty>
                Painel vazio.{" "}
                <button className="btn btn-sm" onClick={() => { setEditing(true); setModal("add"); }}>
                  Adicionar widget
                </button>
              </Empty>
            </div>
          )}
        </div>
      )}

      <div className="corner br">
        <button className="fab" aria-label="Configurações rápidas" title="Configurações rápidas" onClick={() => setModal("quick")}>
          <Icon name="settings" />
        </button>
        <button className="fab" aria-label="Editar painel" title="Editar painel" onClick={() => setEditing((v) => !v)}>
          <Icon name={editing ? "check" : "layout"} />
        </button>
        <button className="fab ink" aria-label="Convidar alguém" title="Convidar alguém" onClick={() => setModal("invite")}>
          <Icon name="user-plus" />
        </button>
      </div>

      {modal === "add" && (
        <Modal title="Adicionar ao painel" icon={<Icon name="plus" />} wide onClose={() => setModal(null)}>
          <div className="catalog">
            {Object.entries(WIDGETS)
              .filter(([, d]) => allowed(d, isSuper))
              .map(([type, d]) => (
                <button key={type} onClick={() => add(type)}>
                  <Icon name={d.icon} />
                  <span>
                    <strong>{d.title}</strong>
                    <small>{d.desc}</small>
                  </span>
                </button>
              ))}
          </div>
          <button className="btn btn-sm" style={{ marginTop: 14 }} onClick={() => { persist(isSuper ? DEFAULT_SUPER() : DEFAULT_ADMIN()); setModal(null); }}>
            <Icon name="refresh" size={14} /> Voltar ao painel padrão
          </button>
        </Modal>
      )}
      {modal === "invite" && (
        <Modal title="Convidar alguém" icon={<Icon name="user-plus" />} onClose={() => setModal(null)}>
          <InviteForm />
        </Modal>
      )}
      {modal === "quick" && (
        <Modal title="Configurações rápidas" icon={<Icon name="settings" />} onClose={() => setModal(null)}>
          <div className="line-item">
            <Icon name={theme === "dark" ? "moon" : "sun"} />
            <span style={{ flex: 1 }}>Tema</span>
            <div className="seg">
              <button className={theme !== "dark" ? "active" : ""} onClick={() => theme === "dark" && onTheme()}>Claro</button>
              <button className={theme === "dark" ? "active" : ""} onClick={() => theme !== "dark" && onTheme()}>Escuro</button>
            </div>
          </div>
          <div className="more-grid" style={{ marginTop: 14 }}>
          {(isSuper
            ? [
                ["/whatsapp", "phone", "WhatsApp", sys.data?.channel?.configured ? "conectado" : "desconectado"],
                ["/integrations", "plug", "Integrações", ""],
                ["/models", "cpu", "Modelos", ""],
                ["/agents", "brain", "Agentes", ""],
                ["/settings", "settings", "Configurações", ""],
              ]
            : [
                ["/profile", "user", "Minha conta", ""],
                ["/invites", "user-plus", "Convites", ""],
                ["/watches", "eye", "De olho", ""],
              ]
          ).map(([to, icon, label, sub]) => (
            <Link key={to} to={to!} className="more-tile" onClick={() => setModal(null)}>
              <Icon name={icon!} size={26} />
              <span>{label}</span>
              {sub && <small className="muted">{sub}</small>}
            </Link>
          ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Aba sob medida criada pela reunião noturna: só os widgets que fazem sentido para a pessoa. */
export function CustomTabPage({ me, tab }: { me: Me; tab: { title: string; widgets: string[] } }) {
  const isSuper = me.role === "superadmin";
  const mine = useApi<any>("/api/me/overview", { poll: 30000 });
  const ctx: Ctx = { sys: null, mine: mine.data, isSuper };
  const list = tab.widgets.filter((t) => WIDGETS[t] && allowed(WIDGETS[t]!, isSuper));
  return (
    <div className="page page-wide">
      <PageHead title={tab.title} subtitle="Aba criada pelo seu time para o que você mais usa." />
      <div className="board">
        {list.map((t) => {
          const def = WIDGETS[t]!;
          const size = def.sizes.includes("l") ? "l" : def.sizes[def.sizes.length - 1]!;
          return (
            <div key={t} className={`widget ${size}`}>
              {def.render(ctx)}
            </div>
          );
        })}
        {!list.length && <div className="widget xl"><Empty>Nada por aqui ainda.</Empty></div>}
      </div>
    </div>
  );
}
