import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, Modal, alertDialog, confirmDialog } from "../components";
import { DateField, TimeField } from "../pickers";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import {
  CALENDARS,
  EventDetail,
  EventRow,
  ListView,
  MessageDetail,
  MONTHS,
  NewReminder,
  WEEKDAYS,
  WeekView,
  addDays,
  cap,
  hhmm,
  holidays,
  key,
  sameDay,
  startOfDay,
  tagItems,
  weekStart,
  withTime,
  type Ev,
  type Tag,
} from "./Calendar";
import "../styles/agenda-celular.css";

/**
 * Agenda no celular, no jeito do Toki (pedido do David em 2026-10-16): abas Calendário e Lembretes, o mês numa
 * rolagem contínua de cima para baixo com os compromissos escritos em cada dia, "Opções de visualização" numa
 * folha (Agenda, Semana, Mês, tags e agendas com olho) e o compromisso aberto em tela cheia, com atalhos
 * (adiar, avisar antes) e um campo para pedir a mudança ao time pelo chat do Início.
 */

type Mode = "month" | "week" | "list";
type Props = {
  isSuper: boolean;
  hidden: string[];
  onToggle: (k: string) => void;
  owners: { id: string; name: string }[];
  person: string;
  onPerson: (id: string) => void;
};

/** Meses carregados em volta do escolhido: 6 para trás e 12 para frente. */
const BACK = 6;
const AHEAD = 12;
const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Cor de um evento: a da tag, a da agenda ou a do lembrete. */
function evColor(e: Ev) {
  if (e.kind === "reminder") return e.color || "var(--cal-reminder)";
  return e.kind === "google" ? "var(--cal-google)" : e.kind === "message" ? "var(--cal-message)" : "var(--cal-holiday)";
}

