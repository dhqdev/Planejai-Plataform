import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, Modal, alertDialog, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

/**
 * Agenda no estilo Google Agenda: painel lateral (Criar, minicalendário, agendas), mês com número da
 * semana, semana, dia e lista. No celular: pílulas Lista/Dia/Semana/Mês e botão + flutuante.
 * Agendas: lembretes do assistente, Google Agenda conectado e feriados nacionais (calculados aqui, sem API).
 */

type Kind = "reminder" | "google" | "holiday";
type Ev = {
  id: string;
  kind: Kind;
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
type View = "day" | "week" | "month" | "list";

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
/** Semana começa na segunda, como no Google Agenda em português. */
const weekStart = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

function monthGrid(anchor: Date) {
  const start = weekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Número da semana (ISO 8601). */
function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7);
}

/** Feriados nacionais do Brasil (fixos + os que dependem da Páscoa). */
function holidays(year: number): Ev[] {
  // Páscoa (algoritmo de Meeus/Jones/Butcher)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = new Date(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
  const list: [Date, string][] = [
    [new Date(year, 0, 1), "Confraternização Universal"],
    [addDays(easter, -48), "Carnaval"],
    [addDays(easter, -47), "Carnaval"],
    [addDays(easter, -2), "Sexta-feira Santa"],
    [easter, "Páscoa"],
    [new Date(year, 3, 21), "Tiradentes"],
    [new Date(year, 4, 1), "Dia do Trabalho"],
    [addDays(easter, 60), "Corpus Christi"],
    [new Date(year, 8, 7), "Independência do Brasil"],
    [new Date(year, 9, 12), "Nossa Senhora Aparecida"],
    [new Date(year, 10, 2), "Finados"],
    [new Date(year, 10, 15), "Proclamação da República"],
    [new Date(year, 10, 20), "Dia da Consciência Negra"],
    [new Date(year, 11, 25), "Natal"],
  ];
  return list.map(([dt, title]) => ({ id: `h-${key(dt)}-${title}`, kind: "holiday" as const, title, start: dt.toISOString(), allDay: true }));
}

const CALENDARS: { id: Kind; label: string; color: string; group: "mine" | "other" }[] = [
  { id: "reminder", label: "Lembretes", color: "var(--cal-reminder)", group: "mine" },
  { id: "google", label: "Google Agenda", color: "var(--cal-google)", group: "mine" },
  { id: "holiday", label: "Feriados no Brasil", color: "var(--cal-holiday)", group: "other" },
];

function loadHidden(): Kind[] {
  try {
    return JSON.parse(localStorage.getItem("pj-cal-hidden") ?? "[]");
  } catch {
    return [];
  }
}

