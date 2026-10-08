import { useMemo, useState } from "react";
import { ago, api, phoneFmt } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import "../resources.css";
import { haptic } from "../touch";

// ================= Tipos (iguais ao servidor: apps/server/src/resources.ts) =================

interface Proc {
  id: string;
  role: string;
  host: string;
  pid: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  cpu: number;
  uptime: number;
  node: string;
  version: string;
  container: { used: number | null; limit: number | null };
  ts: number;
  history: [number, number, number][];
}
interface RedisStats {
  ok: boolean;
  version?: string;
  used?: number;
  rss?: number;
  peak?: number;
  max?: number | null;
  policy?: string | null;
  fragmentation?: number | null;
  clients?: number;
  uptime?: number;
  keys?: number;
  hitRate?: number | null;
  groups?: { label: string; keys: number; bytes: number }[];
  sampled?: boolean;
}
interface Overview {
  generatedAt: string;
  processes: Proc[];
  machine: { host: string; platform: string; cpus: number; load: number[]; memTotal: number; memFree: number; uptime: number };
  disk: { total: number; used: number; free: number } | null;
  postgres: {
    size: number;
    version: string;
    max_connections: number;
    shared_buffers: string;
    connections: number;
    active: number;
    uptime: number;
    cache_hit: number | null;
    tables: { name: string; label: string; total: number; data: number; indexes: number; rows: number }[];
  };
  redis: RedisStats | null;
  redisCache: RedisStats | null;
  browser: { ok: boolean; cpu?: number | null; memory?: number | null; running?: number; queued?: number; maxConcurrent?: number | null } | null;
  history: { day: string; db_bytes: number; files_bytes: number; redis_bytes: number; disk_used: number | null; disk_total: number | null }[];
  retentionHours: number;
}
type Cat = "files" | "talk" | "runs" | "finance" | "agenda" | "memory" | "other";
interface Client {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  status: string;
  created_at: string;
  last_seen_at: string | null;
  bytes: number;
  rows: number;
  recent: number;
  files: number;
  fileBytes: number;
  redisBytes: number;
  categories: Record<Cat, number>;
  tables: { table: string; label: string; category: Cat; rows: number; bytes: number }[];
}
interface Storage {
  generatedAt: string;
  dbBytes: number;
  attributed: number;
  platform: number;
  unowned: number;
  redisBytes: number;
  redisSampled: boolean;
  categories: { id: Cat; label: string; bytes: number }[];
  clients: Client[];
}

// ================= Formatação =================

