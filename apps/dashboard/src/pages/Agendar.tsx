import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "../icons";
import "../agendar.css";

/**
 * Página pública de agendamento (/agendar/<slug>), aberta pela bio do Instagram, sem login. No jeito do Calendly:
 * serviço, mês com os dias que têm horário livre, horários do dia e, por fim, nome, WhatsApp e e-mail. No notebook fica
 * tudo lado a lado num cartão; no celular desce numa coluna só. Horários sempre no fuso da agenda (o servidor manda).
 * /agendar/horario/<token>: o cliente vê o horário dele e desmarca.
 */

interface Service {
  id: string;
  name: string;
  minutes: number;
}
interface Page {
  slug: string;
  title: string;
  about: string | null;
  services: Service[];
  days_ahead: number;
}
interface Slots {
  service: string | null;
  tz: string;
  days: Record<string, string[]>;
}
interface Done {
  token: string;
  service: string;
  start: string;
  end: string;
}

const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const duration = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
const hour = (iso: string, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const longDay = (iso: string, tz: string) => cap(new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(new Date(iso)));
const dayTitle = (key: string) => cap(new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${key}T12:00:00Z`)));
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Máscara do WhatsApp brasileiro: (11) 98765-4321. Com + na frente fica como a pessoa digitou. */
function maskPhone(v: string) {
  if (v.trim().startsWith("+")) return v.replace(/[^\d+ ()-]/g, "").slice(0, 20);
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function useTheme() {
  // a página segue o tema do aparelho de quem abre (ou o que a pessoa escolheu no painel, se for ela mesma)
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("pj-theme");
    } catch {
      /* navegador sem armazenamento */
    }
    const apply = () => {
      const dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
}

function Brand() {
  return (
    <a className="ag-brand" href="/" target="_blank" rel="noreferrer">
      Agenda feita com <strong>Planejai</strong>
    </a>
  );
}

export function AgendarPage({ slug }: { slug: string }) {
  useTheme();
  const [page, setPage] = useState<Page | null>(null);
  const [missing, setMissing] = useState(false);
  const [service, setService] = useState<string>("");
  const [slots, setSlots] = useState<Slots | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "form" | "done">("pick");
  const [f, setF] = useState({ name: "", phone: "", email: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    api<Page>(`/api/agendar/${encodeURIComponent(slug)}`).then(
      (p) => {
        setPage(p);
        setService(p.services[0]?.id ?? "");
        document.title = `Agende com ${p.title}`;
      },
      () => setMissing(true),
    );
  }, [slug]);

  const loadSlots = (id: string, keepDay = false) => {
    setLoadingSlots(true);
    return api<Slots>(`/api/agendar/${encodeURIComponent(slug)}/horarios?servico=${encodeURIComponent(id)}`)
      .then((s) => {
        setSlots(s);
        const first = Object.keys(s.days).sort()[0];
        setDay((d) => (keepDay && d && s.days[d] ? d : (first ?? null)));
        if (first && !keepDay) setMonth({ y: Number(first.slice(0, 4)), m: Number(first.slice(5, 7)) - 1 });
      })
      .catch(() => setSlots({ service: id, tz: "America/Sao_Paulo", days: {} }))
      .finally(() => setLoadingSlots(false));
  };
  useEffect(() => {
    if (service) {
      setTime(null);
      void loadSlots(service);
    }
  }, [service]);

  const svc = page?.services.find((s) => s.id === service) ?? null;
  const tz = slots?.tz ?? "America/Sao_Paulo";
  const todayKey = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()), [tz]);

  const grid = useMemo(() => {
    if (!month) return [];
    const first = new Date(Date.UTC(month.y, month.m, 1)).getUTCDay();
    const total = new Date(Date.UTC(month.y, month.m + 1, 0)).getUTCDate();
    const cells: (string | null)[] = Array.from({ length: first }, () => null);
    for (let d = 1; d <= total; d++) cells.push(keyOf(month.y, month.m, d));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [month]);

  const lastKey = useMemo(() => Object.keys(slots?.days ?? {}).sort().at(-1) ?? todayKey, [slots, todayKey]);
  const canPrev = month ? keyOf(month.y, month.m, 1) > todayKey.slice(0, 8) + "01" : false;
  const canNext = month ? keyOf(month.y, month.m + 1, 1) <= lastKey : false;
  const moveMonth = (n: number) => month && setMonth({ y: month.m + n < 0 ? month.y - 1 : month.m + n > 11 ? month.y + 1 : month.y, m: (month.m + n + 12) % 12 });

  const submit = async () => {
    if (!svc || !time) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Done>(`/api/agendar/${encodeURIComponent(slug)}`, { method: "POST", json: { service: svc.id, start: time, ...f } });
      setDone(r);
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      // horário tomado por outra pessoa: atualiza a lista para ela escolher de novo
      if (/ocupado/.test((e as Error).message)) void loadSlots(svc.id, true);
    } finally {
      setBusy(false);
    }
  };

  if (missing)
    return (
      <div className="ag-page">
        <div className="ag-card ag-card-small">
          <span className="ag-big-ico" aria-hidden="true"><Icon name="calendar" size={28} /></span>
          <h1>Agenda não encontrada</h1>
          <p className="ag-muted">Esse link não existe ou a agenda está fechada no momento. Confira o endereço com quem te mandou.</p>
        </div>
        <Brand />
      </div>
    );
  if (!page)
    return (
      <div className="ag-page">
        <div className="ag-card ag-card-small ag-loading" aria-busy="true" />
      </div>
    );

  const times = (day && slots?.days[day]) || [];
  const hasAny = Object.keys(slots?.days ?? {}).length > 0;

  const summary = svc && time && (
    <div className="ag-summary">
      <span><Icon name="calendar" size={16} /> {longDay(time, tz)}</span>
      <span><Icon name="clock" size={16} /> {hour(time, tz)} até {hour(new Date(new Date(time).getTime() + svc.minutes * 60_000).toISOString(), tz)}</span>
    </div>
  );

  return (
    <div className="ag-page">
      <div className={`ag-card ag-step-${step}`}>
        <aside className="ag-side">
          <div className="ag-avatar" aria-hidden="true">{initials(page.title)}</div>
          <p className="ag-kicker">Agendar horário</p>
          <h1>{page.title}</h1>
          {page.about && <p className="ag-muted ag-about">{page.about}</p>}
          {step !== "done" && page.services.length > 1 && (
            <div className="ag-services" role="radiogroup" aria-label="Serviço">
              {page.services.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={s.id === service}
                  className={s.id === service ? "on" : ""}
                  disabled={step === "form"}
                  onClick={() => setService(s.id)}
                >
                  <span>{s.name}</span>
                  <small>{duration(s.minutes)}</small>
                </button>
              ))}
            </div>
          )}
          {step !== "done" && page.services.length === 1 && svc && (
            <p className="ag-one"><Icon name="clock" size={16} /> {svc.name}, {duration(svc.minutes)}</p>
          )}
          {step === "form" && summary}
        </aside>

        {step === "pick" && (
          <section className="ag-main">
            <div className="ag-cal">
              <div className="ag-cal-head">
                <h2>{month ? `${cap(MONTHS[month.m]!)} ${month.y}` : "Escolha o dia"}</h2>
                <div className="ag-cal-nav">
                  <button type="button" className="ag-icon" aria-label="Mês anterior" disabled={!canPrev} onClick={() => moveMonth(-1)}><Icon name="chevron-left" size={18} /></button>
                  <button type="button" className="ag-icon" aria-label="Próximo mês" disabled={!canNext} onClick={() => moveMonth(1)}><Icon name="chevron-right" size={18} /></button>
                </div>
              </div>
              <div className="ag-week" aria-hidden="true">{WEEK.map((w) => <span key={w}>{w}</span>)}</div>
              <div className={`ag-grid ${loadingSlots ? "is-loading" : ""}`} role="grid" aria-label="Dias">
                {grid.map((k, i) =>
                  k ? (
                    <button
                      key={k}
                      type="button"
                      className={`ag-day ${slots?.days[k] ? "free" : ""} ${k === day ? "sel" : ""} ${k === todayKey ? "today" : ""}`}
                      disabled={!slots?.days[k]}
                      aria-label={dayTitle(k)}
                      aria-pressed={k === day}
                      onClick={() => {
                        setDay(k);
                        setTime(null);
                      }}
                    >
                      {Number(k.slice(8))}
                    </button>
                  ) : (
                    <span key={`v${i}`} />
                  ),
                )}
              </div>
              <p className="ag-tz">{tz === "America/Sao_Paulo" ? "Horários de Brasília" : `Horários no fuso ${tz.replace(/_/g, " ")}`}</p>
            </div>

            <div className="ag-times">
              {loadingSlots && !slots ? (
                <p className="ag-muted">Procurando horários livres...</p>
              ) : !hasAny ? (
                <div className="ag-empty">
                  <strong>Sem horários livres agora</strong>
                  <p className="ag-muted">Todos os horários dos próximos {page.days_ahead} dias já estão ocupados. Volte mais tarde.</p>
                </div>
              ) : day ? (
                <>
                  <h3>{dayTitle(day)}</h3>
                  <div className="ag-time-list">
                    {times.map((t) => (
                      <button
                        key={t}
                        type="button"
                        className={t === time ? "on" : ""}
                        onClick={() => {
                          setTime(t);
                          setError(null);
                          setStep("form");
                        }}
                      >
                        {hour(t, tz)}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          </section>
        )}

        {step === "form" && svc && time && (
          <section className="ag-main ag-form">
            <button type="button" className="ag-back" onClick={() => setStep("pick")}><Icon name="chevron-left" size={16} /> Trocar horário</button>
            <h2>Seus dados</h2>
            <p className="ag-muted">Você recebe a confirmação e um lembrete perto do horário no WhatsApp.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label className="ag-field">
                <span>Nome</span>
                <input name="name" autoComplete="name" required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </label>
              <label className="ag-field">
                <span>WhatsApp</span>
                <input name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="(11) 98765-4321" value={f.phone} onChange={(e) => setF({ ...f, phone: maskPhone(e.target.value) })} />
              </label>
              <label className="ag-field">
                <span>E-mail <em>opcional</em></span>
                <input name="email" type="email" inputMode="email" autoComplete="email" maxLength={120} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              </label>
              <label className="ag-field">
                <span>Algum recado? <em>opcional</em></span>
                <textarea name="note" rows={2} maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
              </label>
              {error && <p className="ag-error" role="alert">{error}</p>}
              <button className="ag-primary" disabled={busy || f.name.trim().length < 2 || f.phone.replace(/\D/g, "").length < 10}>
                {busy ? "Confirmando..." : "Confirmar horário"}
              </button>
              <p className="ag-fine">Seus dados ficam só com {page.title}, para confirmar e lembrar o horário.</p>
            </form>
          </section>
        )}

        {step === "done" && done && (
          <section className="ag-main ag-done">
            <span className="ag-big-ico ok" aria-hidden="true"><Icon name="check" size={30} /></span>
            <h2>Horário confirmado</h2>
            <p className="ag-muted">Mandamos a confirmação no seu WhatsApp. Perto da data você recebe um lembrete.</p>
            <div className="ag-ticket">
              <strong>{done.service}</strong>
              <span>{longDay(done.start, tz)}</span>
              <span>{hour(done.start, tz)} até {hour(done.end, tz)}</span>
            </div>
            <div className="ag-actions">
              <a className="ag-secondary" href={googleLink(done, page.title)} target="_blank" rel="noreferrer"><Icon name="calendar" size={16} /> Pôr na minha agenda</a>
              <a className="ag-link" href={`/agendar/horario/${done.token}`}>Ver ou desmarcar</a>
            </div>
          </section>
        )}
      </div>
      <Brand />
    </div>
  );
}

const gcal = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function googleLink(d: { service: string; start: string; end: string }, title: string) {
  const q = new URLSearchParams({ action: "TEMPLATE", text: `${d.service} com ${title}`, dates: `${gcal(d.start)}/${gcal(d.end)}` });
  return `https://calendar.google.com/calendar/render?${q}`;
}

interface Mine {
  title: string;
  slug: string | null;
  service: string;
  start: string;
  end: string;
  name: string;
  status: string;
  tz: string;
  cancelled_by: string | null;
  can_cancel: boolean;
}

/** /agendar/horario/<token>: o cliente vê o horário dele e desmarca, sem login. */
export function MeuHorarioPage({ token }: { token: string }) {
  useTheme();
  const [b, setB] = useState<Mine | null>(null);
  const [missing, setMissing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Mine>(`/api/agendar/horario/${encodeURIComponent(token)}`).then(setB, () => setMissing(true));
  }, [token]);
  const cancel = async () => {
    setBusy(true);
    try {
      setB(await api<Mine>(`/api/agendar/horario/${encodeURIComponent(token)}/desmarcar`, { method: "POST" }));
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  if (missing)
    return (
      <div className="ag-page">
        <div className="ag-card ag-card-small">
          <span className="ag-big-ico" aria-hidden="true"><Icon name="calendar" size={28} /></span>
          <h1>Horário não encontrado</h1>
          <p className="ag-muted">Confira o link que chegou no seu WhatsApp.</p>
        </div>
        <Brand />
      </div>
    );
  if (!b) return <div className="ag-page"><div className="ag-card ag-card-small ag-loading" aria-busy="true" /></div>;
  const tz = b.tz;
  const off = b.status !== "confirmado";
  const past = !off && !b.can_cancel;
  return (
    <div className="ag-page">
      <div className="ag-card ag-card-small">
        <span className={`ag-big-ico ${off ? "" : "ok"}`} aria-hidden="true"><Icon name={off ? "x" : "check"} size={28} /></span>
        <p className="ag-kicker">{b.title}</p>
        <h1>{off ? "Horário desmarcado" : past ? "Esse horário já passou" : `Oi, ${b.name}! Seu horário está marcado`}</h1>
        <div className={`ag-ticket ${off ? "off" : ""}`}>
          <strong>{b.service}</strong>
          <span>{longDay(b.start, tz)}</span>
          <span>{hour(b.start, tz)} até {hour(b.end, tz)}</span>
        </div>
        {off && <p className="ag-muted">{b.cancelled_by === "dono" ? `${b.title} precisou desmarcar.` : "Você desmarcou e o horário ficou livre para outra pessoa."}</p>}
        <div className="ag-actions">
          {b.can_cancel && !asking && <button className="ag-secondary" onClick={() => setAsking(true)}>Desmarcar</button>}
          {asking && (
            <>
              <button className="ag-danger" disabled={busy} onClick={cancel}>{busy ? "Desmarcando..." : "Sim, desmarcar"}</button>
              <button className="ag-link" onClick={() => setAsking(false)}>Manter horário</button>
            </>
          )}
          {b.slug && (off || past) && <a className="ag-primary" href={`/agendar/${b.slug}`}>Escolher outro horário</a>}
          {b.slug && !off && !past && !asking && <a className="ag-link" href={`/agendar/${b.slug}`}>Marcar outro horário</a>}
        </div>
      </div>
      <Brand />
    </div>
  );
}