export function CalendarPage({ isSuper }: { isSuper: boolean }) {
  const [phone, setPhone] = useState(isPhone());
  // no celular a agenda abre em lista (o mês fica a um toque)
  const [view, setView] = useState<View>(() => (isPhone() ? "list" : "month"));
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [open, setOpen] = useState<Ev | null>(null);
  const [creating, setCreating] = useState<Date | null>(null);
  const [person, setPerson] = useState("");
  const [side, setSide] = useState(true);
  const [hidden, setHidden] = useState<Kind[]>(loadHidden);
  const [search, setSearch] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  // particular: a agenda de um contato só aparece se ele compartilhou (e só para ver)
  const shared = useApi<{ withMe: { id: string; name: string; scopes: string[] }[] }>("/api/shares");
  const owners = (shared.data?.withMe ?? []).filter((p) => p.scopes.includes("agenda"));

  useEffect(() => {
    const mq = matchMedia("(max-width: 767px)");
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const toggleCal = (k: Kind) => {
    haptic(5);
    const next = hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k];
    setHidden(next);
    try {
      localStorage.setItem("pj-cal-hidden", JSON.stringify(next));
    } catch {
      /* sem storage */
    }
  };

  const range = useMemo(() => {
    if (view === "month") {
      const g = monthGrid(cursor);
      return { from: g[0]!, to: addDays(g[41]!, 1) };
    }
    if (view === "week") {
      const from = weekStart(cursor);
      return { from, to: addDays(from, 7) };
    }
    if (view === "day") return { from: startOfDay(cursor), to: addDays(startOfDay(cursor), 1) };
    return { from: startOfDay(new Date()), to: addDays(startOfDay(new Date()), 45) };
  }, [view, cursor]);

  const path = `/api/calendar?from=${range.from.toISOString()}&to=${range.to.toISOString()}${person ? `&user=${person}` : ""}`;
  const { data, error, reload } = useApi<{ events: Ev[]; readonly?: boolean }>(path, { poll: 30000 });
  const readonly = Boolean(data?.readonly);
  const create = (d: Date) => { if (!readonly) setCreating(d); };
  const events = useMemo(() => {
    const years = new Set([range.from.getFullYear(), addDays(range.to, -1).getFullYear()]);
    const hol = [...years].flatMap(holidays).filter((h) => {
      const t = new Date(h.start);
      return t >= range.from && t < range.to;
    });
    const q = search?.trim().toLowerCase();
    // evento do Google pode vir sem título
    return [...hol, ...(data?.events ?? [])]
      .map((e) => (e.title?.trim() ? e : { ...e, title: "(sem título)" }))
      .filter((e) => !hidden.includes(e.kind) && (!q || e.title.toLowerCase().includes(q)));
  }, [data, range, hidden, search]);
  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of events) {
      const k = key(new Date(e.start));
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    // dia todo (feriados) primeiro, depois por horário
    for (const [k, list] of m) m.set(k, list.sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.start.localeCompare(b.start)));
    return m;
  }, [events]);

  const step = (dir: number) => {
    haptic(6);
    if (view === "month") setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else if (view === "week") setCursor(addDays(cursor, dir * 7));
    else if (view === "day") {
      setCursor(addDays(cursor, dir));
      setSelected(addDays(cursor, dir));
    }
  };
  const today = () => {
    haptic(6);
    const t = startOfDay(new Date());
    setCursor(t);
    setSelected(t);
  };
  const pick = (d: Date) => {
    haptic(5);
    setSelected(d);
    setCursor(d);
    setPicker(false);
  };
  const changeView = (v: View) => {
    haptic(5);
    setView(v);
    if (v !== "month") setCursor(selected);
  };

  // arrastar um lembrete para outro dia/horário
  const move = async (ev: Ev, to: Date) => {
    if (readonly || ev.kind !== "reminder" || ev.recurring || !ev.reminderId) return;
    try {
      await api(`/api/reminders/${ev.reminderId}`, { method: "PATCH", json: { at: to.toISOString() } });
      haptic(12);
    } catch (e) {
      void alertDialog("Não deu para mover o lembrete", (e as Error).message);
    }
    void reload();
  };

  const title =
    view === "month"
      ? `${cap(MONTHS[cursor.getMonth()]!)} ${phone ? "" : "de "}${cursor.getFullYear()}`
      : view === "week"
        ? weekTitle(range.from, addDays(range.to, -1), phone)
        : view === "day"
          ? cap(cursor.toLocaleDateString("pt-BR", { weekday: phone ? "short" : "long", day: "numeric", month: phone ? "short" : "long" })).replace(/\./g, "")
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

  const VIEWS: [View, string][] = [["list", "Lista"], ["day", "Dia"], ["week", "Semana"], ["month", "Mês"]];
  const calendars = CALENDARS.filter((c) => c.id !== "google" || isSuper || (data?.events ?? []).some((e) => e.kind === "google"));

  return (
    <div className={`page cal-page fit ${side && !phone ? "with-side" : ""}`}>
      {!phone && side && (
        <aside className="cal-side">
          <button className="cal-create" onClick={() => create(withTime(selected))}>
            <Icon name="plus" size={20} /> Criar
          </button>
          <MiniMonth selected={selected} onPick={pick} />
          <CalendarList title="Minhas agendas" items={calendars.filter((c) => c.group === "mine")} hidden={hidden} onToggle={toggleCal} />
          <CalendarList title="Outras agendas" items={calendars.filter((c) => c.group === "other")} hidden={hidden} onToggle={toggleCal} />
          {owners.length > 0 && (
            <div className="cal-side-block">
              <h4>De quem</h4>
              <select className="select" aria-label="De quem" value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">Minha agenda</option>
                {owners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
        </aside>
      )}

      <div className="cal-main">
        {phone ? (
          <div className="cal-bar-top">
            <button className="icon-btn" aria-label="Hoje" onClick={today}><Icon name="calendar" size={20} /></button>
            <button className="icon-btn" aria-label="Anterior" onClick={() => step(-1)} disabled={view === "list"}><Icon name="chevron-left" size={18} /></button>
            <button className="icon-btn" aria-label="Próximo" onClick={() => step(1)} disabled={view === "list"}><Icon name="chevron-right" size={18} /></button>
            <button className="cal-title-btn" aria-expanded={picker} onClick={() => { haptic(5); setPicker((v) => !v); }}>
              <span>{title}</span> <Icon name="chevron-right" size={14} style={{ transform: `rotate(${picker ? -90 : 90}deg)` }} />
            </button>
            <span className="spacer" />
            <button className="icon-btn" aria-label={search == null ? "Buscar" : "Fechar a busca"} onClick={() => setSearch(search == null ? "" : null)}><Icon name={search == null ? "search" : "x"} size={19} /></button>
          </div>
        ) : (
          <div className="cal-bar-top">
            <button className="icon-btn" aria-label="Mostrar ou esconder o painel" onClick={() => setSide((v) => !v)}><Icon name="menu" size={19} /></button>
            <button className="btn btn-pill" onClick={today}>Hoje</button>
            <button className="icon-btn" aria-label="Anterior" onClick={() => step(-1)} disabled={view === "list"}><Icon name="chevron-left" size={18} /></button>
            <button className="icon-btn" aria-label="Próximo" onClick={() => step(1)} disabled={view === "list"}><Icon name="chevron-right" size={18} /></button>
            <h1 className="cal-h1">{title}</h1>
            <span className="spacer" />
            {search != null ? (
              <input className="input cal-search" type="search" name="q" aria-label="Buscar na agenda" autoComplete="off" enterKeyHint="search" autoFocus placeholder="Buscar na agenda…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setSearch(null)} />
            ) : null}
            <button className="icon-btn" aria-label={search == null ? "Buscar" : "Fechar a busca"} onClick={() => setSearch(search == null ? "" : null)}><Icon name={search == null ? "search" : "x"} size={19} /></button>
            <select className="select cal-view" aria-label="Visualização" value={view} onChange={(e) => changeView(e.target.value as View)}>
              {VIEWS.slice().reverse().map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {!side && (
              <button className="btn btn-brand" onClick={() => create(withTime(selected))}><Icon name="plus" size={16} /> Criar</button>
            )}
          </div>
        )}

        {phone && (
          <>
            {search != null && <input className="input cal-search" type="search" name="q" aria-label="Buscar na agenda" autoComplete="off" enterKeyHint="search" autoFocus placeholder="Buscar na agenda…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 10 }} />}
            {picker && (
              <div className="card cal-picker">
                <MiniMonth selected={selected} onPick={pick} />
                <CalendarList title="Agendas" items={calendars} hidden={hidden} onToggle={toggleCal} />
                {owners.length > 0 && (
                  <select className="select" aria-label="De quem" style={{ marginTop: 10 }} value={person} onChange={(e) => setPerson(e.target.value)}>
                    <option value="">Minha agenda</option>
                    {owners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                )}
              </div>
            )}
            <div className="cal-pills">
              {VIEWS.map(([v, l]) => (
                <button key={v} className={view === v ? "active" : ""} onClick={() => changeView(v)}>{l}</button>
              ))}
            </div>
          </>
        )}
        <ErrorBox error={error} />
        {search?.trim() && data && !events.length && view !== "list" && (
          <p className="muted cal-empty" role="status">Nada encontrado para “{search.trim()}” neste período.</p>
        )}

        <div className={`cal-body cal-body-${view}`} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {view === "month" && (
            <MonthView
              cursor={cursor}
              selected={selected}
              byDay={byDay}
              compact={phone}
              onSelect={(d) => {
                haptic(5);
                setSelected(d);
                // no celular, tocar no dia abre o dia (como no Google Agenda)
                if (phone) {
                  setCursor(d);
                  setView("day");
                }
              }}
              onCreate={(d) => create(withTime(d))}
              onOpen={setOpen}
              onMove={(ev, d) => { const s = new Date(ev.start); d.setHours(s.getHours(), s.getMinutes()); void move(ev, d); }}
            />
          )}
          {(view === "week" || view === "day") && (
            <WeekView from={range.from} days={view === "day" ? 1 : 7} byDay={byDay} onOpen={setOpen} onCreate={(d) => create(d)} onMove={move} />
          )}
          {view === "list" && <ListView from={range.from} byDay={byDay} onOpen={setOpen} />}
        </div>
      </div>

      {phone && createPortal(
        <button className="cal-fab" aria-label="Novo lembrete" onClick={() => { haptic(10); create(withTime(selected)); }}>
          <Icon name="plus" size={24} />
        </button>,
        document.body,
      )}

      {open && <EventDetail ev={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void reload(); }} />}
      {creating && (
        <NewReminder
          at={creating}
          onClose={(saved) => { setCreating(null); if (saved) void reload(); }}
        />
      )}
    </div>
  );
}

function CalendarList({ title, items, hidden, onToggle }: { title: string; items: typeof CALENDARS; hidden: Kind[]; onToggle: (k: Kind) => void }) {
  if (!items.length) return null;
  return (
    <div className="cal-side-block">
      <h4>{title}</h4>
      {items.map((c) => (
        <label key={c.id} className="cal-check" style={{ ["--c" as any]: c.color }}>
          <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => onToggle(c.id)} />
          <span className="box"><Icon name="check" size={13} /></span>
          {c.label}
        </label>
      ))}
    </div>
  );
}

function MiniMonth({ selected, onPick }: { selected: Date; onPick: (d: Date) => void }) {
  const [anchor, setAnchor] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  useEffect(() => setAnchor(new Date(selected.getFullYear(), selected.getMonth(), 1)), [selected]);
  const days = monthGrid(anchor);
  const today = new Date();
  return (
    <div className="cal-mini">
      <div className="cal-mini-head">
        <strong>{cap(MONTHS[anchor.getMonth()]!)} de {anchor.getFullYear()}</strong>
        <span className="spacer" />
        <button className="icon-btn sm" aria-label="Mês anterior" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}><Icon name="chevron-left" size={15} /></button>
        <button className="icon-btn sm" aria-label="Próximo mês" onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}><Icon name="chevron-right" size={15} /></button>
      </div>
      <div className="cal-mini-grid">
        {["S", "T", "Q", "Q", "S", "S", "D"].map((w, i) => <span key={i} className="wd">{w}</span>)}
        {days.map((d) => (
          <button
            key={key(d)}
            className={[d.getMonth() !== anchor.getMonth() && "out", sameDay(d, today) && "today", sameDay(d, selected) && "sel"].filter(Boolean).join(" ")}
            onClick={() => onPick(d)}
          >
            {d.getDate()}
          </button>
        ))}
      </div>
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

function weekTitle(a: Date, b: Date, short = false) {
  // no celular o título divide a barra com os botões: mês abreviado
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} a ${b.getDate()} de ${short ? MONTHS[a.getMonth()]!.slice(0, 3) : MONTHS[a.getMonth()]}`;
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

/** Eventos que se cruzam dividem a coluna lado a lado (senão um cobre o outro e some). */
function lanes(evs: Ev[]) {
  const items = evs
    .map((e) => {
      const s = new Date(e.start).getTime();
      return { e, s, end: Math.max(e.end ? new Date(e.end).getTime() : s + 3600000, s + 1800000), lane: 0, of: 1 };
    })
    .sort((a, b) => a.s - b.s || b.end - a.end);
  let group: typeof items = [];
  let groupEnd = -Infinity;
  const closeGroup = () => {
    const n = Math.max(0, ...group.map((i) => i.lane)) + 1;
    for (const i of group) i.of = n;
    group = [];
  };
  for (const it of items) {
    if (it.s >= groupEnd) closeGroup();
    const taken = new Set(group.filter((o) => o.end > it.s).map((o) => o.lane));
    while (taken.has(it.lane)) it.lane++;
    group.push(it);
    groupEnd = group.length === 1 ? it.end : Math.max(groupEnd, it.end);
  }
  closeGroup();
  return items;
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
  const max = p.compact ? 2 : 3;
  const drag = useDrag((ev, t) => {
    const [y, m, d] = t.dataset.drop!.split("-").map(Number) as [number, number, number];
    p.onMove(ev, new Date(y, m - 1, d));
  });
  const weeks = Array.from({ length: 6 }, (_, i) => days.slice(i * 7, i * 7 + 7));
  return (
    <div className={`card cal-month ${p.compact ? "compact" : ""}`}>
      {!p.compact && <div className="cal-wd wk" />}
      {[1, 2, 3, 4, 5, 6, 0].map((w) => <div key={w} className="cal-wd">{p.compact ? WEEKDAYS[w]!.charAt(0).toUpperCase() : `${WEEKDAYS[w]}.`}</div>)}
      {weeks.map((week) => [
        !p.compact && <div key={`w${key(week[0]!)}`} className="cal-wk">{isoWeek(week[0]!)}</div>,
        ...week.map((d) => {
          const evs = p.byDay.get(key(d)) ?? [];
          const out = d.getMonth() !== p.cursor.getMonth();
          const cls = ["cal-cell", out && "out", sameDay(d, today) && "today", sameDay(d, p.selected) && "sel"].filter(Boolean).join(" ");
          return (
            <div key={key(d)} className={cls} data-drop={key(d)} onClick={() => p.onSelect(d)} onDoubleClick={() => p.onCreate(d)}>
              <span className="cal-num">{d.getDate() === 1 && !p.compact ? `1 de ${MONTHS[d.getMonth()]!.slice(0, 3)}` : d.getDate()}</span>
              <div className="cal-chips">
                {evs.slice(0, max).map((e) => (
                  <button
                    key={e.id}
                    className={`cal-chip ${e.kind} ${e.recurring ? "rec" : ""}`}
                    onPointerDown={drag(e)}
                    onClick={(c) => { c.stopPropagation(); p.onOpen(e); }}
                    title={e.title}
                  >
                    {!e.allDay && !p.compact && <b>{hhmm(new Date(e.start))}</b>} {e.title}
                  </button>
                ))}
                {evs.length > max && <span className="cal-more">+{evs.length - max}</span>}
              </div>
            </div>
          );
        }),
      ])}
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
              <button key={e.id} className={`cal-chip ${e.kind}`} title={e.title} onClick={() => p.onOpen(e)}>{e.title}</button>
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
              {lanes(evs).map(({ e, lane, of }) => {
                const s = new Date(e.start);
                const end = e.end ? new Date(e.end) : new Date(s.getTime() + 60 * 60000);
                const top = ((s.getHours() - FIRST_HOUR) * 60 + s.getMinutes()) * (HOUR_PX / 60);
                const h = Math.max(30, ((end.getTime() - s.getTime()) / 60000) * (HOUR_PX / 60) - 2);
                const side = of > 1 ? { left: `calc(${(lane / of) * 100}% + 2px)`, right: "auto", width: `calc(${100 / of}% - 4px)` } : undefined;
                return (
                  <button
                    key={e.id}
                    className={`cal-block ${e.kind} ${e.recurring ? "rec" : ""}`}
                    style={{ top, height: h, ...side }}
                    title={`${hhmm(s)} ${e.title}`}
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
        <span className="ellipsis" title={ev.title}>{ev.title}</span>
        <small className="muted">
          {ev.kind === "google" ? "Google Agenda" : ev.kind === "holiday" ? "Feriado nacional" : ev.recurring ? "Lembrete recorrente" : "Lembrete"}
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
      title={ev.kind === "google" ? "Evento" : ev.kind === "holiday" ? "Feriado" : "Lembrete"}
      icon={<Icon name={ev.kind === "reminder" ? "bell" : "calendar"} />}
      onClose={onClose}
      footer={
        ev.kind === "reminder" ? (
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              const ok = await confirmDialog({
                title: ev.recurring ? "Cancelar todas as repetições?" : "Cancelar este lembrete?",
                body: ev.recurring ? `“${ev.title}” deixa de repetir e nenhum aviso futuro é enviado.` : `“${ev.title}” não será mais enviado no WhatsApp.`,
                confirmLabel: "Cancelar lembrete",
                cancelLabel: "Manter",
                danger: true,
              });
              if (!ok) return;
              setBusy(true);
              try {
                await api(`/api/reminders/${ev.reminderId}`, { method: "DELETE" });
                onChanged();
              } catch (e) {
                setBusy(false);
                void alertDialog("Não deu para cancelar", (e as Error).message);
              }
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

function NewReminder({ at, onClose }: { at: Date; onClose: (saved: boolean) => void }) {
  const [f, setF] = useState({ intent: "", date: key(at), time: hhmm(at) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/reminders", { method: "POST", json: { intent: f.intent, at: `${f.date}T${f.time}` } });
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
      footer={<button className="btn btn-primary" disabled={busy || !f.intent.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>}
    >
      <ErrorBox error={error} />
      <div className="field">
        <label htmlFor="rm-intent">O que lembrar</label>
        <textarea id="rm-intent" name="intent" className="input" rows={2} value={f.intent} onChange={(e) => setF({ ...f, intent: e.target.value })} placeholder="Ligar para o dentista…" />
      </div>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field"><label htmlFor="rm-date">Dia</label><input id="rm-date" name="date" className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        <div className="field"><label htmlFor="rm-time">Hora</label><input id="rm-time" name="time" className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></div>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>Na hora, o assistente manda a mensagem no WhatsApp do jeito dele, com o contexto.</p>
    </Modal>
  );
}
