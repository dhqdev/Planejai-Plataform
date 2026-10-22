import { useState } from "react";
import { api, phoneFmt } from "../api";
import { confirmDialog, ErrorBox, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { TimeField } from "../pickers";
import { haptic } from "../touch";
import "../styles/agendamento-painel.css";

/**
 * Link de agendamento (estilo Calendly) dentro da Agenda: o cartão abre a janela para ligar a página pública, escolher o
 * endereço, os serviços, os horários da semana e os avisos, e ver quem marcou. O que o cliente marca cai na Agenda como
 * compromisso (tag Agendamento) e respeita o Google Agenda conectado.
 */

type Range = [string, string];
interface Service {
  id: string;
  name: string;
  minutes: number;
}
interface Page {
  slug: string;
  enabled: boolean;
  title: string;
  about: string | null;
  services: Service[];
  hours: Record<string, Range[]>;
  step_min: number;
  buffer_min: number;
  notice_min: number;
  days_ahead: number;
  owner_lead_min: number;
  client_leads: number[];
}
interface Booking {
  id: string;
  service: string;
  minutes: number;
  start_at: string;
  end_at: string;
  client_name: string;
  client_phone: string;
  client_email: string | null;
  note: string | null;
  status: "confirmado" | "desmarcado";
  cancelled_by: string | null;
}
interface Data {
  page: Page;
  url: string;
  base: string;
  google: boolean;
  bookings: Booking[];
}

const DAYS: [string, string][] = [["1", "Segunda"], ["2", "Terça"], ["3", "Quarta"], ["4", "Quinta"], ["5", "Sexta"], ["6", "Sábado"], ["0", "Domingo"]];
const DURATIONS = [15, 20, 30, 40, 45, 50, 60, 75, 90, 120, 150, 180, 240];
const STEPS = [15, 30, 60];
const BUFFERS = [0, 10, 15, 30];
const NOTICES = [0, 60, 120, 240, 1440];
const AHEAD = [7, 14, 30, 60, 90];
const OWNER_LEADS = [0, 15, 30, 60, 120, 1440];
const CLIENT_LEADS = [1440, 180, 120, 60, 30];
const duration = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`);
const lead = (m: number) => (m === 0 ? "Na hora" : m % 1440 === 0 ? `${m / 1440} dia antes` : m % 60 === 0 ? `${m / 60} h antes` : `${m} min antes`);
const notice = (m: number) => (m === 0 ? "Nenhuma" : m % 1440 === 0 ? `${m / 1440} dia` : `${m / 60} h`);
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40);

export function BookingCard({ variant }: { variant: "side" | "phone" }) {
  const d = useApi<Data>("/api/booking");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!d.data) return null;
  const on = d.data.page.enabled;
  const upcoming = d.data.bookings.filter((b) => b.status === "confirmado" && new Date(b.end_at) > new Date()).length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(d.data!.url);
      haptic(10);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setOpen(true);
    }
  };
  return (
    <>
      <div className={`bk-card bk-card-${variant} ${on ? "on" : ""}`}>
        <button type="button" className="bk-card-main" onClick={() => setOpen(true)}>
          <span className="bk-card-ico" aria-hidden="true"><Icon name="link" size={variant === "phone" ? 18 : 20} /></span>
          <span className="bk-card-text">
            <strong>Link de agendamento</strong>
            <small>{on ? (upcoming ? `${upcoming} horário${upcoming > 1 ? "s" : ""} marcado${upcoming > 1 ? "s" : ""}` : "Aberto para seus clientes") : "Seus clientes marcam pela bio do Instagram"}</small>
          </span>
        </button>
        {on ? (
          <button type="button" className="btn btn-sm bk-card-btn" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copiado" : "Copiar"}
          </button>
        ) : (
          <button type="button" className="btn btn-brand btn-sm bk-card-btn" onClick={() => setOpen(true)}>Criar link</button>
        )}
      </div>
      {open && (
        <BookingModal
          data={d.data}
          onClose={(changed) => {
            setOpen(false);
            if (changed) void d.reload();
          }}
        />
      )}
    </>
  );
}

function BookingModal({ data, onClose }: { data: Data; onClose: (changed: boolean) => void }) {
  const [tab, setTab] = useState<"link" | "horarios" | "avisos" | "marcados">(data.page.enabled && data.bookings.length ? "marcados" : "link");
  const [p, setP] = useState<Page>(() => ({ ...data.page, services: data.page.services.map((s) => ({ ...s })), hours: JSON.parse(JSON.stringify(data.page.hours)) }));
  const [bookings, setBookings] = useState(data.bookings);
  const [saved, setSaved] = useState(JSON.stringify(data.page));
  const [url, setUrl] = useState(data.url);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [changed, setChanged] = useState(false);
  const dirty = JSON.stringify(p) !== saved;

  const save = async (next = p) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ page: Page; url: string }>("/api/booking", { method: "PUT", json: next });
      setP(r.page);
      setSaved(JSON.stringify(r.page));
      setUrl(r.url);
      setChanged(true);
      haptic(12);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      haptic(10);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* sem permissão: o endereço está escrito na tela */
    }
  };
  const setDay = (day: string, ranges: Range[] | null) => {
    const hours = { ...p.hours };
    if (ranges && ranges.length) hours[day] = ranges;
    else delete hours[day];
    setP({ ...p, hours });
  };
  const cancel = async (b: Booking) => {
    const ok = await confirmDialog({
      title: "Desmarcar este horário?",
      body: `${b.client_name} recebe uma mensagem no WhatsApp avisando que foi desmarcado, com o link para escolher outro horário.`,
      confirmLabel: "Desmarcar",
      cancelLabel: "Manter",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/booking/bookings/${b.id}`, { method: "DELETE" });
      setBookings(bookings.map((x) => (x.id === b.id ? { ...x, status: "desmarcado", cancelled_by: "dono" } : x)));
      setChanged(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const upcoming = bookings.filter((b) => new Date(b.end_at) > new Date());
  const TABS: [typeof tab, string][] = [["link", "Página"], ["horarios", "Horários"], ["avisos", "Avisos"], ["marcados", `Marcados${upcoming.filter((b) => b.status === "confirmado").length ? ` (${upcoming.filter((b) => b.status === "confirmado").length})` : ""}`]];

  return (
    <Modal
      title="Link de agendamento"
      icon={<Icon name="link" />}
      wide
      className="bk-modal"
      onClose={() => onClose(changed)}
      footer={(close) => (
        <>
          {!p.enabled && !dirty ? (
            <button className="btn btn-brand" disabled={busy} onClick={() => void save({ ...p, enabled: true })}>{busy ? "Abrindo..." : "Abrir para clientes"}</button>
          ) : dirty ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : "Salvar"}</button>
          ) : (
            <button className="btn" onClick={close}>Pronto</button>
          )}
        </>
      )}
    >
      <div className="seg bk-tabs" role="tablist" aria-label="Link de agendamento">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />

      {tab === "link" && (
        <div className="bk-pane">
          <div className="bk-url">
            <div className="bk-url-text">
              <span className={`bk-dot ${p.enabled ? "on" : ""}`} aria-hidden="true" />
              <span>{p.enabled ? "Aberto para clientes" : "Fechado: ninguém consegue marcar"}</span>
            </div>
            <div className="bk-url-row">
              <span className="bk-url-base">{data.base.replace(/^https?:\/\//, "")}</span>
              <input
                className="input bk-slug"
                name="slug"
                aria-label="Endereço do link"
                value={p.slug}
                maxLength={40}
                onChange={(e) => setP({ ...p, slug: slugify(e.target.value) })}
              />
            </div>
            <div className="bk-url-actions">
              <button type="button" className="btn btn-sm" disabled={dirty} onClick={copy}><Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copiado" : "Copiar link"}</button>
              <a className={`btn btn-sm ${dirty ? "disabled" : ""}`} href={url} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> Ver página</a>
              {p.enabled && (
                <button type="button" className="btn btn-sm bk-close" disabled={busy} onClick={() => void save({ ...p, enabled: false })}>Fechar agenda</button>
              )}
            </div>
            <small className="muted">Cole na bio do Instagram ou mande no WhatsApp. Quem abrir escolhe um horário livre na sua agenda.</small>
          </div>

          <div className="bk-gap">
            <div className="field">
              <label htmlFor="bk-title">Nome na página</label>
              <input id="bk-title" name="title" className="input" maxLength={60} value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="bk-about">Frase curta</label>
              <input id="bk-about" name="about" className="input" maxLength={160} placeholder="Ex.: Studio de unhas no Centro" value={p.about ?? ""} onChange={(e) => setP({ ...p, about: e.target.value })} />
            </div>
          </div>

          <div className="field">
            <span className="bk-label">Serviços</span>
            <div className="bk-services">
              {p.services.map((s, i) => (
                <div key={i} className="bk-service">
                  <input
                    className="input"
                    name={`service-${i}`}
                    aria-label="Nome do serviço"
                    maxLength={60}
                    placeholder="Ex.: Corte de cabelo"
                    value={s.name}
                    onChange={(e) => setP({ ...p, services: p.services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                  />
                  <select
                    className="select"
                    name={`minutes-${i}`}
                    aria-label="Duração"
                    value={s.minutes}
                    onChange={(e) => setP({ ...p, services: p.services.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)) })}
                  >
                    {(DURATIONS.includes(s.minutes) ? DURATIONS : [...DURATIONS, s.minutes].sort((a, b) => a - b)).map((m) => (
                      <option key={m} value={m}>{duration(m)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Tirar serviço"
                    disabled={p.services.length < 2}
                    onClick={() => setP({ ...p, services: p.services.filter((_, j) => j !== i) })}
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
            {p.services.length < 12 && (
              <button type="button" className="btn btn-sm bk-add" onClick={() => setP({ ...p, services: [...p.services, { id: "", name: "", minutes: 60 }] })}>
                <Icon name="plus" size={15} /> Adicionar serviço
              </button>
            )}
          </div>
        </div>
      )}

      {tab === "horarios" && (
        <div className="bk-pane">
          <div className="bk-days">
            {DAYS.map(([day, label]) => {
              const ranges = p.hours[day] ?? [];
              const on = ranges.length > 0;
              return (
                <div key={day} className={`bk-day ${on ? "on" : ""}`}>
                  <button type="button" role="switch" aria-checked={on} className="bk-switch-row" onClick={() => setDay(day, on ? null : [["09:00", "18:00"]])}>
                    <span className={`bk-switch ${on ? "on" : ""}`} aria-hidden="true"><i /></span>
                    <span>{label}</span>
                  </button>
                  <div className="bk-ranges">
                    {on ? (
                      ranges.map((r, i) => (
                        <div key={i} className="bk-range">
                          <TimeField id={`bk-${day}-${i}-a`} title={`${label}: começa`} step={15} value={r[0]} onChange={(v) => setDay(day, ranges.map((x, j) => (j === i ? [v, x[1]] : x)))} />
                          <span className="muted">até</span>
                          <TimeField id={`bk-${day}-${i}-b`} title={`${label}: termina`} step={15} value={r[1]} onChange={(v) => setDay(day, ranges.map((x, j) => (j === i ? [x[0], v] : x)))} />
                          {i === ranges.length - 1 && ranges.length < 3 ? (
                            <button type="button" className="icon-btn" aria-label="Mais uma faixa (ex.: depois do almoço)" onClick={() => setDay(day, [...ranges, [r[1] < "13:00" ? "13:00" : r[1], r[1] < "13:00" ? "18:00" : "20:00"]])}>
                              <Icon name="plus" size={16} />
                            </button>
                          ) : (
                            <span className="bk-spacer" />
                          )}
                          {ranges.length > 1 && (
                            <button type="button" className="icon-btn" aria-label="Tirar esta faixa" onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}>
                              <Icon name="x" size={16} />
                            </button>
                          )}
                        </div>
                      ))
                    ) : (
                      <span className="muted bk-off">Fechado</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="bk-gap bk-choices">
            <Choice label="Intervalo entre horários" value={p.step_min} options={STEPS} text={(m) => duration(m)} onChange={(step_min) => setP({ ...p, step_min })} />
            <Choice label="Folga entre clientes" value={p.buffer_min} options={BUFFERS} text={(m) => (m ? duration(m) : "Nenhuma")} onChange={(buffer_min) => setP({ ...p, buffer_min })} />
            <Choice label="Antecedência mínima" value={p.notice_min} options={NOTICES} text={notice} onChange={(notice_min) => setP({ ...p, notice_min })} />
            <Choice label="Abre a agenda para" value={p.days_ahead} options={AHEAD} text={(n) => `${n} dias`} onChange={(days_ahead) => setP({ ...p, days_ahead })} />
          </div>
          <p className="muted bk-note">
            {data.google
              ? "Seu Google Agenda está conectado: o que estiver ocupado lá não aparece como livre, e o que for marcado vai para lá também."
              : "Compromissos da sua Agenda já bloqueiam o horário. Conecte o Google Agenda para bloquear também o que está lá."}
          </p>
        </div>
      )}

      {tab === "avisos" && (
        <div className="bk-pane">
          <div className="field">
            <span className="bk-label">Seu aviso no WhatsApp</span>
            <div className="seg bk-wrap" role="radiogroup" aria-label="Seu aviso no WhatsApp">
              {OWNER_LEADS.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={p.owner_lead_min === m} className={p.owner_lead_min === m ? "active" : ""} onClick={() => setP({ ...p, owner_lead_min: m })}>
                  {lead(m)}
                </button>
              ))}
            </div>
            <small className="muted">Na hora em que alguém marca você também recebe uma mensagem com nome, WhatsApp e e-mail da pessoa.</small>
          </div>
          <div className="field">
            <span className="bk-label">Lembretes do cliente</span>
            <div className="seg bk-wrap" role="group" aria-label="Lembretes do cliente">
              {CLIENT_LEADS.map((m) => {
                const sel = p.client_leads.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={sel}
                    className={sel ? "active" : ""}
                    disabled={!sel && p.client_leads.length >= 3}
                    onClick={() => setP({ ...p, client_leads: sel ? p.client_leads.filter((x) => x !== m) : [...p.client_leads, m].sort((a, b) => b - a) })}
                  >
                    {lead(m)}
                  </button>
                );
              })}
            </div>
            <small className="muted">
              O cliente recebe a confirmação na hora e os lembretes no WhatsApp, pelo número do Planejai
              {data.google ? ", e também por e-mail pelo seu Gmail, se ele deixar o e-mail." : ". Conectando o Google, vai também por e-mail pelo seu Gmail."} Ele pode desmarcar pelo link da mensagem.
            </small>
          </div>
        </div>
      )}

      {tab === "marcados" && (
        <div className="bk-pane">
          {upcoming.length === 0 ? (
            <div className="bk-empty">
              <span className="bk-card-ico" aria-hidden="true"><Icon name="calendar" size={20} /></span>
              <strong>Ninguém marcou ainda</strong>
              <small className="muted">{p.enabled ? "Quando alguém marcar pelo seu link, aparece aqui e na sua Agenda." : "Abra a página para clientes e cole o link na sua bio."}</small>
            </div>
          ) : (
            <ul className="bk-list">
              {upcoming.map((b) => {
                const s = new Date(b.start_at);
                const off = b.status !== "confirmado";
                return (
                  <li key={b.id} className={off ? "off" : ""}>
                    <div className="bk-when">
                      <strong>{s.toLocaleDateString("pt-BR", { day: "2-digit" })}</strong>
                      <span>{s.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")}</span>
                    </div>
                    <div className="bk-who">
                      <strong>{b.client_name}</strong>
                      <span>
                        {b.service} · {s.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")}, {s.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                        {off ? ` · desmarcado${b.cancelled_by === "cliente" ? " pelo cliente" : ""}` : ""}
                      </span>
                      <span className="bk-contact">
                        <a href={`https://wa.me/${b.client_phone}`} target="_blank" rel="noreferrer">{phoneFmt(b.client_phone)}</a>
                        {b.client_email && <a href={`mailto:${b.client_email}`}>{b.client_email}</a>}
                      </span>
                      {b.note && <span className="bk-noteline">{b.note}</span>}
                    </div>
                    {!off && (
                      <button type="button" className="btn btn-sm" onClick={() => void cancel(b)}>Desmarcar</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function Choice({ label, value, options, text, onChange }: { label: string; value: number; options: number[]; text: (n: number) => string; onChange: (n: number) => void }) {
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <div className="field">
      <label>{label}</label>
      <select className="select" value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {list.map((n) => (
          <option key={n} value={n}>{text(n)}</option>
        ))}
      </select>
    </div>
  );
}