const nf = (v: number, d = 0) => v.toLocaleString("pt-BR", { maximumFractionDigits: d, minimumFractionDigits: d });
/** 1.536 -> "1,5 KB"; usa base 1024 como o Postgres e o Redis. */
export function bytes(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${nf(v, i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}
const pct = (part: number, total: number) => (total > 0 ? Math.min(100, (part / total) * 100) : 0);
/** Porcentagem para ler: "<1%" em vez de um 0% enganoso. */
const pctLabel = (part: number, total: number) => {
  const p = pct(part, total);
  return p > 0 && p < 1 ? "<1%" : `${nf(p)}%`;
};
function dur(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`;
  const d = Math.floor(s / 86400);
  return `${d} ${d === 1 ? "dia" : "dias"} ${Math.floor((s % 86400) / 3600)}h`;
}
const ROLE_LABEL: Record<string, string> = { api: "API e painel", worker: "Worker", app: "App (API e worker)" };
const ROLE_HINT: Record<string, string> = {
  api: "Responde o painel, os webhooks e a API do n8n",
  worker: "Roda o time de agentes, as filas e o WhatsApp",
  app: "Tudo num processo só (ROLE=all)",
};

/** Cores dos tipos de dado: o roxo do Mochi para arquivos (o que mais pesa) e tons neutros e frios no resto. */
const CAT_COLOR: Record<Cat, string> = {
  files: "var(--violet)",
  talk: "#2f7bea",
  runs: "var(--ink)",
  finance: "#16a3a3",
  agenda: "#c42bea",
  memory: "#9aa0a6",
  other: "#d4d4d8",
};
const CAT_LABEL: Record<Cat, string> = {
  files: "Arquivos",
  talk: "Conversas",
  runs: "Execuções",
  finance: "Finanças",
  agenda: "Agenda",
  memory: "Memórias",
  other: "Cadastro",
};
const CAT_ICON: Record<Cat, string> = { files: "file", talk: "send", runs: "activity", finance: "wallet", agenda: "calendar", memory: "brain", other: "user" };

// ================= Peças =================

/** Barra de uso com aviso: tinta até 70%, âmbar até 90%, vermelho acima. `share` = só proporção, sem aviso. */
function Meter({ value, total, label, share }: { value: number; total: number | null | undefined; label?: string; share?: boolean }) {
  const p = total ? pct(value, total) : 0;
  return (
    <span className={`srv-meter ${share ? "" : p >= 90 ? "crit" : p >= 70 ? "warn" : ""}`} role="meter" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <i style={{ width: `${total ? Math.max(2, p) : 0}%` }} />
    </span>
  );
}

/** Linha da última hora (memória do processo), com área suave e o ponto de agora. */
function Spark({ points, height = 40 }: { points: number[]; height?: number }) {
  if (points.length < 2) return <div className="srv-spark-empty muted">o gráfico aparece depois de alguns minutos</div>;
  const w = 240;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || max || 1;
  const xy = points.map((v, i) => [(i / (points.length - 1)) * w, height - 4 - ((v - min) / span) * (height - 10)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1]!;
  return (
    <svg className="srv-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={`${line} L${w},${height} L0,${height} Z`} className="area" />
      <path d={line} className="line" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={3} className="dot" />
    </svg>
  );
}

/** Rosca por tipo de dado, com as mesmas cores das barras dos clientes. */
function Ring({ items, size = 132, center }: { items: { id: Cat; bytes: number }[]; size?: number; center?: React.ReactNode }) {
  const total = items.reduce((a, i) => a + i.bytes, 0);
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="srv-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={14} />
        {total > 0 &&
          items
            .filter((i) => i.bytes > 0)
            .map((it) => {
              const len = (it.bytes / total) * c;
              const el = (
                <circle key={it.id} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={CAT_COLOR[it.id]} strokeWidth={14}
                  strokeDasharray={`${Math.max(0, len - 1.5)} ${c - Math.max(0, len - 1.5)}`} strokeDashoffset={-offset} />
              );
              offset += len;
              return el;
            })}
      </svg>
      {center && <div className="srv-ring-center">{center}</div>}
    </div>
  );
}

function Stack({ cats, total }: { cats: Record<Cat, number>; total: number }) {
  return (
    <span className="srv-stack">
      {(Object.keys(CAT_COLOR) as Cat[]).map((k) =>
        cats[k] > 0 ? <i key={k} style={{ width: `${pct(cats[k], total)}%`, background: CAT_COLOR[k] }} title={`${CAT_LABEL[k]}: ${bytes(cats[k])}`} /> : null,
      )}
    </span>
  );
}

function Kpi({ label, value, sub, meter }: { label: string; value: string; sub?: React.ReactNode; meter?: React.ReactNode }) {
  return (
    <div className="srv-kpi">
      <small>{label}</small>
      <strong className="mono-num">{value}</strong>
      {meter}
      {sub && <span>{sub}</span>}
    </div>
  );
}

// ================= Servidor =================

/** Memória, CPU, banco, Redis, navegador e disco da stack. Atualiza sozinha a cada 10 s. */
export function ServerPage() {
  const { data, error } = useApi<Overview>("/api/resources", { poll: 10_000 });
  if (error && !data) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const procs = data.processes;
  const ram = procs.reduce((a, p) => a + p.rss, 0);
  const limits = procs.map((p) => p.container.limit);
  const ramLimit = limits.every((l) => l) ? limits.reduce<number>((a, l) => a + (l ?? 0), 0) : null;
  const cpu = procs.reduce((a, p) => a + p.cpu, 0);
  const m = data.machine;
  const pg = data.postgres;
  const rd = data.redis;
  const redisFull = rd?.ok && rd.max ? pct(rd.used ?? 0, rd.max) : 0;
  const maxTable = Math.max(1, ...pg.tables.map((t) => t.total));
  const maxGroup = Math.max(1, ...(rd?.groups ?? []).map((g) => g.bytes));
  const workers = procs.filter((p) => p.role === "worker").length;

  return (
    <div className="page page-wide fit srv-page">
      <div className="hide-phone">
        <PageHead title="Servidor" subtitle={`Memória, processador e espaço da stack. Atualiza sozinho a cada 10 segundos, última leitura ${ago(data.generatedAt)}.`} />
      </div>

      <div className="card srv-kpis">
        <Kpi
          label="Memória do app"
          value={bytes(ram)}
          meter={<Meter value={ram} total={ramLimit ?? m.memTotal} label="Memória do app" />}
          sub={ramLimit ? `de ${bytes(ramLimit)} de limite` : `de ${bytes(m.memTotal)} da máquina`}
        />
        <Kpi label="Processador" value={`${nf(cpu, 1)}%`} meter={<Meter value={cpu} total={m.cpus * 100} label="Processador" />} sub={`de ${m.cpus} ${m.cpus === 1 ? "núcleo" : "núcleos"}, carga ${nf(m.load[0] ?? 0, 2)}`} />
        <Kpi label="Banco de dados" value={bytes(pg.size)} meter={<Meter value={pg.connections} total={pg.max_connections} label="Conexões" />} sub={`${pg.connections} de ${pg.max_connections} conexões`} />
        <Kpi
          label="Redis"
          value={rd?.ok ? bytes(rd.used) : "fora do ar"}
          meter={<Meter value={rd?.used ?? 0} total={rd?.max ?? null} label="Redis" />}
          sub={rd?.ok ? (rd.max ? `${nf(redisFull)}% de ${bytes(rd.max)}` : `${nf(rd.keys ?? 0)} chaves, sem limite`) : "sem memória curta agora"}
        />
        <Kpi
          label="Disco"
          value={data.disk ? bytes(data.disk.used) : "–"}
          meter={<Meter value={data.disk?.used ?? 0} total={data.disk?.total} label="Disco" />}
          sub={data.disk ? `livre ${bytes(data.disk.free)} de ${bytes(data.disk.total)}` : "sem leitura"}
        />
      </div>

      <div className="srv-body">
        <div className="srv-col">
          <div className="card srv-card srv-procs">
            <div className="srv-head">
              <h3>Processos</h3>
              <span className="chip-mini">{procs.length === 1 ? "1 no ar" : `${procs.length} no ar`}</span>
              <span className="spacer" />
              {procs.length > 0 && !workers && procs[0]?.role === "api" && <small className="muted">o worker aparece aqui quando estiver no ar</small>}
            </div>
            <div className="srv-scroll">
              {procs.map((p) => (
                <div key={p.id} className="srv-proc">
                  <div className="srv-proc-top">
                    <span className={`srv-live ${Date.now() - p.ts > 40_000 ? "late" : ""}`} />
                    <div className="srv-proc-name">
                      <strong>{ROLE_LABEL[p.role] ?? p.role}</strong>
                      <small className="muted">{ROLE_HINT[p.role] ?? p.host}</small>
                    </div>
                    <span className="spacer" />
                    <div className="srv-proc-nums">
                      <strong className="mono-num">{bytes(p.rss)}</strong>
                      <small className="muted">{nf(p.cpu, 1)}% CPU</small>
                    </div>
                  </div>
                  <Spark points={p.history.map((h) => h[1])} />
                  <div className="srv-proc-meta muted mono-num" title={`heap ${bytes(p.heapUsed)} de ${bytes(p.heapTotal)}; ${p.container.limit ? `limite do contêiner ${bytes(p.container.limit)}` : "contêiner sem limite de memória"}; versão ${p.version}`}>
                    <span>heap {bytes(p.heapUsed)}</span>
                    {p.container.used != null && <span>contêiner {bytes(p.container.used)}</span>}
                    <span>no ar há {dur(p.uptime)}</span>
                    <span>v{p.version.split(" ")[0]}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card srv-card srv-machine">
            <div className="srv-head"><h3>Máquina</h3><span className="spacer" /><small className="muted mono-num">{m.platform}</small></div>
            <div className="srv-bar-row">
              <span>Memória da máquina</span>
              <strong className="mono-num">{bytes(m.memTotal - m.memFree)} <span className="muted">de {bytes(m.memTotal)}</span></strong>
              <Meter value={m.memTotal - m.memFree} total={m.memTotal} label="Memória da máquina" />
            </div>
            <div className="srv-proc-meta muted mono-num">
              <span>{m.cpus} {m.cpus === 1 ? "núcleo" : "núcleos"}</span>
              <span title="carga média em 1, 5 e 15 minutos">carga {m.load.map((l) => nf(l, 2)).join(" ")}</span>
              <span>ligada há {dur(m.uptime)}</span>
            </div>
          </div>
        </div>

        <div className="srv-col">
        <div className="card srv-card srv-db">
          <div className="srv-head"><h3>Banco de dados</h3><span className="chip-mini">Postgres {pg.version.split(" ")[0]}</span></div>
          <dl className="srv-mini">
            <div><dt>Tamanho</dt><dd className="mono-num">{bytes(pg.size)}</dd></div>
            <div><dt>Cache em memória</dt><dd className="mono-num">{pg.cache_hit != null ? `${nf(pg.cache_hit, 1)}%` : "–"}</dd></div>
            <div><dt>Consultas agora</dt><dd className="mono-num">{pg.active}</dd></div>
            <div><dt>No ar há</dt><dd className="mono-num">{dur(pg.uptime)}</dd></div>
          </dl>
          <h4 className="srv-sub">Maiores tabelas</h4>
          <div className="srv-scroll">
            {pg.tables.map((t) => (
              <div key={t.name} className="srv-rank" title={`dados ${bytes(t.data)}, índices ${bytes(t.indexes)}`}>
                <span className="name">{t.label}</span>
                <small className="muted mono-num">{nf(t.rows)} {t.rows === 1 ? "linha" : "linhas"}</small>
                <strong className="mono-num">{bytes(t.total)}</strong>
                <span className="bar"><i style={{ width: `${pct(t.total, maxTable)}%` }} /></span>
              </div>
            ))}
          </div>
        </div>
        <Growth history={data.history} />
        </div>

        <div className="srv-col">
          <div className="card srv-card srv-redis">
            <div className="srv-head">
              <h3>Redis</h3>
              {rd?.ok && <span className="chip-mini">{rd.policy === "noeviction" ? "não descarta" : (rd.policy ?? "")}</span>}
            </div>
            {!rd ? (
              <p className="muted srv-note">Sem REDIS_URL: a memória curta das conversas fica no Postgres.</p>
            ) : !rd.ok ? (
              <p className="srv-note err">O Redis não respondeu agora. As conversas seguem pelo Postgres até ele voltar.</p>
            ) : (
              <>
                <div className="srv-bar-row">
                  <span>Memória</span>
                  <strong className="mono-num">{bytes(rd.used)} <span className="muted">{rd.max ? `de ${bytes(rd.max)}` : "sem limite"}</span></strong>
                  <Meter value={rd.used ?? 0} total={rd.max ?? null} label="Memória do Redis" />
                </div>
                {redisFull >= 80 && rd.policy === "noeviction" && <p className="srv-note warn">Quase cheio: com "noeviction" o Redis recusa gravar quando enche. Aumente o maxmemory na stack.</p>}
                <dl className="srv-mini">
                  <div><dt>Chaves</dt><dd className="mono-num">{nf(rd.keys ?? 0)}</dd></div>
                  <div><dt>Acertos</dt><dd className="mono-num">{rd.hitRate != null ? `${nf(rd.hitRate, 1)}%` : "–"}</dd></div>
                  <div><dt>Pico</dt><dd className="mono-num">{bytes(rd.peak)}</dd></div>
                  <div><dt>Conexões</dt><dd className="mono-num">{rd.clients}</dd></div>
                </dl>
                {(rd.groups ?? []).length > 0 && (
                  <div className="srv-groups srv-scroll">
                    {(rd.groups ?? []).map((g) => (
                      <div key={g.label} className="srv-rank">
                        <span className="name">{g.label}</span>
                        <small className="muted mono-num">{nf(g.keys)}</small>
                        <strong className="mono-num">{bytes(g.bytes)}</strong>
                        <span className="bar"><i style={{ width: `${pct(g.bytes, maxGroup)}%` }} /></span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {data.redisCache?.ok && (
              <div className="srv-bar-row srv-cache">
                <span>Redis de cache</span>
                <strong className="mono-num">{bytes(data.redisCache.used)} <span className="muted">{data.redisCache.max ? `de ${bytes(data.redisCache.max)}` : ""}</span></strong>
                <Meter value={data.redisCache.used ?? 0} total={data.redisCache.max ?? null} label="Redis de cache" />
              </div>
            )}
          </div>
          <div className="card srv-card srv-small">
            <div className="srv-head"><h3>Navegador dos agentes</h3><span className="spacer" />{data.browser?.ok && <span className="chip-mini">no ar</span>}</div>
            {data.browser?.ok ? (
              <dl className="srv-mini">
                <div><dt>Abertos</dt><dd className="mono-num">{data.browser.running}{data.browser.maxConcurrent ? <span className="muted"> de {data.browser.maxConcurrent}</span> : null}</dd></div>
                <div><dt>Na fila</dt><dd className="mono-num">{data.browser.queued}</dd></div>
                <div><dt>CPU</dt><dd className="mono-num">{data.browser.cpu != null ? `${nf(data.browser.cpu)}%` : "–"}</dd></div>
                <div><dt>Memória</dt><dd className="mono-num">{data.browser.memory != null ? `${nf(data.browser.memory)}%` : "–"}</dd></div>
              </dl>
            ) : (
              <p className="muted srv-note">{data.browser ? "O Browserless não respondeu agora." : "Browserless não configurado."}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Tamanho do banco por dia (foto de hora em hora, guardada uma por dia). */
function Growth({ history }: { history: Overview["history"] }) {
  const max = Math.max(1, ...history.map((h) => h.db_bytes));
  const first = history[0];
  const last = history[history.length - 1];
  const delta = first && last ? last.db_bytes - first.db_bytes : 0;
  return (
    <div className="card srv-card srv-small">
      <div className="srv-head">
        <h3>Crescimento do banco</h3>
        <span className="spacer" />
        {history.length > 1 && <small className="muted mono-num">{delta >= 0 ? "+" : "−"}{bytes(Math.abs(delta))} em {history.length} dias</small>}
      </div>
      {history.length > 1 ? (
        <div className="srv-days">
          {history.map((h) => (
            <i key={h.day} style={{ height: `${Math.max(4, pct(h.db_bytes, max))}%` }} title={`${new Date(h.day).toLocaleDateString("pt-BR", { timeZone: "UTC" })}: ${bytes(h.db_bytes)}`} />
          ))}
        </div>
      ) : (
        <p className="muted srv-note">A foto é tirada de hora em hora. O gráfico aparece a partir do segundo dia.</p>
      )}
    </div>
  );
}

// ================= Armazenamento por cliente =================

/** Quanto cada cliente ocupa (só tamanhos, nunca o conteúdo). */
export function StoragePage() {
  const { data, error, setData } = useApi<Storage>("/api/resources/storage");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = data?.clients ?? [];
    return s ? all.filter((c) => `${c.name ?? ""} ${c.phone} ${c.email ?? ""}`.toLowerCase().includes(s)) : all;
  }, [data, q]);
  if (error && !data) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const refresh = async () => {
    setBusy(true);
    try {
      setData(await api<Storage>("/api/resources/storage?fresh=1"));
    } finally {
      setBusy(false);
    }
  };
  const top = data.clients[0];
  const active = data.clients.filter((c) => c.bytes > 0);
  const files = data.clients.reduce((a, c) => a + c.files, 0);
  const fileBytes = data.clients.reduce((a, c) => a + c.fileBytes, 0);
  const recent = data.clients.reduce((a, c) => a + c.recent, 0);
  const maxClient = Math.max(1, ...data.clients.map((c) => c.bytes));
  const cats = data.categories.filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes);

  return (
    <div className="page page-wide fit srv-page">
      <div className="hide-phone">
        <PageHead
          title="Armazenamento"
          subtitle="Quanto cada cliente ocupa no banco e no Redis. Só tamanhos, nunca o conteúdo."
          actions={<button className="btn" disabled={busy} onClick={() => { haptic(5); void refresh(); }}><Icon name="refresh" size={15} /> {busy ? "Medindo" : "Medir de novo"}</button>}
        />
      </div>

      <div className="card srv-kpis four">
        <Kpi label="Dos clientes" value={bytes(data.attributed)} meter={<Meter value={data.attributed} total={data.dbBytes} label="Parte dos clientes no banco" share />} sub={`${nf(pct(data.attributed, data.dbBytes))}% do banco de ${bytes(data.dbBytes)}`} />
        <Kpi label="Arquivos guardados" value={bytes(fileBytes)} sub={`em ${nf(files)} ${files === 1 ? "arquivo" : "arquivos"}`} />
        <Kpi label="Média por cliente" value={bytes(active.length ? data.attributed / active.length : 0)} sub={top && top.bytes ? `maior: ${(top.name ?? phoneFmt(top.phone)).split(" ")[0]}, ${bytes(top.bytes)}` : "ninguém guardou nada ainda"} />
        <Kpi label="Entrou em 7 dias" value={`+${bytes(recent)}`} sub={`${bytes(data.redisBytes)} no Redis agora`} />
      </div>

      <div className="srv-body two">
        <div className="card srv-card srv-clients">
          <div className="srv-head">
            <h3>Por cliente</h3>
            <span className="chip-mini">{data.clients.length}</span>
            <span className="spacer" />
            <label className="srv-search">
              <Icon name="search" size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nome, telefone ou e-mail" aria-label="Buscar cliente" />
            </label>
          </div>
          <div className="srv-legend">
            {(Object.keys(CAT_COLOR) as Cat[]).map((k) => (
              <span key={k}><i style={{ background: CAT_COLOR[k] }} />{CAT_LABEL[k]}</span>
            ))}
          </div>
          <div className="srv-scroll">
            {list.map((c, i) => (
              <button key={c.id} className="srv-client" onClick={() => { haptic(5); setOpen(c); }}>
                <span className="srv-rank-n mono-num">{q ? "" : i + 1}</span>
                <span className="srv-client-who">
                  <strong className="ellipsis">{c.name || phoneFmt(c.phone)}</strong>
                  <small className="muted ellipsis">{c.email ?? phoneFmt(c.phone)}{c.files ? ` · ${c.files} ${c.files === 1 ? "arquivo" : "arquivos"}` : ""}</small>
                </span>
                <span className="srv-client-bar">
                  <span className="srv-client-track" style={{ width: `${Math.max(3, pct(c.bytes, maxClient))}%` }}>
                    <Stack cats={c.categories} total={c.bytes} />
                  </span>
                </span>
                <span className="srv-client-num">
                  <strong className="mono-num">{bytes(c.bytes)}</strong>
                  <small className="muted mono-num">{c.recent ? `+${bytes(c.recent)} em 7d` : "parado"}</small>
                </span>
                <Icon name="chevron-right" size={15} className="muted" />
              </button>
            ))}
            {!list.length && <Empty>{q ? "Ninguém com esse nome." : "Nenhum cliente ainda."}</Empty>}
          </div>
        </div>

        <div className="srv-col">
          <div className="card srv-card">
            <div className="srv-head"><h3>Por tipo de dado</h3></div>
            <div className="srv-ring-row">
              <Ring items={data.categories} center={<div><small className="muted">clientes</small><div className="mono-num" style={{ fontWeight: 650 }}>{bytes(data.attributed)}</div></div>} />
              <div className="srv-ring-legend">
                {cats.map((c) => (
                  <div key={c.id}>
                    <i style={{ background: CAT_COLOR[c.id] }} />
                    <span className="name">{CAT_LABEL[c.id]}</span>
                    <strong className="mono-num">{bytes(c.bytes)}</strong>
                    <small className="muted mono-num">{pctLabel(c.bytes, data.attributed)}</small>
                  </div>
                ))}
                {!cats.length && <small className="muted">Nada guardado ainda.</small>}
              </div>
            </div>
          </div>
          <div className="card srv-card srv-small">
            <div className="srv-head"><h3>Da plataforma</h3><span className="spacer" /><strong className="mono-num">{bytes(data.platform)}</strong></div>
            <p className="muted srv-note">
              O que não é de nenhum cliente: sessão do WhatsApp, filas, configurações, integrações e o catálogo do próprio Postgres
              {data.unowned ? `, mais ${bytes(data.unowned)} de registros sem dono (testes, execuções de sistema)` : ""}.
            </p>
            <Meter value={data.platform} total={data.dbBytes} label="Parte da plataforma" share />
          </div>
        </div>
      </div>

      {open && <ClientSheet client={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ClientSheet({ client: c, onClose }: { client: Client; onClose: () => void }) {
  const cats = (Object.keys(CAT_COLOR) as Cat[]).filter((k) => c.categories[k] > 0).sort((a, b) => c.categories[b] - c.categories[a]);
  return (
    <Modal title={c.name || phoneFmt(c.phone)} icon={<Icon name="database" />} onClose={onClose}>
      <div className="srv-sheet">
        <div className="srv-sheet-top">
          <Ring items={cats.map((id) => ({ id, bytes: c.categories[id] }))} size={118} center={<div className="mono-num" style={{ fontWeight: 650 }}>{bytes(c.bytes)}</div>} />
          <dl className="kv">
            <dt>Telefone</dt><dd className="mono-num">{phoneFmt(c.phone)}</dd>
            {c.email && <><dt>E-mail</dt><dd>{c.email}</dd></>}
            <dt>Arquivos</dt><dd className="mono-num">{c.files} ({bytes(c.fileBytes)})</dd>
            <dt>Em 7 dias</dt><dd className="mono-num">+{bytes(c.recent)}</dd>
            <dt>Redis agora</dt><dd className="mono-num">{bytes(c.redisBytes)}</dd>
            <dt>Visto</dt><dd>{c.last_seen_at ? ago(c.last_seen_at) : "nunca"}</dd>
          </dl>
        </div>
        <div className="srv-sheet-cats">
          {cats.map((id) => (
            <div key={id} className="srv-rank">
              <span className="name"><Icon name={CAT_ICON[id]} size={14} /> {CAT_LABEL[id]}</span>
              <small className="muted mono-num">{pctLabel(c.categories[id], c.bytes)}</small>
              <strong className="mono-num">{bytes(c.categories[id])}</strong>
              <span className="bar"><i style={{ width: `${pct(c.categories[id], c.bytes)}%`, background: CAT_COLOR[id] }} /></span>
            </div>
          ))}
        </div>
        <h4 className="srv-sub">Tabelas</h4>
        <div className="srv-tables">
          {c.tables.filter((t) => t.bytes > 0).map((t) => (
            <div key={t.table}>
              <span>{t.label}</span>
              <small className="muted mono-num">{nf(t.rows)} {t.rows === 1 ? "linha" : "linhas"}</small>
              <strong className="mono-num">{bytes(t.bytes)}</strong>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
