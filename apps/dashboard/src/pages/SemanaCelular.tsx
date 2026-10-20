import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { haptic } from "../touch";
import { addDays, evStyle, hhmm, key, lanes, sameDay, startOfDay, weekStart, type Ev } from "./Calendar";
import { useDrag } from "./arrastar";
import "../styles/agenda-semana-celular.css";

/**
 * Semana no celular no jeito do Calendário da Apple (David, 2026-10-20: "de dois em dois", movimento ao rolar
 * para o lado). Faixa da semana em cima com hoje no círculo roxo e os dias à vista numa pílula; embaixo dois dias
 * por vez (três com o celular deitado) numa rolagem nativa que corre com inércia e para sempre no começo de um dia.
 * Cabeçalho dos dias e coluna das horas ficam presos; a linha do agora corta os dias e a hora aparece na coluna
 * das horas. Os dias vêm numa janela de 12 semanas que se recentra quando a rolagem para perto da ponta.
 */

const HOUR = 52;
const GUT = 52;
/** Janela de dias montada: 12 semanas, começando 6 antes da semana pedida. */
export const WIN = 84;
export const winStartFor = (d: Date) => addDays(weekStart(d), -42);
const LETTERS = ["D", "S", "T", "Q", "Q", "S", "S"];
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
const head = (d: Date) => d.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" });

type Props = {
  win: Date;
  onWin: (d: Date) => void;
  /** pedido de ir até um dia (Hoje, Ir para), com contador para repetir o mesmo dia */
  go: { d: Date; n: number } | null;
  onFirst: (d: Date) => void;
  byDay: Map<string, Ev[]>;
  onOpen: (e: Ev) => void;
  onCreate: (d: Date) => void;
  onMove?: (e: Ev, d: Date) => unknown;
};

