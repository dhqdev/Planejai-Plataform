import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./components";
import { Icon } from "./icons";
import { haptic } from "./touch";

/*
 * Seletor de dia e de hora do Planejai, no lugar do <input type="date|time"> do navegador.
 * Celular: sobe como folha (o Modal, que já acompanha o dedo e o teclado). iPad e notebook: abre colado no campo.
 * Valor igual ao do input nativo: "AAAA-MM-DD" e "HH:MM" (vazio = sem valor).
 */

const isPhone = () => matchMedia("(max-width: 767px)").matches;
const lessMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const pad = (n: number) => String(n).padStart(2, "0");

/** Data local em "AAAA-MM-DD" (sem passar por UTC, que vira o dia depois das 21h). */
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (v: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Soma meses sem pular de mês (31/01 + 1 mês = 28/02). */
const addMonths = (d: Date, n: number) => {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
};
const sameDay = (a: Date | null, b: Date | null) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const today = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEK = ["D", "S", "T", "Q", "Q", "S", "S"];
const WEEK_FULL = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/** Como o campo mostra o dia escolhido: "Hoje, 12 de out." / "sex., 17 de out." / "3 de mar. de 2027". */
export function dateLabel(v: string) {
  const d = parseDate(v);
  if (!d) return "";
  const t = today();
  const short = d.toLocaleDateString("pt-BR", { day: "numeric", month: "short", ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  const rel = diff === 0 ? "Hoje" : diff === 1 ? "Amanhã" : diff === -1 ? "Ontem" : null;
  if (rel) return `${rel}, ${short}`;
  if (Math.abs(diff) < 180) return `${d.toLocaleDateString("pt-BR", { weekday: "short" })} ${short}`;
  return short;
}

/* ---------- Casca: folha no celular, balão colado no campo no resto ---------- */

type ShellProps = {
  title: string;
  anchor: HTMLElement | null;
  onClose: () => void;
  body: (close: () => void) => ReactNode;
  footer?: (close: () => void) => ReactNode;
  className?: string;
};

function PickerShell(p: ShellProps) {
  const [phone] = useState(isPhone);
  if (phone) {
    return (
      <Modal title={p.title} className={`pk-sheet ${p.className ?? ""}`} onClose={p.onClose} footer={p.footer}>
        {(close) => p.body(close)}
      </Modal>
    );
  }
  return <Popover {...p} />;
}

function Popover({ title, anchor, onClose, body, footer, className }: ShellProps) {
  const box = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const done = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = () => {
    if (done.current) return;
    done.current = true;
    if (lessMotion()) return onCloseRef.current();
    setClosing(true);
    window.setTimeout(() => onCloseRef.current(), 120);
  };

  // abre embaixo do campo; sem espaço, em cima. Nunca sai da tela.
  useLayoutEffect(() => {
    const place = () => {
      const el = box.current;
      if (!el || !anchor) return;
      const r = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
      const below = innerHeight - r.bottom - 8;
      const up = below < h + 6 && r.top > below;
      const top = up ? Math.max(8, r.top - h - 6) : Math.min(r.bottom + 6, Math.max(8, innerHeight - h - 8));
      setPos({ top, left, up });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    const el = box.current!;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    first.focus({ preventScroll: true });
    // Esc fecha só o balão (o Modal por baixo escuta na janela, então paramos antes dele)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // devolve o foco ao campo só quando o balão saiu mesmo da tela
      setTimeout(() => {
        if (!el.isConnected && anchor?.isConnected) anchor.focus({ preventScroll: true });
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab dá a volta dentro do balão
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']")).filter((n) => n.offsetParent !== null);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey ? document.activeElement === first || document.activeElement === box.current : document.activeElement === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  return createPortal(
    <>
      {/* toque fora fecha só o balão: não deixa o clique chegar no fundo do Modal */}
      <div
        className="pk-catch"
        onPointerDown={(e) => {
          e.stopPropagation();
          close();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`card pk-pop ${pos?.up ? "up" : ""} ${closing ? "closing" : ""} ${className ?? ""}`}
        style={pos ? { top: pos.top, left: pos.left } : { opacity: 0, top: 0, left: 0 }}
        onKeyDown={onKeyDown}
      >
        <div className="pk-pop-body">{body(close)}</div>
        {footer && <div className="pk-pop-foot">{footer(close)}</div>}
      </div>
    </>,
    document.body,
  );
}

/* ---------- Dia ---------- */

type Preset = { label: string; date: () => Date | null };
const PRESETS: Record<"agenda" | "passado" | "prazo", Preset[]> = {
  agenda: [
    { label: "Hoje", date: today },
    { label: "Amanhã", date: () => addDays(today(), 1) },
    { label: "Próx. segunda", date: () => addDays(today(), ((8 - today().getDay()) % 7) || 7) },
    { label: "Em 1 semana", date: () => addDays(today(), 7) },
  ],
  passado: [
    { label: "Hoje", date: today },
    { label: "Ontem", date: () => addDays(today(), -1) },
    { label: "Anteontem", date: () => addDays(today(), -2) },
  ],
  prazo: [
    { label: "Em 1 mês", date: () => addMonths(today(), 1) },
    { label: "Em 3 meses", date: () => addMonths(today(), 3) },
    { label: "Em 6 meses", date: () => addMonths(today(), 6) },
    { label: "Em 1 ano", date: () => addMonths(today(), 12) },
  ],
};

type DateFieldProps = {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  /** Título da folha/balão (o rótulo do campo). */
  title?: string;
  placeholder?: string;
  /** Atalhos: dia a dia (padrão), lançamento que já aconteceu ou prazo longo. */
  presets?: keyof typeof PRESETS;
  /** Pode ficar sem dia: mostra "Sem data" nos atalhos. */
  clearable?: boolean;
  min?: string;
  max?: string;
};

export function DateField({ id, value, onChange, title = "Escolher dia", placeholder = "Escolher dia", presets = "agenda", clearable, min, max }: DateFieldProps) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = dateLabel(value);
  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`input pk-field ${label ? "" : "pk-empty"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          haptic(6);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="calendar" size={16} />
        <span>{label || placeholder}</span>
      </button>
      {open && (
        <PickerShell
          title={title}
          anchor={btn.current}
          className="pk-date"
          onClose={() => setOpen(false)}
          body={(close) => (
            <MonthPicker
              value={value}
              min={min}
              max={max}
              presets={PRESETS[presets]}
              clearable={clearable}
              onPick={(v) => {
                haptic(10);
                onChange(v);
                close();
              }}
            />
          )}
        />
      )}
    </>
  );
}

/** As 6 semanas que aparecem num mês (começa no domingo). */
const monthCells = (y: number, m: number) => {
  const first = new Date(y, m, 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
};

function MonthPicker({ value, min, max, presets, clearable, onPick }: { value: string; min?: string; max?: string; presets: Preset[]; clearable?: boolean; onPick: (v: string) => void }) {
  const selected = parseDate(value);
  const minD = parseDate(min);
  const maxD = parseDate(max);
  const start = selected ?? today();
  const [view, setView] = useState({ y: start.getFullYear(), m: start.getMonth() });
  const [focus, setFocus] = useState(start);
  const [mode, setMode] = useState<"days" | "months">("days");
  const [chosen, setChosen] = useState<Date | null>(selected);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const keyNav = useRef(false);
  const busy = useRef(false);
  const swallowClick = useRef(false);
  const wheel = useRef({ x: 0, t: 0 });

  const blocked = (d: Date) => (!!minD && d < minD) || (!!maxD && d > maxD);
  const pick = (d: Date | null) => {
    if (d && blocked(d)) return;
    setChosen(d);
    onPick(d ? isoDate(d) : "");
  };

  // troca de mês deslizando a faixa (anterior | atual | próximo); dir -1 = volta, 1 = avança
  const shift = (dir: -1 | 1, fromPx = 0) => {
    const el = track.current;
    const w = viewport.current?.offsetWidth ?? 0;
    const apply = () => {
      setView((v) => {
        const d = new Date(v.y, v.m + dir, 1);
        return { y: d.getFullYear(), m: d.getMonth() };
      });
      setFocus((f) => addMonths(f, dir));
    };
    if (!el || !w || lessMotion()) {
      apply();
      if (el) el.style.transform = "";
      return;
    }
    busy.current = true;
    const anim = el.animate([{ transform: `translate3d(${-w + fromPx}px, 0, 0)` }, { transform: `translate3d(${-w - dir * w}px, 0, 0)` }], {
      duration: 300,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });
    el.style.transform = `translate3d(${-w - dir * w}px, 0, 0)`;
    anim.onfinish = () => {
      // o React troca o conteúdo e a faixa volta para o meio no mesmo quadro: sem piscar
      apply();
      requestAnimationFrame(() => {
        el.style.transform = "";
        busy.current = false;
      });
    };
  };
  const snapBack = (fromPx: number) => {
    const el = track.current;
    const w = viewport.current?.offsetWidth ?? 0;
    if (!el) return;
    el.style.transform = "";
    if (!lessMotion() && w) el.animate([{ transform: `translate3d(${-w + fromPx}px, 0, 0)` }, { transform: `translate3d(${-w}px, 0, 0)` }], { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
  };

  // arrastar de lado troca o mês (dedo ou mouse). Vertical fica com a folha/página.
  const drag = useRef<{ id: number; x: number; y: number; on: boolean; trail: { t: number; x: number }[] } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (busy.current || e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, trail: [{ t: e.timeStamp, x: e.clientX }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.on) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) return void (drag.current = null);
      if (Math.abs(dx) < 8) return;
      d.on = true;
      d.x = e.clientX;
      viewport.current?.setPointerCapture(e.pointerId);
    }
    const w = viewport.current?.offsetWidth ?? 0;
    const off = e.clientX - d.x;
    if (track.current) track.current.style.transform = `translate3d(${-w + off}px, 0, 0)`;
    d.trail.push({ t: e.timeStamp, x: e.clientX });
    while (d.trail.length > 2 && e.timeStamp - d.trail[0]!.t > 100) d.trail.shift();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on) return;
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 0);
    const off = e.clientX - d.x;
    const a = d.trail[0]!;
    const b = d.trail[d.trail.length - 1]!;
    const v = b.t - a.t > 8 && e.timeStamp - b.t < 80 ? (b.x - a.x) / (b.t - a.t) : 0; // px/ms
    const w = viewport.current?.offsetWidth ?? 1;
    const reach = off + v * 180;
    if (e.type !== "pointercancel" && Math.abs(reach) > w * 0.3) {
      haptic(6);
      shift(reach > 0 ? -1 : 1, off);
    } else snapBack(off);
  };
  // trackpad: rolar de lado também troca o mês
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || busy.current) return;
    const s = wheel.current;
    if (e.timeStamp - s.t > 250) s.x = 0;
    s.t = e.timeStamp;
    s.x += e.deltaX;
    if (Math.abs(s.x) > 60) {
      shift(s.x > 0 ? 1 : -1);
      s.x = 0;
      s.t = e.timeStamp + 400; // um gesto, um mês
    }
  };

  // teclado: setas andam pelos dias, PageUp/PageDown trocam o mês (com Shift, o ano), Home/End vão ao começo e fim da semana
  const onGridKey = (e: React.KeyboardEvent) => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, e.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -focus.getDay()),
      End: () => addDays(focus, 6 - focus.getDay()),
    };
    const go = moves[e.key];
    if (!go) return;
    e.preventDefault();
    const next = go();
    keyNav.current = true;
    setFocus(next);
    setView({ y: next.getFullYear(), m: next.getMonth() });
  };
  useEffect(() => {
    if (!keyNav.current) return;
    keyNav.current = false;
    grid.current?.querySelector<HTMLElement>("[tabindex='0']")?.focus({ preventScroll: true });
  }, [focus]);

  const t = today();
  const renderMonth = (offset: number) => {
    const base = new Date(view.y, view.m + offset, 1);
    const live = offset === 0;
    return (
      <div className="pk-month" key={offset} aria-hidden={!live || undefined} ref={live ? grid : undefined} role={live ? "grid" : undefined} aria-label={live ? `${MONTHS[base.getMonth()]} de ${base.getFullYear()}` : undefined} onKeyDown={live ? onGridKey : undefined}>
        {monthCells(base.getFullYear(), base.getMonth()).map((d) => {
          const out = d.getMonth() !== base.getMonth();
          const tab = live && sameDay(d, focus);
          return (
            <button
              key={d.getTime()}
              type="button"
              role={live ? "gridcell" : undefined}
              tabIndex={tab ? 0 : -1}
              data-autofocus={tab || undefined}
              disabled={blocked(d)}
              className={`pk-day ${out ? "out" : ""} ${sameDay(d, chosen) ? "sel" : ""} ${sameDay(d, t) ? "today" : ""}`}
              aria-selected={live ? sameDay(d, chosen) : undefined}
              aria-current={sameDay(d, t) ? "date" : undefined}
              aria-label={`${WEEK_FULL[d.getDay()]}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`}
              onClick={() => {
                if (swallowClick.current || !live) return;
                setFocus(d);
                pick(d);
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="pk-cal">
      <div className="pk-chips" role="group" aria-label="Atalhos">
        {presets.map((p) => {
          const d = p.date();
          return (
            <button key={p.label} type="button" className={`pk-chip ${sameDay(d, chosen) ? "on" : ""}`} disabled={!!d && blocked(d)} onClick={() => pick(d)}>
              {p.label}
            </button>
          );
        })}
        {clearable && (
          <button type="button" className={`pk-chip ${chosen ? "" : "on"}`} onClick={() => pick(null)}>
            Sem data
          </button>
        )}
      </div>

      <div className="pk-head">
        <button type="button" className="pk-title" aria-expanded={mode === "months"} onClick={() => setMode(mode === "days" ? "months" : "days")}>
          {mode === "days" ? `${MONTHS[view.m]} de ${view.y}` : String(view.y)}
          <Icon name="chevron-right" size={14} className={`pk-caret ${mode === "months" ? "open" : ""}`} />
        </button>
        <span className="spacer" />
        <button type="button" className="icon-btn pk-nav" aria-label={mode === "days" ? "Mês anterior" : "Ano anterior"} onClick={() => (mode === "days" ? shift(-1) : setView((v) => ({ ...v, y: v.y - 1 })))}>
          <Icon name="chevron-left" size={16} />
        </button>
        <button type="button" className="icon-btn pk-nav" aria-label={mode === "days" ? "Próximo mês" : "Próximo ano"} onClick={() => (mode === "days" ? shift(1) : setView((v) => ({ ...v, y: v.y + 1 })))}>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>

      {mode === "months" ? (
        <div className="pk-months" role="group" aria-label={`Meses de ${view.y}`}>
          {MONTHS.map((name, m) => (
            <button
              key={name}
              type="button"
              className={`pk-mo ${view.m === m ? "sel" : ""} ${t.getFullYear() === view.y && t.getMonth() === m ? "today" : ""}`}
              onClick={() => {
                haptic(6);
                setView((v) => ({ ...v, m }));
                setFocus(new Date(view.y, m, Math.min(focus.getDate(), new Date(view.y, m + 1, 0).getDate())));
                setMode("days");
              }}
            >
              {name.slice(0, 3)}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="pk-week" aria-hidden="true">
            {WEEK.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
          <div
            className="pk-viewport"
            ref={viewport}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
          >
            <div className="pk-track" ref={track}>
              {renderMonth(-1)}
              {renderMonth(0)}
              {renderMonth(1)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- Hora ---------- */

const ITEM = 44;
const parseTime = (v: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(v ?? "");
  return m ? { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) } : null;
};
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

type TimeFieldProps = {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  title?: string;
  placeholder?: string;
  /** De quantos em quantos minutos a roda anda (o minuto que já estava no campo continua lá). */
  step?: number;
};

export function TimeField({ id, value, onChange, title = "Escolher hora", placeholder = "Escolher hora", step = 5 }: TimeFieldProps) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const t = parseTime(value);
  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        className={`input pk-field ${t ? "" : "pk-empty"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          haptic(6);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="clock" size={16} />
        <span className="pk-time-val">{t ? hhmm(t.h, t.m) : placeholder}</span>
      </button>
      {open && <TimePicker title={title} anchor={btn.current} value={value} step={step} onChange={onChange} onClose={() => setOpen(false)} />}
    </>
  );
}

function TimePicker({ title, anchor, value, step, onChange, onClose }: { title: string; anchor: HTMLElement | null; value: string; step: number; onChange: (v: string) => void; onClose: () => void }) {
  const start = parseTime(value) ?? (() => {
    const n = new Date(Date.now() + 60 * 60_000);
    return { h: n.getHours(), m: 0 };
  })();
  const [draft, setDraft] = useState(start);
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from(new Set([...Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step), start.m])).sort((a, b) => a - b);
  const commit = (h: number, m: number, close: () => void) => {
    haptic(10);
    onChange(hhmm(h, m));
    close();
  };
  const inAnHour = () => {
    const n = new Date(Date.now() + 60 * 60_000);
    const m = Math.ceil(n.getMinutes() / step) * step;
    return m >= 60 ? { h: (n.getHours() + 1) % 24, m: 0 } : { h: n.getHours(), m };
  };
  const quick = [{ label: "Daqui 1 h", ...inAnHour() }, { label: "08:00", h: 8, m: 0 }, { label: "12:00", h: 12, m: 0 }, { label: "18:00", h: 18, m: 0 }, { label: "21:00", h: 21, m: 0 }];

  return (
    <PickerShell
      title={title}
      anchor={anchor}
      className="pk-timebox"
      onClose={onClose}
      body={(close) => (
        <div className="pk-time">
          <div className="pk-chips" role="group" aria-label="Atalhos">
            {quick.map((q) => (
              <button key={q.label} type="button" className={`pk-chip ${q.h === draft.h && q.m === draft.m ? "on" : ""}`} onClick={() => commit(q.h, q.m, close)}>
                {q.label}
              </button>
            ))}
          </div>
          <div className="pk-wheels">
            <div className="pk-band" aria-hidden="true" />
            <Wheel label="Horas" values={hours} value={draft.h} onChange={(h) => setDraft((d) => ({ ...d, h }))} autoFocus />
            <span className="pk-colon" aria-hidden="true">:</span>
            <Wheel label="Minutos" values={minutes} value={draft.m} onChange={(m) => setDraft((d) => ({ ...d, m }))} />
          </div>
        </div>
      )}
      footer={(close) => (
        <>
          <button type="button" className="btn" onClick={close}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={() => commit(draft.h, draft.m, close)}>
            Pronto · {hhmm(draft.h, draft.m)}
          </button>
        </>
      )}
    />
  );
}

/**
 * Roda de números (como a do iPhone): rolagem nativa com encaixe, então o peteleco tem a inércia do sistema.
 * Mouse arrasta, a rodinha gira, clique num número vai até ele; no teclado é um spinbutton (setas, PageUp/Down, Home/End).
 */
function Wheel({ label, values, value, onChange, autoFocus }: { label: string; values: number[]; value: number; onChange: (v: number) => void; autoFocus?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLElement | null)[]>([]);
  const st = useRef({ raf: 0, timer: 0, last: -1, dragged: false, mouse: null as null | { y: number; top: number; id: number; moved: boolean } });
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const idxOf = (v: number) => Math.max(0, values.indexOf(v));

  // cada número inclina e some conforme se afasta do meio (efeito de cilindro)
  const paint = () => {
    const box = el.current;
    if (!box) return;
    st.current.raf = 0;
    const pos = box.scrollTop / ITEM;
    items.current.forEach((n, i) => {
      if (!n) return;
      const d = i - pos;
      const a = Math.max(-1, Math.min(1, d / 3));
      n.style.transform = `rotateX(${-a * 62}deg) translateZ(0)`;
      n.style.opacity = String(Math.max(0.12, 1 - Math.abs(d) * 0.3));
    });
    const i = Math.round(pos);
    if (i !== st.current.last && i >= 0 && i < values.length) {
      if (st.current.last !== -1) haptic(3);
      st.current.last = i;
    }
  };
  const settle = () => {
    const box = el.current;
    if (!box || st.current.mouse) return;
    const i = Math.max(0, Math.min(values.length - 1, Math.round(box.scrollTop / ITEM)));
    onChangeRef.current(values[i]!);
  };
  const onScroll = () => {
    if (!st.current.raf) st.current.raf = requestAnimationFrame(paint);
    clearTimeout(st.current.timer);
    st.current.timer = window.setTimeout(settle, 140);
  };
  const goTo = (i: number, smooth = true) => {
    const box = el.current;
    if (!box) return;
    const top = Math.max(0, Math.min(values.length - 1, i)) * ITEM;
    box.scrollTo({ top, behavior: smooth && !lessMotion() ? "smooth" : "auto" });
  };

  useLayoutEffect(() => {
    goTo(idxOf(value), false);
    paint();
    if (autoFocus && !isPhone()) el.current?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(st.current.raf);
      clearTimeout(st.current.timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // valor mudou de fora (teclado, atalho): a roda gira até ele
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    if (Math.round(box.scrollTop / ITEM) !== idxOf(value)) goTo(idxOf(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = idxOf(value);
    const to = ({ ArrowUp: i - 1, ArrowDown: i + 1, PageUp: i - 5, PageDown: i + 5, Home: 0, End: values.length - 1 } as Record<string, number>)[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const n = Math.max(0, Math.min(values.length - 1, to));
    onChange(values[n]!);
  };

  // mouse: segurar e arrastar, como no dedo (o toque já é rolagem nativa)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || !el.current) return;
    st.current.mouse = { y: e.clientY, top: el.current.scrollTop, id: e.pointerId, moved: false };
    el.current.classList.add("grabbing");
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const m = st.current.mouse;
    if (!m || !el.current) return;
    if (!m.moved && Math.abs(e.clientY - m.y) > 3) {
      m.moved = true;
      el.current.setPointerCapture(m.id);
    }
    if (m.moved) el.current.scrollTop = m.top - (e.clientY - m.y);
  };
  const onPointerUp = () => {
    const m = st.current.mouse;
    st.current.mouse = null;
    el.current?.classList.remove("grabbing");
    if (m?.moved && el.current) {
      // o clique que vem logo depois de arrastar não conta como "ir até este número"
      st.current.dragged = true;
      setTimeout(() => (st.current.dragged = false), 0);
      goTo(Math.round(el.current.scrollTop / ITEM));
    }
  };

  return (
    <div
      ref={el}
      className="pk-wheel"
      data-no-drag
      role="spinbutton"
      tabIndex={0}
      data-autofocus={autoFocus || undefined}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={values[0]}
      aria-valuemax={values[values.length - 1]}
      aria-valuetext={pad(value)}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="pk-wheel-pad" />
      {values.map((v, i) => (
        <div
          key={v}
          ref={(n) => {
            items.current[i] = n;
          }}
          className={`pk-wheel-item ${v === value ? "sel" : ""}`}
          onClick={() => {
            if (st.current.dragged) return;
            goTo(i);
          }}
        >
          {pad(v)}
        </div>
      ))}
      <div className="pk-wheel-pad" />
    </div>
  );
}