export function PhoneAgenda({ isSuper, hidden, onToggle, owners, person, onPerson }: Props) {
  const [tab, setTab] = useState<"cal" | "rem">("cal");
  const [mode, setMode] = useState<Mode>(() => {
    try {
      const m = localStorage.getItem("pj-cal-phone-mode");
      return m === "week" || m === "list" ? m : "month";
    } catch {
      return "month";
    }
  });
  const [center, setCenter] = useState(() => startOfDay(new Date()));
  const [visible, setVisible] = useState(() => startOfDay(new Date()));
  const [weekFrom, setWeekFromRaw] = useState(() => weekStart(new Date()));
  // direção das transições: aba e semana entram do lado de onde vieram; Agenda/Semana/Mês trocam com um esmaecer
  const [enter, setEnter] = useState<"fade" | "left" | "right">("fade");
  const [weekDir, setWeekDir] = useState<"left" | "right">("right");
  const setWeekFrom = (d: Date) => {
    setWeekDir(d < weekFrom ? "left" : "right");
    setWeekFromRaw(d);
  };
  const titleDir = useRef<"up" | "down">("up");
  const [rev, setRev] = useState(0);
  const [open, setOpen] = useState<Ev | null>(null);
  // onde estava o compromisso tocado: a tela dele cresce dali e volta para lá ao fechar
  const [origin, setOrigin] = useState<DOMRect | null>(null);
  const openEv = (e: Ev, from?: Element | null) => {
    haptic(5);
    setOrigin(from ? from.getBoundingClientRect() : null);
    setOpen(e);
  };
  const [editing, setEditing] = useState<Ev | null>(null);
  const [day, setDay] = useState<Date | null>(null);
  const [creating, setCreating] = useState<Date | null>(null);
  const [options, setOptions] = useState(false);
  const [jump, setJump] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [readonly, setReadonly] = useState(false);
  const [googleSeen, setGoogleSeen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const tabsEl = useRef<HTMLDivElement>(null);
  // sublinhado das abas: mais curto que o nome, no meio dele, e desliza ao trocar
  useLayoutEffect(() => {
    const on = tabsEl.current?.querySelector<HTMLElement>("button.on");
    if (!on || !tabsEl.current) return;
    tabsEl.current.style.setProperty("--x", `${on.offsetLeft + on.offsetWidth * 0.22}px`);
    tabsEl.current.style.setProperty("--w", `${on.offsetWidth * 0.56}px`);
  }, [tab]);
  const reload = () => setRev((r) => r + 1);

  const pickMode = (m: Mode) => {
    haptic(5);
    setMode(m);
    setEnter("fade");
    setTab("cal");
    try {
      localStorage.setItem("pj-cal-phone-mode", m);
    } catch {
      /* sem storage */
    }
  };

  // Semana e Agenda (lista) e a aba Lembretes usam um pedido só; o mês carrega por bloco
  const range =
    tab === "rem" || mode === "list"
      ? { from: startOfDay(new Date()), to: addDays(startOfDay(new Date()), 45) }
      : mode === "week"
        ? { from: weekFrom, to: addDays(weekFrom, 7) }
        : null;
  const single = useApi<{ events: Ev[]; readonly?: boolean; tags?: Tag[] }>(
    range ? `/api/calendar?from=${range.from.toISOString()}&to=${range.to.toISOString()}${person ? `&user=${person}` : ""}&r=${rev}` : null,
    { poll: 30000 },
  );
  const meta = (d: { readonly?: boolean; tags?: Tag[]; events: Ev[] }) => {
    setReadonly(Boolean(d.readonly));
    if (d.tags && JSON.stringify(d.tags) !== JSON.stringify(tags)) setTags(d.tags);
    if (d.events.some((e) => e.kind === "google")) setGoogleSeen(true);
  };
  useEffect(() => {
    if (single.data) meta(single.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single.data]);

  const q = search?.trim().toLowerCase() ?? "";
  const keep = (e: Ev) =>
    !hidden.includes(e.kind) && !(e.tag && hidden.includes(`tag:${e.tag}`)) && (!q || `${e.title} ${e.tag ?? ""}`.toLowerCase().includes(q));
  const listByDay = useMemo(() => {
    if (!range) return new Map<string, Ev[]>();
    const years = new Set([range.from.getFullYear(), addDays(range.to, -1).getFullYear()]);
    const hol = tab === "rem" ? [] : [...years].flatMap(holidays).filter((h) => new Date(h.start) >= range.from && new Date(h.start) < range.to);
    return groupByDay(
      [...hol, ...(single.data?.events ?? [])].filter((e) => keep(e) && (tab !== "rem" || e.kind === "reminder" || e.kind === "message")),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single.data, hidden, q, tab, mode, weekFrom]);

  const months = useMemo(() => Array.from({ length: BACK + AHEAD + 1 }, (_, i) => new Date(center.getFullYear(), center.getMonth() - BACK + i, 1)), [center]);

  const scrollToMonth = (d: Date, smooth: boolean) => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-month="${monthKey(d)}"]`);
    if (!el || !box) return false;
    // mês de hoje: a semana de hoje aparece logo abaixo do topo, com um pedaço da anterior (como no Toki)
    const week = sameDay(startOfDay(d), startOfDay(new Date())) ? el.querySelector<HTMLElement>(".pc-day.today")?.closest<HTMLElement>(".pc-week") : null;
    const top = week && week.previousElementSibling?.classList.contains("pc-week") ? week.offsetTop - 64 : el.offsetTop;
    box.scrollTo({ top, behavior: smooth && !reduced() ? "smooth" : "auto" });
    return true;
  };
  // ao abrir (e ao pular para um mês fora da janela), começa no mês certo sem animar
  const pendingJump = useRef<Date | null>(startOfDay(new Date()));
  useLayoutEffect(() => {
    if (mode !== "month" || tab !== "cal" || !pendingJump.current) return;
    if (scrollToMonth(pendingJump.current, false)) pendingJump.current = null;
  });

  // mês do título: o bloco que está no topo da rolagem
  useEffect(() => {
    const box = scroller.current;
    if (!box || mode !== "month" || tab !== "cal") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!top) return;
        const [y, m] = (top.target as HTMLElement).dataset.month!.split("-").map(Number) as [number, number];
        setVisible((v) => {
          if (v.getFullYear() === y && v.getMonth() === m) return v;
          // o nome do mês sobe quando a rolagem vai para frente e desce quando volta
          titleDir.current = y * 12 + m > v.getFullYear() * 12 + v.getMonth() ? "up" : "down";
          return new Date(y, m, 1);
        });
      },
      { root: box, rootMargin: "0px 0px -85% 0px" },
    );
    box.querySelectorAll("[data-month]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [months, mode, tab]);

  const goToday = () => {
    haptic(6);
    const t = startOfDay(new Date());
    if (tab === "rem" || mode === "list") return void scroller.current?.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
    if (mode === "week") return setWeekFrom(weekStart(t));
    if (!scrollToMonth(t, true)) {
      pendingJump.current = t;
      setCenter(t);
    }
    // o dia de hoje dá uma piscada para achar com o olho
    setTimeout(() => {
      const el = scroller.current?.querySelector<HTMLElement>(".pc-day.today .pc-num");
      el?.animate([{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(.34,1.56,.64,1)", delay: 260 });
    }, 0);
  };
  const jumpTo = (d: Date) => {
    setJump(false);
    setTab("cal");
    if (mode === "week") return setWeekFrom(weekStart(d));
    if (mode === "list") pickMode("month");
    const inside = months.some((m) => monthKey(m) === monthKey(d));
    if (inside && scrollToMonth(d, true)) return;
    pendingJump.current = d;
    setCenter(startOfDay(d));
  };

  const create = (d: Date) => {
    if (readonly) return;
    setCreating(withTime(d));
  };
  const calendars = CALENDARS.filter((c) => c.id !== "google" || isSuper || googleSeen);
  const filtered = hidden.length > 0;
  const title =
    tab === "rem"
      ? "Próximos 45 dias"
      : mode === "week"
        ? weekLabel(weekFrom)
        : mode === "list"
          ? "Próximos 45 dias"
          : `${MONTHS[visible.getMonth()]}${visible.getFullYear() !== new Date().getFullYear() ? ` ${visible.getFullYear()}` : ""}`;

  // semana: arrastar para os lados troca a semana
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const bodyKey = tab === "rem" ? "rem" : mode;

  // tela cheia como o chat do Início: sem o cabeçalho do app por trás
  useEffect(() => {
    document.documentElement.classList.add("pj-agenda");
    return () => document.documentElement.classList.remove("pj-agenda");
  }, []);

  return createPortal(
    <div className="pc">
      <header className="pc-head">
        <div className="pc-row">
          <div ref={tabsEl} className="pc-tabs" role="tablist" aria-label="Agenda">
            <button role="tab" aria-selected={tab === "cal"} className={tab === "cal" ? "on" : ""} onClick={() => { haptic(5); if (tab !== "cal") setEnter("left"); setTab("cal"); }}>Calendário</button>
            <button role="tab" aria-selected={tab === "rem"} className={tab === "rem" ? "on" : ""} onClick={() => { haptic(5); if (tab !== "rem") setEnter("right"); setTab("rem"); }}>Lembretes</button>
            <i className="pc-tab-line" aria-hidden="true" />
          </div>
          <span className="spacer" />
          <button className={`pc-ico ${filtered ? "dot" : ""}`} aria-label="Opções de visualização" onClick={() => { haptic(5); setOptions(true); }}>
            <Icon name="sliders" size={22} />
          </button>
          <button className="pc-ico" aria-label={search == null ? "Buscar" : "Fechar a busca"} onClick={() => setSearch(search == null ? "" : null)}>
            <Icon name={search == null ? "search" : "x"} size={22} />
          </button>
        </div>
        {search != null && (
          <input
            className="input pc-search"
            type="search"
            name="q"
            aria-label="Buscar na agenda"
            autoComplete="off"
            enterKeyHint="search"
            autoFocus
            placeholder="Buscar na agenda…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <div className="pc-row pc-row-2">
          {tab === "cal" && mode === "week" && (
            <button className="pc-ico sm" aria-label="Semana anterior" onClick={() => { haptic(5); setWeekFrom(addDays(weekFrom, -7)); }}>
              <Icon name="chevron-left" size={18} />
            </button>
          )}
          <button className="pc-title" aria-label={`${title}: escolher outro mês`} onClick={() => { haptic(5); setJump(true); }}>
            <span key={title} className={`pc-title-txt ${titleDir.current}`}>{title}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7z" fill="currentColor" /></svg>
          </button>
          {tab === "cal" && mode === "week" && (
            <button className="pc-ico sm" aria-label="Próxima semana" onClick={() => { haptic(5); setWeekFrom(addDays(weekFrom, 7)); }}>
              <Icon name="chevron-right" size={18} />
            </button>
          )}
          <span className="spacer" />
          <button className="pc-today" onClick={goToday}>Hoje</button>
        </div>
        {tab === "cal" && mode === "month" && (
          <div className="pc-wd" aria-hidden="true">
            {WEEKDAYS.map((w, i) => <span key={i}>{w.charAt(0).toUpperCase()}</span>)}
          </div>
        )}
      </header>

      <ErrorBox error={single.error} />
      <div
        key={bodyKey}
        ref={scroller}
        className={`pc-body pc-body-${bodyKey} enter-${enter}`}
        onTouchStart={(e) => (swipe.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY })}
        onTouchEnd={(e) => {
          if (!swipe.current || mode !== "week" || tab !== "cal") return;
          const dx = e.changedTouches[0]!.clientX - swipe.current.x;
          const dy = e.changedTouches[0]!.clientY - swipe.current.y;
          swipe.current = null;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            haptic(6);
            setWeekFrom(addDays(weekFrom, dx < 0 ? 7 : -7));
          }
        }}
      >
        {tab === "cal" && mode === "month" &&
          months.map((m) => (
            <MonthBlock
              key={monthKey(m)}
              month={m}
              root={scroller}
              person={person}
              rev={rev}
              keep={keep}
              onMeta={meta}
              onOpen={openEv}
              onDay={(d) => { haptic(5); setDay(d); }}
            />
          ))}
        {tab === "cal" && mode === "week" && range && (
          <div key={key(weekFrom)} className={`pc-slide ${weekDir}`}>
            <WeekView from={range.from} days={7} byDay={listByDay} onOpen={(e) => openEv(e)} onCreate={create} onMove={() => {}} />
          </div>
        )}
        {(tab === "rem" || mode === "list") && range && (
          single.data && !listByDay.size ? (
            <p className="muted pc-empty">{tab === "rem" ? "Nenhum lembrete nos próximos 45 dias. Peça um no WhatsApp ou toque no +." : "Nada nos próximos 45 dias."}</p>
          ) : (
            <ListView from={range.from} byDay={listByDay} onOpen={(e) => openEv(e)} />
          )
        )}
      </div>

      {!readonly &&
        createPortal(
          <button className="cal-fab" aria-label="Novo lembrete" onClick={() => { haptic(10); create(startOfDay(new Date())); }}>
            <Icon name="plus" size={24} />
          </button>,
          document.body,
        )}

      {options && (
        <Modal title="Opções de visualização" onClose={() => setOptions(false)} className="pc-opts">
          <div className="pc-views" role="radiogroup" aria-label="Visualização">
            {([["list", "rows", "Agenda"], ["week", "week", "Semana"], ["month", "calendar", "Mês"]] as [Mode, string, string][]).map(([m, ico, label]) => (
              <button key={m} role="radio" aria-checked={mode === m && tab === "cal"} className={mode === m && tab === "cal" ? "on" : ""} onClick={() => { pickMode(m); setOptions(false); }}>
                <Icon name={ico} size={22} /> <span>{label}</span> {mode === m && tab === "cal" && <Icon name="check" size={20} />}
              </button>
            ))}
          </div>
          {tags.length > 0 && (
            <section className="pc-opt-sec">
              <h4>Categoria</h4>
              <div className="pc-cats">
                {tagItems(tags).map((t) => (
                  <button key={t.id} aria-pressed={!hidden.includes(t.id)} className={hidden.includes(t.id) ? "off" : ""} onClick={() => onToggle(t.id)}>
                    <i style={{ background: t.color }} /> {t.label}
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="pc-opt-sec">
            <h4>Agendas</h4>
            {calendars.map((c) => (
              <button key={c.id} className={`pc-cal ${hidden.includes(c.id) ? "off" : ""}`} aria-pressed={!hidden.includes(c.id)} onClick={() => onToggle(c.id)}>
                <i style={{ background: c.color }} /> <span>{c.label}</span>
                <Icon name={hidden.includes(c.id) ? "eye-off" : "eye"} size={22} />
              </button>
            ))}
          </section>
          {owners.length > 0 && (
            <section className="pc-opt-sec">
              <h4>De quem</h4>
              <select className="select" aria-label="De quem" value={person} onChange={(e) => onPerson(e.target.value)}>
                <option value="">Minha agenda</option>
                {owners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </section>
          )}
        </Modal>
      )}

      {jump && <MonthJump current={mode === "week" ? weekFrom : visible} onPick={jumpTo} onClose={() => setJump(false)} />}

      {day && (
        <DaySheet
          day={day}
          person={person}
          rev={rev}
          keep={keep}
          readonly={readonly}
          onOpen={(e) => { setDay(null); openEv(e); }}
          onCreate={() => { const d = day; setDay(null); create(d); }}
          onClose={() => setDay(null)}
        />
      )}

      {open && open.kind === "message" && <MessageDetail ev={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); reload(); }} />}
      {open && open.kind !== "message" && (
        <EventScreen
          ev={open}
          origin={origin}
          readonly={readonly}
          tags={tags}
          onClose={() => setOpen(null)}
          onEdit={() => setEditing(open)}
          onChanged={(next) => { reload(); if (next) setOpen(next); }}
        />
      )}
      {editing && (
        <EventDetail
          ev={editing}
          tags={tags}
          readonly={readonly}
          onClose={() => setEditing(null)}
          onChanged={() => { setEditing(null); setOpen(null); reload(); }}
        />
      )}
      {creating && <NewReminder at={creating} tags={tags} onClose={(saved) => { setCreating(null); if (saved) reload(); }} />}
    </div>,
    document.body,
  );
}

function groupByDay(evs: Ev[]) {
  const m = new Map<string, Ev[]>();
  for (const e of evs) {
    const k = key(new Date(e.start));
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  for (const [k, list] of m) m.set(k, list.sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.start.localeCompare(b.start)));
  return m;
}

function weekLabel(from: Date) {
  const to = addDays(from, 6);
  return from.getMonth() === to.getMonth()
    ? `${from.getDate()} a ${to.getDate()} de ${MONTHS[from.getMonth()]}`
    : `${from.getDate()} ${MONTHS[from.getMonth()]!.slice(0, 3)} a ${to.getDate()} ${MONTHS[to.getMonth()]!.slice(0, 3)}`;
}

/** Um mês da rolagem: carrega quando chega perto da tela (e fica carregado), semanas com os eventos escritos. */
function MonthBlock(p: {
  month: Date;
  root: React.RefObject<HTMLDivElement | null>;
  person: string;
  rev: number;
  keep: (e: Ev) => boolean;
  onMeta: (d: { readonly?: boolean; tags?: Tag[]; events: Ev[] }) => void;
  onOpen: (e: Ev, from?: Element | null) => void;
  onDay: (d: Date) => void;
}) {
  const el = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root: p.root.current, rootMargin: "900px 0px" });
    io.observe(node);
    return () => io.disconnect();
  }, [near, p.root]);
  const first = p.month;
  const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const { data } = useApi<{ events: Ev[]; readonly?: boolean; tags?: Tag[] }>(
    near ? `/api/calendar?from=${first.toISOString()}&to=${next.toISOString()}${p.person ? `&user=${p.person}` : ""}&r=${p.rev}` : null,
    { poll: 60000 },
  );
  useEffect(() => {
    if (data) p.onMeta(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const byDay = useMemo(() => {
    const hol = holidays(first.getFullYear()).filter((h) => new Date(h.start) >= first && new Date(h.start) < next);
    return groupByDay([...hol, ...(data?.events ?? [])].map((e) => (e.title?.trim() ? e : { ...e, title: "(sem título)" })).filter(p.keep));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, p.keep]);

  // semanas de domingo a sábado; antes do dia 1 fica em branco, como no Toki
  const lead = first.getDay();
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array.from({ length: lead }, () => null), ...Array.from({ length: count }, (_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1))];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const today = new Date();
  return (
    <section ref={el} className="pc-month" data-month={monthKey(first)} aria-label={`${cap(MONTHS[first.getMonth()]!)} de ${first.getFullYear()}`}>
      <h2 className="pc-month-name">
        {MONTHS[first.getMonth()]}
        {first.getFullYear() !== today.getFullYear() && <small> {first.getFullYear()}</small>}
      </h2>
      {weeks.map((w, i) => (
        <div key={i} className="pc-week">
          {w.map((d, j) => {
            if (!d) return <div key={j} className="pc-day empty" />;
            const evs = byDay.get(key(d)) ?? [];
            const shown = evs.length > 4 ? evs.slice(0, 3) : evs;
            return (
              <div
                key={j}
                className={`pc-day ${sameDay(d, today) ? "today" : ""} ${d < startOfDay(today) ? "past" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${d.getDate()} de ${MONTHS[d.getMonth()]}${evs.length ? `, ${evs.length} ${evs.length === 1 ? "evento" : "eventos"}` : ""}`}
                onClick={() => p.onDay(d)}
                onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && p.onDay(d)}
              >
                <span className="pc-num">{d.getDate()}</span>
                {shown.map((e, n) => (
                  <button
                    key={e.id}
                    className={`pc-chip ${e.kind} ${n > 0 ? "line" : ""}`}
                    style={{ ["--ev" as string]: evColor(e), ["--n" as string]: n }}
                    onClick={(c) => { c.stopPropagation(); p.onOpen(e, c.currentTarget); }}
                  >
                    <span className="pc-chip-t">{e.title}</span>
                    {!e.allDay && n === 0 && <small>{hhmm(new Date(e.start)).replace(/^0/, "")}</small>}
                  </button>
                ))}
                {evs.length > shown.length && <span className="pc-more">+{evs.length - shown.length}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

/** Tocar num dia: os eventos dele numa folha e "Novo lembrete" naquele dia. */
function DaySheet(p: { day: Date; person: string; rev: number; keep: (e: Ev) => boolean; readonly: boolean; onOpen: (e: Ev) => void; onCreate: () => void; onClose: () => void }) {
  const from = startOfDay(p.day);
  const { data } = useApi<{ events: Ev[] }>(`/api/calendar?from=${from.toISOString()}&to=${addDays(from, 1).toISOString()}${p.person ? `&user=${p.person}` : ""}&r=${p.rev}`);
  const evs = [...holidays(from.getFullYear()).filter((h) => sameDay(new Date(h.start), from)), ...(data?.events ?? [])]
    .filter(p.keep)
    .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.start.localeCompare(b.start));
  return (
    <Modal
      title={cap(p.day.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }))}
      onClose={p.onClose}
      footer={!p.readonly ? <button className="btn btn-primary" onClick={p.onCreate}><Icon name="plus" size={16} /> Novo lembrete neste dia</button> : undefined}
    >
      {!data ? (
        <p className="muted">Carregando…</p>
      ) : evs.length ? (
        <div className="pc-day-list">{evs.map((e) => <EventRow key={e.id} ev={e} onOpen={p.onOpen} />)}</div>
      ) : (
        <p className="muted">Nada marcado neste dia.</p>
      )}
    </Modal>
  );
}

/** Escolher o mês: o ano com setas e os 12 meses em grade. */
/** "Ir para": ano e 12 meses. Também usada nas Finanças do celular, com `max` (não passa do mês atual). */
export function MonthJump({ current, onPick, onClose, max }: { current: Date; onPick: (d: Date) => void; onClose: () => void; max?: Date }) {
  const [year, setYear] = useState(current.getFullYear());
  const now = new Date();
  return (
    <Modal title="Ir para" onClose={onClose}>
      <div className="pc-jump-year">
        <button className="pc-ico sm" aria-label="Ano anterior" onClick={() => { haptic(5); setYear(year - 1); }}><Icon name="chevron-left" size={18} /></button>
        <strong key={year}>{year}</strong>
        <button className="pc-ico sm" aria-label="Próximo ano" onClick={() => { haptic(5); setYear(year + 1); }}><Icon name="chevron-right" size={18} /></button>
      </div>
      <div className="pc-jump">
        {MONTHS.map((m, i) => (
          <button
            key={m}
            className={`${year === current.getFullYear() && i === current.getMonth() ? "on" : ""} ${year === now.getFullYear() && i === now.getMonth() ? "now" : ""}`}
            disabled={max ? new Date(year, i, 1) > max : false}
            onClick={() => { haptic(5); onPick(new Date(year, i, 1)); }}
          >
            {cap(m.slice(0, 3))}
          </button>
        ))}
      </div>
    </Modal>
  );
}

const leadText = (m: number) => (m === 0 ? "na hora" : m % 1440 === 0 ? `${m / 1440} dia antes` : m % 60 === 0 ? `${m / 60}h antes` : `${m}min antes`);

/** O compromisso em tela cheia, no jeito do Toki: cor dele no topo, quando, aviso, detalhes e atalhos embaixo. */
const LEADS = [0, 10, 30, 60, 1440];
/** Campo de texto que cresce com o conteúdo (título e detalhes editáveis no evento). */
const grow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
};
const leadChip = (m: number) => (m === 0 ? "Na hora" : m % 1440 === 0 ? `${m / 1440} dia antes` : m % 60 === 0 ? `${m / 60} h antes` : `${m} min antes`);

function EventScreen({ ev, origin, readonly, tags, onClose, onEdit, onChanged }: { ev: Ev; origin: DOMRect | null; readonly: boolean; tags: Tag[]; onClose: () => void; onEdit: () => void; onChanged: (next?: Ev) => void }) {
  const sheet = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = new Date(ev.start);
  const e = ev.end ? new Date(ev.end) : null;
  const isReminder = ev.kind === "reminder" && !!ev.reminderId;
  const isGoogle = ev.kind === "google" && ev.id.startsWith("g:");
  const canEdit = !readonly && (isReminder || isGoogle);
  const lead = ev.remindAt ? Math.max(0, Math.round((s.getTime() - new Date(ev.remindAt).getTime()) / 60_000)) : null;
  const suffix = " (criado pelo painel)";
  const details = (ev.intent ?? "").endsWith(suffix) ? ev.intent!.slice(0, -suffix.length) : ev.intent ?? "";
  const today = startOfDay(new Date());
  const dayDiff = Math.round((startOfDay(s).getTime() - today.getTime()) / 86400_000);
  const dayLabel = dayDiff === 0 ? "Hoje" : dayDiff === 1 ? "Amanhã" : dayDiff === -1 ? "Ontem" : cap(s.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, ""));
  const timeLabel = ev.allDay ? "Dia todo" : e && e.getTime() !== s.getTime() ? `${hhmm(s)}-${hhmm(e)}` : hhmm(s);
  const source =
    ev.kind === "google" ? "Google Agenda" : ev.kind === "holiday" ? "Feriado no Brasil" : ev.tag ? ev.tag : ev.remindAt ? "Compromisso" : "Lembrete";

  // Movimento todo por Web Animations e cancelado ao terminar: animação CSS com fill "both" prendia o transform
  // e o puxar para baixo não mexia a folha (o "travando" que o David viu).
  const scrim = useRef<HTMLDivElement>(null);
  const leavingRef = useRef(false);
  const EASE = "cubic-bezier(.32, .72, 0, 1)";
  const clipOf = (r: DOMRect) =>
    `inset(${r.top}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${r.left}px round 8px)`;
  const play = (el: Element | null, frames: Keyframe[], o: KeyframeAnimationOptions) => {
    if (!el || reduced()) return Promise.resolve();
    const a = el.animate(frames, o);
    return a.finished.then(() => a.cancel(), () => {});
  };
  useLayoutEffect(() => {
    const el = sheet.current;
    // abre crescendo a partir do compromisso tocado (como no Toki); sem ele, sobe do pé da tela
    void play(scrim.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease" });
    if (origin) void play(el, [{ clipPath: clipOf(origin), opacity: 0.6 }, { clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 }], { duration: 460, easing: EASE });
    else void play(el, [{ transform: "translate3d(0, 100%, 0)" }, { transform: "none" }], { duration: 440, easing: EASE });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (fromY = 0) => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    const el = sheet.current;
    void play(scrim.current, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease", fill: "forwards" });
    const done =
      origin && !fromY
        ? play(el, [{ clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 }, { clipPath: clipOf(origin), opacity: 0 }], { duration: 320, easing: EASE, fill: "forwards" })
        : play(el, [{ transform: `translate3d(0, ${fromY}px, 0)` }, { transform: "translate3d(0, 100%, 0)" }], { duration: fromY ? 240 : 300, easing: "cubic-bezier(.3, 0, .8, .15)", fill: "forwards" });
    void done.then(onClose);
  };
  useEffect(() => {
    const k = (x: KeyboardEvent) => x.key === "Escape" && close();
    window.addEventListener("keydown", k);
    document.documentElement.classList.add("pc-ev-open");
    return () => {
      window.removeEventListener("keydown", k);
      document.documentElement.classList.remove("pc-ev-open");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // puxar para baixo fecha: só quando o texto está no topo e o dedo vai para baixo (o lado fica para os atalhos).
  // Escuta nativa com passive: false para o iPhone não rolar a página junto enquanto a folha desce.
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    let g: { x: number; y: number; t: number; dy: number; v: number; on: boolean; off: boolean } | null = null;
    const paint = (dy: number) => {
      el.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : "";
      // vira cartão enquanto desce: cantos arredondam aos poucos
      el.style.borderRadius = dy ? `${Math.min(28, dy / 4)}px ${Math.min(28, dy / 4)}px 0 0` : "";
      if (scrim.current) scrim.current.style.opacity = String(Math.max(0, 1 - dy / (innerHeight * 0.9)));
    };
    const down = (x: TouchEvent) => {
      if (leavingRef.current || (x.target as HTMLElement).closest("input, textarea, .pe-chips, .pe-opts")) return;
      const body = el.querySelector(".pe-body");
      g = { x: x.touches[0]!.clientX, y: x.touches[0]!.clientY, t: performance.now(), dy: 0, v: 0, on: false, off: Boolean(body && body.scrollTop > 0) };
    };
    const move = (x: TouchEvent) => {
      if (!g || g.off) return;
      const dx = x.touches[0]!.clientX - g.x;
      const raw = x.touches[0]!.clientY - g.y;
      if (!g.on) {
        if (Math.abs(raw) < 6 && Math.abs(dx) < 6) return;
        // para cima ou de lado: deixa rolar normal
        if (raw <= 0 || Math.abs(dx) > Math.abs(raw)) return void (g.off = true);
        g.on = true;
      }
      x.preventDefault();
      const now = performance.now();
      const dy = Math.max(0, raw);
      g.v = (dy - g.dy) / Math.max(1, now - g.t);
      g.t = now;
      g.dy = dy;
      paint(dy);
    };
    const up = () => {
      if (!g?.on) return void (g = null);
      const { dy, v } = g;
      g = null;
      if (dy > 120 || (v > 0.6 && dy > 30)) {
        haptic(6);
        el.style.transform = "";
        return close(dy);
      }
      // volta para cima com mola curta
      el.style.transform = "";
      el.style.borderRadius = "";
      if (scrim.current) scrim.current.style.opacity = "";
      void play(el, [{ transform: `translate3d(0, ${dy}px, 0)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(.34, 1.3, .64, 1)" });
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up);
    el.addEventListener("touchcancel", up);
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [saved, setSaved] = useState(0);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(0), 1800);
    return () => clearTimeout(t);
  }, [saved]);
  const patch = async (label: string, json: Record<string, unknown>, next?: Partial<Ev>) => {
    setBusy(label);
    setError(null);
    try {
      await api(`/api/reminders/${ev.reminderId}`, { method: "PATCH", json });
      haptic(12);
      setSaved(Date.now());
      onChanged(next ? { ...ev, ...next } : undefined);
    } catch (err) {
      void alertDialog("Não deu para mudar", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const postpone = () => {
    // adia 1 hora a partir do horário dele, ou de agora se já passou
    const base = Math.max(s.getTime(), Date.now());
    const at = new Date(Math.ceil((base + 3600_000) / 300_000) * 300_000);
    const delta = at.getTime() - s.getTime();
    void patch("adiar", { at: at.toISOString() }, {
      start: at.toISOString(),
      end: e ? new Date(e.getTime() + delta).toISOString() : ev.end,
      remindAt: ev.remindAt ? new Date(new Date(ev.remindAt).getTime() + delta).toISOString() : ev.remindAt,
    });
  };
  const notify30 = () =>
    void patch("avisar", { before_min: 30 }, { remindAt: new Date(s.getTime() - 30 * 60_000).toISOString() });

  // pedir a mudança ao time: vai como mensagem no chat do Início, com o compromisso junto
  const send = async () => {
    const text = ask.trim();
    if (!text) return;
    setBusy("ask");
    setError(null);
    try {
      const when = `${s.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}${ev.allDay ? "" : ` às ${hhmm(s)}`}`;
      await api("/api/chat", { method: "POST", json: { text: `Sobre "${ev.title}" (${when}) na minha agenda: ${text}` } });
      haptic(12);
      setAsk("");
      setSent("Pedi ao time. A resposta chega no chat do Início e a agenda atualiza sozinha.");
      setTimeout(() => onChanged(), 9000);
      setTimeout(() => onChanged(), 25000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // editar ali mesmo (pedido do David): cada campo salva sozinho ao sair dele ou ao tocar numa opção
  const inline = isReminder && !readonly;
  const [title, setTitle] = useState(ev.title);
  const [desc, setDesc] = useState(details !== ev.title ? details : "");
  const [newTag, setNewTag] = useState<string | null>(null);
  const saveTitle = () => {
    const t = title.trim();
    if (!t) return setTitle(ev.title);
    if (t === ev.title) return;
    const json: Record<string, unknown> = { title: t };
    // sem detalhes, o próprio título é o texto que o assistente lê na hora do aviso
    if (!desc.trim() && (ev.intent ?? "").endsWith(suffix)) json.intent = t + suffix;
    void patch("titulo", json, { title: t, intent: json.intent ? String(json.intent) : ev.intent });
  };
  const saveDesc = () => {
    const d = desc.trim();
    if (d === (details !== ev.title ? details : "")) return;
    const text = d || title.trim() || ev.title;
    const intent = (ev.intent ?? "").endsWith(suffix) ? text + suffix : text;
    void patch("detalhes", { intent }, { intent });
  };
  const retime = (date: string, time: string) => {
    const at = new Date(`${date}T${time}:00`);
    if (Number.isNaN(at.getTime()) || at.getTime() === s.getTime()) return;
    const delta = at.getTime() - s.getTime();
    void patch("hora", { at: at.toISOString() }, {
      start: at.toISOString(),
      end: e ? new Date(e.getTime() + delta).toISOString() : ev.end,
      remindAt: ev.remindAt ? new Date(new Date(ev.remindAt).getTime() + delta).toISOString() : ev.remindAt,
    });
  };
  const setLead = (m: number) => {
    if (m === lead) return;
    void patch("aviso", { before_min: m }, { remindAt: new Date(s.getTime() - m * 60_000).toISOString() });
  };
  const setTag = (name: string | null, color?: string) => {
    if ((name ?? "") === (ev.tag ?? "")) return;
    void patch("tag", { tag: name }, { tag: name ?? undefined, color: name ? color ?? ev.color : ev.color });
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: ev.recurring ? "Excluir todas as repetições?" : "Excluir este lembrete?",
      body: ev.recurring ? `“${ev.title}” deixa de repetir e nenhum aviso futuro é enviado.` : `“${ev.title}” não será mais enviado no WhatsApp.`,
      confirmLabel: "Excluir",
      cancelLabel: "Manter",
      danger: true,
    });
    if (!ok) return;
    setBusy("excluir");
    try {
      await api(`/api/reminders/${ev.reminderId}`, { method: "DELETE" });
      haptic(12);
      onChanged();
      close();
    } catch (err) {
      setBusy(null);
      void alertDialog("Não deu para excluir", (err as Error).message);
    }
  };
  const leads = lead == null || LEADS.includes(lead) ? LEADS : [...LEADS, lead].sort((a, b) => a - b);

  const future = s.getTime() > Date.now() - 3600_000;
  const chips: { id: string; label: string; run: () => void }[] = [];
  if (isReminder && !ev.recurring && !readonly && future) chips.push({ id: "adiar", label: "Adiar 1 hora", run: postpone });
  if (isReminder && !ev.recurring && !readonly && s.getTime() > Date.now() + 30 * 60_000 && lead !== 30) chips.push({ id: "avisar", label: "Avisar 30 min antes", run: notify30 });
  if (canEdit && !inline) chips.push({ id: "editar", label: "Editar", run: onEdit });
  const link = ev.link;

  return createPortal(
    <div className={`pe-wrap ${leaving ? "leaving" : ""}`} role="dialog" aria-modal="true" aria-label={ev.title}>
      <div ref={scrim} className="pe-scrim" onClick={() => close()} />
      <div ref={sheet} className="pe" style={{ ["--ev" as string]: evColor(ev) }}>
        <div className="pe-top">
          <button className="pc-ico" aria-label="Fechar" onClick={() => close()}><Icon name="x" size={24} /></button>
          <span className="pe-src"><i />{saved ? <span key={saved} className="pe-saved"><Icon name="check" size={15} /> Salvo</span> : source}</span>
          {inline ? (
            <button className="pc-ico" aria-label="Excluir lembrete" disabled={busy != null} onClick={() => void remove()}><Icon name="trash" size={22} /></button>
          ) : canEdit ? (
            <button className="pc-ico" aria-label="Editar ou excluir" onClick={onEdit}><Icon name="more" size={24} /></button>
          ) : (
            <span className="pc-ico" aria-hidden="true" />
          )}
        </div>
        <div className="pe-body">
          <span className="pe-badge" aria-hidden="true"><Icon name={ev.kind === "holiday" ? "sparkle" : ev.kind === "google" ? "calendar" : ev.recurring ? "repeat" : "bell"} size={30} /></span>
          {inline ? (
            <>
              <textarea
                className="pe-title pe-input"
                name="titulo"
                aria-label="Título"
                rows={1}
                maxLength={80}
                enterKeyHint="done"
                value={title}
                ref={grow}
                onChange={(x) => { setTitle(x.target.value); grow(x.target); }}
                onKeyDown={(x) => { if (x.key === "Enter") { x.preventDefault(); x.currentTarget.blur(); } }}
                onBlur={saveTitle}
              />
              {ev.recurring ? (
                <>
                  <p className="pe-when"><span>{dayLabel}</span><i aria-hidden="true" /><span>{timeLabel}</span></p>
                  <p className="pe-when soft">Repete. Para mudar a repetição ou o horário, peça ao time aqui embaixo.</p>
                </>
              ) : (
                <div className="pe-when pe-when-edit">
                  <DateField id="pe-dia" title="Dia" value={key(s)} onChange={(d) => retime(d, hhmm(s))} />
                  <i aria-hidden="true" />
                  <TimeField id="pe-hora" title="Hora" value={hhmm(s)} onChange={(t) => retime(key(s), t)} />
                </div>
              )}
              {!ev.recurring && (
                <div className="pe-opts" role="radiogroup" aria-label="Aviso no WhatsApp">
                  <span className="pe-opts-label"><Icon name="bell" size={15} /> Lembrar</span>
                  {leads.map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={lead === m} className={lead === m ? "on" : ""} disabled={busy != null} onClick={() => { haptic(5); setLead(m); }}>
                      {leadChip(m)}
                    </button>
                  ))}
                </div>
              )}
              {tags.length > 0 || ev.tag ? (
                <div className="pe-opts" role="radiogroup" aria-label="Tag">
                  <span className="pe-opts-label"><Icon name="hash" size={15} /> Tag</span>
                  {tags.map((t) => (
                    <button key={t.name} type="button" role="radio" aria-checked={ev.tag === t.name} className={ev.tag === t.name ? "on" : ""} disabled={busy != null} onClick={() => { haptic(5); setTag(ev.tag === t.name ? null : t.name, t.color); }}>
                      <span className="tag-dot" style={{ background: t.color }} />{t.name}
                    </button>
                  ))}
                  {newTag == null ? (
                    <button type="button" onClick={() => { haptic(5); setNewTag(""); }}><Icon name="plus" size={13} /> Nova</button>
                  ) : (
                    <input
                      className="pe-tag-new"
                      name="tag"
                      aria-label="Nome da nova tag"
                      placeholder="Nome da tag"
                      maxLength={24}
                      autoFocus
                      enterKeyHint="done"
                      value={newTag}
                      onChange={(x) => setNewTag(x.target.value)}
                      onKeyDown={(x) => { if (x.key === "Enter") { x.preventDefault(); x.currentTarget.blur(); } }}
                      onBlur={() => { const n = newTag.trim(); setNewTag(null); if (n) setTag(n); }}
                    />
                  )}
                </div>
              ) : null}
              <textarea
                className="pe-desc pe-input"
                name="detalhes"
                aria-label="Detalhes"
                placeholder="Adicionar detalhes"
                rows={1}
                maxLength={1000}
                value={desc}
                ref={grow}
                onChange={(x) => { setDesc(x.target.value); grow(x.target); }}
                onBlur={saveDesc}
              />
            </>
          ) : (
            <>
            <h2 className="pe-title">{ev.title}</h2>
            <p className="pe-when">
              <span>{dayLabel}</span>
              <i aria-hidden="true" />
              <span>{timeLabel}</span>
            </p>
            {lead != null && <p className="pe-when">Lembrar: {leadText(lead)}{ev.remindAt && !sameDay(new Date(ev.remindAt), s) ? ` (${new Date(ev.remindAt).toLocaleDateString("pt-BR", { day: "numeric", month: "short" })})` : ""}</p>}
            {ev.recurring && <p className="pe-when soft">Repete</p>}
            {details && details !== ev.title && <p className="pe-desc">{details}</p>}
            </>
          )}
          {ev.location && <p className="pe-desc">Local: {ev.location}</p>}
          {ev.person && ev.kind !== "reminder" && <p className="pe-desc">Com {ev.person}</p>}
          <p className="pe-from">{ev.kind === "google" ? "Do seu Google Agenda" : ev.kind === "holiday" ? "Feriado nacional" : "Criado no Planejai"}</p>
          {link && <a className="pe-link" href={link} target="_blank" rel="noreferrer"><Icon name="external" size={15} /> Abrir no Google</a>}
        </div>
        {(chips.length > 0 || canEdit) && (
          <div className="pe-foot">
            {chips.length > 0 && (
              <div className="pe-chips">
                {chips.map((c, i) => (
                  <button key={c.id} style={{ ["--i" as string]: i }} disabled={busy != null} onClick={() => { haptic(6); c.run(); }}>
                    {busy === c.id ? "…" : c.label}
                  </button>
                ))}
              </div>
            )}
            <ErrorBox error={error} />
            {sent && <p className="pe-sent" role="status">{sent}</p>}
            {canEdit && isReminder && (
              <form className="pe-ask" onSubmit={(x) => { x.preventDefault(); void send(); }}>
                <input
                  name="pedido"
                  aria-label="Pedir uma mudança ao time"
                  placeholder="Peça uma mudança ao time"
                  autoComplete="off"
                  enterKeyHint="send"
                  maxLength={500}
                  value={ask}
                  onChange={(x) => setAsk(x.target.value)}
                />
                <button type="submit" aria-label="Enviar" disabled={!ask.trim() || busy != null}><Icon name="send" size={19} /></button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