export function PhoneWeek(p: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [colW, setColW] = useState(0);
  const [vis, setVis] = useState(2);
  const [first, setFirst] = useState(() => startOfDay(new Date()));
  const firstRef = useRef(first);
  const [now, setNow] = useState(() => new Date());
  const [, bump] = useState(0);
  // para onde rolar depois do próximo desenho (abrir em hoje, Hoje, Ir para, recentrar a janela)
  const pending = useRef<{ d: Date; smooth: boolean } | null>({ d: startOfDay(new Date()), smooth: false });
  const startedY = useRef(false);
  const days = useMemo(() => Array.from({ length: WIN }, (_, i) => addDays(p.win, i)), [p.win]);
  const drag = useDrag({ mode: "time", hourPx: HOUR, firstHour: 0, onDrop: p.onMove });

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // largura dos dias medida na tela: dois por vez no celular em pé, três deitado
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const v = w >= 560 ? 3 : 2;
      const cw = Math.floor((w - GUT) / v);
      setVis(v);
      setColW((old) => {
        if (old && old !== cw) pending.current = { d: firstRef.current, smooth: false };
        return cw;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const report = (d: Date) => {
    if (sameDay(d, firstRef.current)) return;
    firstRef.current = d;
    setFirst(d);
    p.onFirst(d);
  };

  useLayoutEffect(() => {
    const el = box.current;
    const want = pending.current;
    if (!el || !colW) return;
    if (!startedY.current) {
      // abre com a hora de agora perto do topo, como na Apple
      startedY.current = true;
      const n = new Date();
      el.scrollTop = Math.max(0, ((n.getHours() * 60 + n.getMinutes()) / 60) * HOUR - HOUR * 1.6);
    }
    if (!want) return;
    const i = dayDiff(want.d, p.win);
    if (i < 7 || i > WIN - 14) {
      // fora da janela montada: monta outra em volta do dia e rola no próximo desenho
      p.onWin(winStartFor(want.d));
      return;
    }
    pending.current = null;
    const far = Math.abs(dayDiff(want.d, firstRef.current)) > 14;
    el.scrollTo({ left: i * colW, behavior: want.smooth && !far && !reduced() ? "smooth" : "auto" });
    report(startOfDay(want.d));
  });

  useEffect(() => {
    if (!p.go) return;
    pending.current = { d: startOfDay(p.go.d), smooth: true };
    bump((n) => n + 1);
  }, [p.go]);

  // soltou um arrasto (a rolagem pode ter andado de lado sem encaixe): encaixa no dia mais perto
  useEffect(() => {
    const snap = () => {
      const el = box.current;
      if (!el || !colW) return;
      el.scrollTo({ left: Math.round(el.scrollLeft / colW) * colW, behavior: reduced() ? "auto" : "smooth" });
    };
    window.addEventListener("cal-drag-end", snap);
    return () => window.removeEventListener("cal-drag-end", snap);
  }, [colW]);

  const raf = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = box.current;
      if (!el || !colW) return;
      const i = Math.min(WIN - 1, Math.max(0, Math.round(el.scrollLeft / colW)));
      report(days[i]!);
    });
    clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      const el = box.current;
      if (!el || !colW || document.documentElement.classList.contains("cal-dragging")) return;
      const i = Math.round(el.scrollLeft / colW);
      // parou perto da ponta da janela: recentra sem mexer no que está na tela
      if (i < 14 || i > WIN - 14 - vis) {
        pending.current = { d: days[Math.min(WIN - 1, Math.max(0, i))]!, smooth: false };
        p.onWin(winStartFor(pending.current.d));
      }
    }, 180);
  };

  const go = (d: Date) => {
    haptic(5);
    pending.current = { d: startOfDay(d), smooth: true };
    bump((n) => n + 1);
  };

  // faixa da semana: a semana do primeiro dia à vista; a pílula cobre os dias que estão na tela
  const week = addDays(startOfDay(first), -first.getDay());
  const strip = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const shown = strip.map((d) => dayDiff(d, first)).map((x) => x >= 0 && x < vis);
  const a = shown.indexOf(true);
  const b = shown.lastIndexOf(true);
  const lastWeek = useRef(week);
  const dir = week < lastWeek.current ? "left" : week > lastWeek.current ? "right" : "none";
  useEffect(() => {
    lastWeek.current = week;
  });
  const swipe = useRef<{ x: number; y: number } | null>(null);

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todayShown = dayDiff(now, first) >= 0 && dayDiff(now, first) < vis;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const allDay = days.map((d) => (p.byDay.get(key(d)) ?? []).filter((e) => e.allDay));

  return (
    <div className="pw-wrap">
      <div
        className="pw-strip"
        onTouchStart={(e) => (swipe.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY })}
        onTouchEnd={(e) => {
          if (!swipe.current) return;
          const dx = e.changedTouches[0]!.clientX - swipe.current.x;
          const dy = e.changedTouches[0]!.clientY - swipe.current.y;
          swipe.current = null;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) go(addDays(first, dx < 0 ? 7 : -7));
        }}
      >
        <div className="pw-letters" aria-hidden="true">
          {strip.map((d, i) => <span key={i} className={d.getDay() % 6 === 0 ? "we" : ""}>{LETTERS[d.getDay()]}</span>)}
        </div>
        <div key={key(week)} className={`pw-nums ${dir}`}>
          {a >= 0 && <i className="pw-pill" style={{ left: `${(a / 7) * 100}%`, width: `${((b - a + 1) / 7) * 100}%` }} />}
          {strip.map((d, i) => (
            <button
              key={key(d)}
              className={`${sameDay(d, now) ? "today" : ""} ${shown[i] ? "on" : ""} ${d.getDay() % 6 === 0 ? "we" : ""}`}
              aria-label={head(d)}
              aria-current={sameDay(d, now) ? "date" : undefined}
              onClick={() => go(d)}
            >
              <span>{d.getDate()}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        ref={box}
        className="pw"
        onScroll={onScroll}
        style={{ ["--colw" as any]: `${colW}px`, ["--gut" as any]: `${GUT}px`, ["--hour" as any]: `${HOUR}px` }}
      >
        <div className="pw-grid" style={{ gridTemplateColumns: `${GUT}px repeat(${WIN}, ${colW}px)` }}>
          <div className="pw-corner" />
          {days.map((d, i) => (
            <div key={key(d)} className={`pw-head ${sameDay(d, now) ? "today" : ""}`} style={{ gridColumn: i + 2 }}>
              <strong>{head(d).replace(/\.$/, "")}</strong>
              {(Math.abs(i - dayDiff(first, p.win)) <= vis + 1 ? allDay[i]!.slice(0, 2) : []).map((e) => (
                <button key={e.id} className={`cal-chip ${e.kind}`} style={evStyle(e)} title={e.title} onClick={() => p.onOpen(e)}>{e.title}</button>
              ))}
            </div>
          ))}

          <div className="pw-gutter" style={{ height: 24 * HOUR }}>
            {hours.map((h) => (
              <span key={h} className={todayShown && Math.abs(nowMin - h * 60) < 24 ? "hide" : ""} style={{ top: h * HOUR }}>
                {`${String(h).padStart(2, "0")}:00`}
              </span>
            ))}
            {todayShown && <b className="pw-now-tag" style={{ top: (nowMin / 60) * HOUR }}>{hhmm(now)}</b>}
          </div>

          {days.map((d, i) => {
            const isToday = sameDay(d, now);
            const evs = (p.byDay.get(key(d)) ?? []).filter((e) => !e.allDay);
            return (
              <div key={key(d)} className="pw-col" style={{ gridColumn: i + 2 }}>
                <div
                  className="pw-day"
                  data-drop={key(d)}
                  style={{ height: 24 * HOUR }}
                  onClick={(e) => {
                    const top = (e.currentTarget as HTMLElement).getBoundingClientRect().top;
                    const min = Math.min(23 * 60 + 30, Math.max(0, Math.floor(((e.clientY - top) / HOUR) * 2) * 30));
                    p.onCreate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60));
                  }}
                >
                  <div className={`pw-now ${isToday ? "on" : ""}`} style={{ top: (nowMin / 60) * HOUR }} />
                  {lanes(evs).map(({ e, lane, of }) => {
                    const s = new Date(e.start);
                    const end = e.end ? new Date(e.end) : new Date(s.getTime() + 60 * 60000);
                    const top = ((s.getHours() * 60 + s.getMinutes()) / 60) * HOUR;
                    const h = Math.max(28, ((end.getTime() - s.getTime()) / 60000) * (HOUR / 60) - 2);
                    const side = of > 1 ? { left: `calc(${(lane / of) * 100}% + 2px)`, right: "auto", width: `calc(${100 / of}% - 4px)` } : undefined;
                    return (
                      <button
                        key={e.id}
                        className={`cal-block ${e.kind} ${e.recurring ? "rec" : ""} ${h >= 64 ? "tall" : ""}`}
                        style={{ top, height: h, ...side, ...evStyle(e) }}
                        title={`${hhmm(s)} ${e.title}${e.tag ? ` · ${e.tag}` : ""}`}
                        onPointerDown={drag(e)}
                        onClick={(c) => { c.stopPropagation(); p.onOpen(e); }}
                      >
                        <span className="t">{e.title}</span>
                        <small>{hhmm(s)}{e.end && e.kind === "reminder" ? ` a ${hhmm(end)}` : ""}</small>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
