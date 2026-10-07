import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

/** Calendário no estilo Google Agenda: mês, semana e lista, com os lembretes do assistente e o Google Agenda conectado. */

type Ev = {
  id: string;
  kind: "reminder" | "google";
  reminderId?: string;
  title: string;
  start: string;
  end?: string | null;
  allDay?: boolean;
  recurring?: boolean;
  person?: string | null;
  location?: string | null;
  link?: string | null;
};
type View = "month" | "week" | "list";

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const HOUR_PX = 48;
const FIRST_HOUR = 0;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isPhone = () => matchMedia("(max-width: 767px)").matches;

function monthGrid(anchor: Date) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function CalendarPage({ isSuper }: { isSuper: boolean }) {
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [open, setOpen] = useState<Ev | null>(null);
  const [creating, setCreating] = useState<Date | null>(null);
  const [person, setPerson] = useState("");
  const [phone, setPhone] = useState(isPhone());
  const people = useApi<any[]>(isSuper ? "/api/people" : null);

  useEffect(() => {
    const mq = matchMedia("(max-width: 767px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const weekDays = phone ? 3 : 7;
  const range = useMemo(() => {
    if (view === "month") {
      const g = monthGrid(cursor);
      return { from: g[0]!, to: addDays(g[41]!, 1) };
    }
    if (view === "week") {
      const from = phone ? cursor : addDays(cursor, -cursor.getDay());
      return { from, to: addDays(from, weekDays) };
    }
    return { from: startOfDay(new Date()), to: addDays(startOfDay(new Date()), 45) };
  }, [view, cursor, phone, weekDays]);

  const path = `/api/calendar?from=${range.from.toISOString()}&to=${range.to.toISOString()}${person ? `&user=${person}` : ""}`;
  const { data, error, reload } = useApi<{ events: Ev[] }>(path, { poll: 30000 });
  const events = data?.events ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of events) {
      const k = key(new Date(e.start));
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [events]);

  const step = (dir: number) => {
    haptic(6);
    if (view === "month") setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else if (view === "week") setCursor(addDays(cursor, dir * weekDays));
  };
  const today = () => {
    const t = startOfDay(new Date());
    setCursor(t);
    setSelected(t);
  };

  // arrastar um lembrete para outro dia/horário
  const move = async (ev: Ev, to: Date) => {
    if (ev.kind !== "reminder" || ev.recurring || !ev.reminderId) return;
    try {
      await api(`/api/reminders/${ev.reminderId}`, { method: "PATCH", json: { at: to.toISOString() } });
      haptic(12);
    } catch (e) {
      alert((e as Error).message);
    }
    void reload();
  };

  const title =
    view === "month"
      ? `${cap(MONTHS[cursor.getMonth()]!)} ${cursor.getFullYear()}`
      : view === "week"
        ? weekTitle(range.from, addDays(range.to, -1))
        : "Próximos dias";

  // deslizar para os lados troca o período
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => (swipe.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY });
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!swipe.current || view === "list") return;
    const dx = e.changedTouches[0]!.clientX - swipe.current.x;
    const dy = e.changedTouches[0]!.clientY - swipe.current.y;
    swipe.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  };

  const dayEvents = byDay.get(key(selected)) ?? [];

  return (
    <div className="page cal-page">
      <div className="cal-toolbar">
        <div className="cal-title">
          <h1>{title}</h1>
        </div>
        <div className="cal-nav">
          <button className="icon-btn" aria-label="Anterior" onClick={() => step(-1)} disabled={view === "list"}>
            <Icon name="chevron-left" size={18} />
          </button>
          <button className="btn btn-sm" onClick={today}>Hoje</button>
          <button className="icon-btn" aria-label="Próximo" onClick={() => step(1)} disabled={view === "list"}>
            <Icon name="chevron-right" size={18} />
          </button>
        </div>
        <div className="seg">
          {(["month", "week", "list"] as View[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => { haptic(5); setView(v); if (v === "week") setCursor(selected); }}>
              {v === "month" ? "Mês" : v === "week" ? (phone ? "3 dias" : "Semana") : "Lista"}
            </button>
          ))}
        </div>
        {isSuper && (
          <select className="select cal-person" value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Todas as pessoas</option>
            {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? `+${p.phone}`}</option>)}
          </select>
        )}
        <button className="btn btn-primary cal-new" onClick={() => setCreating(withTime(selected))}>
          <Icon name="plus" size={16} /> <span>Lembrete</span>
        </button>
      </div>
      <ErrorBox error={error} />

      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {view === "month" && (
          <div className="cal-month-wrap">
            <MonthView
              cursor={cursor}
              selected={selected}
              byDay={byDay}
              compact={phone}
              onSelect={(d) => { haptic(5); setSelected(d); }}
              onCreate={(d) => setCreating(withTime(d))}
              onOpen={setOpen}
              onMove={(ev, d) => { const s = new Date(ev.start); d.setHours(s.getHours(), s.getMinutes()); void move(ev, d); }}
            />
            <aside className="card cal-day">
              <div className="cal-day-head">
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>{cap(WEEKDAYS[selected.getDay()]!)}</div>
                  <strong style={{ fontSize: 18 }}>{selected.getDate()} de {MONTHS[selected.getMonth()]}</strong>
                </div>
                <button className="icon-btn" aria-label="Novo lembrete neste dia" onClick={() => setCreating(withTime(selected))}>
                  <Icon name="plus" size={18} />
                </button>
              </div>
              {dayEvents.length ? (
                dayEvents.map((e) => <EventRow key={e.id} ev={e} onOpen={setOpen} />)
              ) : (
                <p className="muted cal-empty">Nada marcado. Toque em + ou peça no WhatsApp: "me lembra amanhã às 9h de ligar pro dentista".</p>
              )}
            </aside>
          </div>
        )}
        {view === "week" && (
          <WeekView from={range.from} days={weekDays} byDay={byDay} onOpen={setOpen} onCreate={(d) => setCreating(d)} onMove={move} />
        )}
        {view === "list" && <ListView from={range.from} byDay={byDay} onOpen={setOpen} />}
      </div>

      {open && <EventDetail ev={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void reload(); }} />}
      {creating && (
        <NewReminder
          at={creating}
          isSuper={isSuper}
          people={people.data ?? []}
          defaultPerson={person}
          onClose={(saved) => { setCreating(null); if (saved) void reload(); }}
        />
      )}
    </div>
  );
}

function withTime(d: Date) {
  const now = new Date();
  const out = new Date(d);
  // hoje: próxima hora cheia; outro dia: 9h
  if (sameDay(d, now)) out.setHours(now.getHours() + 1, 0, 0, 0);
  else out.setHours(9, 0, 0, 0);
  return out;
}

function weekTitle(a: Date, b: Date) {
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} a ${b.getDate()} de ${MONTHS[a.getMonth()]}`;
  return `${a.getDate()} ${MONTHS[a.getMonth()]!.slice(0, 3)} a ${b.getDate()} ${MONTHS[b.getMonth()]!.slice(0, 3)}`;
}

/** Arrastar com mouse na hora ou com o dedo depois de segurar um instante. */
function useDrag(onDrop: (ev: Ev, target: HTMLElement, e: PointerEvent) => void) {
  return (ev: Ev) => (e: React.PointerEvent) => {
    if (ev.kind !== "reminder" || ev.recurring) return;
    const el = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = e.pointerType === "mouse";
    let ghost: HTMLElement | null = null;
    let hover: HTMLElement | null = null;
    const hold = e.pointerType === "mouse" ? null : setTimeout(() => { active = true; haptic(14); begin(); }, 380);
    const begin = () => {
      el.classList.add("dragging");
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("cal-ghost");
      ghost.style.width = `${el.getBoundingClientRect().width}px`;
      document.body.appendChild(ghost);
    };
    const target = (x: number, y: number) =>
      document.elementsFromPoint(x, y).find((n) => (n as HTMLElement).dataset?.drop) as HTMLElement | undefined;
    const onMove = (m: PointerEvent) => {
      if (!active) {
        if (Math.hypot(m.clientX - startX, m.clientY - startY) > 8) {
          if (hold) { clearTimeout(hold); cleanup(); return; }
          active = true;
          begin();
        }
        return;
      }
      m.preventDefault();
      if (ghost) ghost.style.transform = `translate(${m.clientX + 8}px, ${m.clientY + 8}px)`;
      const t = target(m.clientX, m.clientY) ?? null;
      if (t !== hover) {
        hover?.classList.remove("drop-hover");
        t?.classList.add("drop-hover");
        hover = t;
        if (t) haptic(3);
      }
    };
    const onUp = (u: PointerEvent) => {
      if (hold) clearTimeout(hold);
      const t = active ? target(u.clientX, u.clientY) : undefined;
      cleanup();
      if (t) {
        // não abre o detalhe depois de soltar
        el.addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true });
        onDrop(ev, t, u);
      }
    };
    const cleanup = () => {
      el.classList.remove("dragging");
      hover?.classList.remove("drop-hover");
      ghost?.remove();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("touchmove", block);
    };
    // segurou e está arrastando: a página não rola
    const block = (t: TouchEvent) => active && t.cancelable && t.preventDefault();
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
  };
}

function MonthView(p: {
  cursor: Date;
  selected: Date;
  byDay: Map<string, Ev[]>;
  compact: boolean;
  onSelect: (d: Date) => void;
  onCreate: (d: Date) => void;
  onOpen: (e: Ev) => void;
  onMove: (e: Ev, d: Date) => void;
}) {
  const days = monthGrid(p.cursor);
  const today = new Date();
  const drag = useDrag((ev, t) => {
    const [y, m, d] = t.dataset.drop!.split("-").map(Number) as [number, number, number];
    p.onMove(ev, new Date(y, m - 1, d));
  });
  return (
    <div className={`card cal-month ${p.compact ? "compact" : ""}`}>
      {WEEKDAYS.map((w) => <div key={w} className="cal-wd">{p.compact ? w.charAt(0).toUpperCase() : w}</div>)}
      {days.map((d) => {
        const evs = p.byDay.get(key(d)) ?? [];
        const out = d.getMonth() !== p.cursor.getMonth();
        const cls = ["cal-cell", out && "out", sameDay(d, today) && "today", sameDay(d, p.selected) && "sel"].filter(Boolean).join(" ");
        return (
          <div
            key={key(d)}
            className={cls}
            data-drop={key(d)}
            onClick={() => p.onSelect(d)}
            onDoubleClick={() => p.onCreate(d)}
          >
            <span className="cal-num">{d.getDate()}</span>
            {p.compact ? (
              <span className="cal-dots">{evs.slice(0, 3).map((e) => <i key={e.id} className={e.kind} />)}</span>
            ) : (
              <div className="cal-chips">
                {evs.slice(0, 3).map((e) => (
                  <button
                    key={e.id}
                    className={`cal-chip ${e.kind} ${e.recurring ? "rec" : ""}`}
                    onPointerDown={drag(e)}
                    onClick={(c) => { c.stopPropagation(); p.onOpen(e); }}
                    title={e.title}
                  >
                    {!e.allDay && <b>{hhmm(new Date(e.start))}</b>} {e.title}
                  </button>
                ))}
                {evs.length > 3 && <span className="cal-more">+{evs.length - 3}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WeekView(p: { from: Date; days: number; byDay: Map<string, Ev[]>; onOpen: (e: Ev) => void; onCreate: (d: Date) => void; onMove: (e: Ev, d: Date) => void }) {
  const cols = Array.from({ length: p.days }, (_, i) => addDays(p.from, i));
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    scroller.current?.scrollTo({ top: Math.max(0, (Math.min(new Date().getHours(), 20) - 1 - FIRST_HOUR) * HOUR_PX) });
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  const drag = useDrag((ev, t, e) => {
    const [y, m, d] = t.dataset.drop!.split("-").map(Number) as [number, number, number];
    const top = t.getBoundingClientRect().top;
    const minutes = Math.max(0, Math.round(((e.clientY - top) / HOUR_PX) * 4) * 15) + FIRST_HOUR * 60;
    p.onMove(ev, new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60));
  });
  const hours = Array.from({ length: 24 - FIRST_HOUR }, (_, i) => i + FIRST_HOUR);
  const allDay = cols.map((d) => (p.byDay.get(key(d)) ?? []).filter((e) => e.allDay));
  return (
    <div className="card cal-week" style={{ ["--cols" as any]: p.days }}>
      <div className="cal-week-head">
        <span />
        {cols.map((d, i) => (
          <div key={key(d)} className={`cal-week-day ${sameDay(d, now) ? "today" : ""}`}>
            <small>{WEEKDAYS[d.getDay()]}</small>
            <strong>{d.getDate()}</strong>
            {allDay[i]!.map((e) => (
              <button key={e.id} className={`cal-chip ${e.kind}`} onClick={() => p.onOpen(e)}>{e.title}</button>
            ))}
          </div>
        ))}
      </div>
      <div className="cal-week-body" ref={scroller}>
        <div className="cal-hours">
          {hours.map((h) => <div key={h} style={{ height: HOUR_PX }}><span>{h ? `${String(h).padStart(2, "0")}:00` : ""}</span></div>)}
        </div>
        {cols.map((d) => {
          const evs = (p.byDay.get(key(d)) ?? []).filter((e) => !e.allDay);
          return (
            <div
              key={key(d)}
              className="cal-col"
              data-drop={key(d)}
              style={{ height: hours.length * HOUR_PX }}
              onClick={(e) => {
                const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                const minutes = Math.floor(((e.clientY - top) / HOUR_PX) * 2) * 30 + FIRST_HOUR * 60;
                p.onCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(minutes / 60), minutes % 60));
              }}
            >
              {hours.map((h) => <div key={h} className="cal-slot" style={{ height: HOUR_PX }} />)}
              {sameDay(d, now) && <div className="cal-now" style={{ top: ((now.getHours() - FIRST_HOUR) * 60 + now.getMinutes()) * (HOUR_PX / 60) }} />}
              {evs.map((e) => {
                const s = new Date(e.start);
                const end = e.end ? new Date(e.end) : new Date(s.getTime() + 60 * 60000);
                const top = ((s.getHours() - FIRST_HOUR) * 60 + s.getMinutes()) * (HOUR_PX / 60);
                const h = Math.max(30, ((end.getTime() - s.getTime()) / 60000) * (HOUR_PX / 60) - 2);
                return (
                  <button
                    key={e.id}
                    className={`cal-block ${e.kind} ${e.recurring ? "rec" : ""}`}
                    style={{ top, height: h }}
                    onPointerDown={drag(e)}
                    onClick={(c) => { c.stopPropagation(); p.onOpen(e); }}
                  >
                    <b>{hhmm(s)}</b> {e.title}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ from, byDay, onOpen }: { from: Date; byDay: Map<string, Ev[]>; onOpen: (e: Ev) => void }) {
  const days = Array.from({ length: 45 }, (_, i) => addDays(from, i)).filter((d) => byDay.has(key(d)));
  if (!days.length) return <div className="card"><p className="muted cal-empty">Nada nos próximos 45 dias.</p></div>;
  return (
    <div className="cal-list">
      {days.map((d) => (
        <div key={key(d)} className="cal-list-day">
          <div className={`cal-list-date ${sameDay(d, new Date()) ? "today" : ""}`}>
            <strong>{d.getDate()}</strong>
            <small>{WEEKDAYS[d.getDay()]}</small>
          </div>
          <div className="card" style={{ flex: 1, minWidth: 0 }}>
            {byDay.get(key(d))!.map((e) => <EventRow key={e.id} ev={e} onOpen={onOpen} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function EventRow({ ev, onOpen }: { ev: Ev; onOpen: (e: Ev) => void }) {
  const s = new Date(ev.start);
  return (
    <button className="cal-row" onClick={() => onOpen(ev)}>
      <span className="cal-row-time">{ev.allDay ? "dia todo" : hhmm(s)}</span>
      <span className={`cal-bar ${ev.kind}`} />
      <span className="cal-row-text">
        <span className="ellipsis">{ev.title}</span>
        <small className="muted">
          {ev.kind === "google" ? "Google Agenda" : ev.recurring ? "Lembrete recorrente" : "Lembrete"}
          {ev.person ? ` · ${ev.person}` : ""}
        </small>
      </span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

function EventDetail({ ev, onClose, onChanged }: { ev: Ev; onClose: () => void; onChanged: () => void }) {
  const s = new Date(ev.start);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={ev.kind === "google" ? "Evento" : "Lembrete"}
      icon={<Icon name={ev.kind === "google" ? "calendar" : "bell"} />}
      onClose={onClose}
      footer={
        ev.kind === "reminder" ? (
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(ev.recurring ? "Cancelar todas as repetições deste lembrete?" : "Cancelar este lembrete?")) return;
              setBusy(true);
              await api(`/api/reminders/${ev.reminderId}`, { method: "DELETE" });
              onChanged();
            }}
          >
            <Icon name="trash" size={16} /> Cancelar lembrete
          </button>
        ) : ev.link ? (
          <a className="btn" href={ev.link} target="_blank" rel="noreferrer"><Icon name="external" size={16} /> Abrir no Google</a>
        ) : undefined
      }
    >
      <p className="cal-detail-title">{ev.title}</p>
      <dl className="kv">
        <dt>Quando</dt>
        <dd>{cap(s.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }))}{ev.allDay ? ", dia todo" : `, ${hhmm(s)}`}</dd>
        {ev.recurring && (<><dt>Repete</dt><dd>sim, esta é a próxima</dd></>)}
        {ev.person && (<><dt>Pessoa</dt><dd>{ev.person}</dd></>)}
        {ev.location && (<><dt>Local</dt><dd>{ev.location}</dd></>)}
      </dl>
      {ev.kind === "reminder" && !ev.recurring && <p className="muted" style={{ fontSize: 13 }}>Para mudar o horário, arraste o lembrete no calendário (no celular, segure e arraste).</p>}
    </Modal>
  );
}

function NewReminder({ at, isSuper, people, defaultPerson, onClose }: { at: Date; isSuper: boolean; people: any[]; defaultPerson: string; onClose: (saved: boolean) => void }) {
  const [f, setF] = useState({ intent: "", date: key(at), time: hhmm(at), user: defaultPerson });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/reminders", { method: "POST", json: { intent: f.intent, at: `${f.date}T${f.time}`, user: f.user || undefined } });
      haptic(12);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo lembrete"
      icon={<Icon name="bell" />}
      onClose={() => onClose(false)}
      footer={<button className="btn btn-primary" disabled={busy || !f.intent.trim() || (isSuper && !f.user)} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>}
    >
      <ErrorBox error={error} />
      <div className="field">
        <label>O que lembrar</label>
        <textarea className="input" rows={2} value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} placeholder="Ligar para o dentista" />
      </div>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field"><label>Dia</label><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        <div className="field"><label>Hora</label><input className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div>
      </div>
      {isSuper && (
        <div className="field">
          <label>Para quem</label>
          <select className="select" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })}>
            <option value="">Escolha a pessoa</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name ?? `+${p.phone}`}</option>)}
          </select>
        </div>
      )}
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Na hora, o assistente manda a mensagem no WhatsApp do jeito dele, com o contexto.</p>
    </Modal>
  );
}
