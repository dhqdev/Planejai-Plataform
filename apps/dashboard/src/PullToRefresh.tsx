import { useEffect, useRef, useState, type RefObject } from "react";
import { refreshAll } from "./hooks";
import { haptic } from "./touch";
import { checkForUpdate } from "./update";

const TRIGGER = 64;
const MAX = 96;

/**
 * Puxar para atualizar no celular/PWA: com a tela no topo, puxe para baixo e solte.
 * Recarrega os dados de todas as telas abertas (sem recarregar a página) e confere se há versão nova.
 */
export function PullToRefresh({ target }: { target: RefObject<HTMLElement | null> }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const st = useRef({ y: 0, active: false, armed: false, pull: 0 });

  useEffect(() => {
    const el = target.current;
    if (!el || !matchMedia("(pointer: coarse)").matches) return;
    const start = (e: TouchEvent) => {
      if (busy || el.scrollTop > 0 || e.touches.length !== 1) return;
      const t = e.target as Element;
      if (t.closest(".modal, .sheet, .more-sheet, .cal-week-body, input, textarea, select, [data-no-ptr]")) return;
      st.current = { y: e.touches[0]!.clientY, active: true, armed: false, pull: 0 };
    };
    const move = (e: TouchEvent) => {
      const s = st.current;
      if (!s.active) return;
      const dy = e.touches[0]!.clientY - s.y;
      if (dy <= 0 || el.scrollTop > 0) {
        if (s.pull) setPull((s.pull = 0));
        return;
      }
      e.preventDefault();
      s.pull = Math.min(MAX, dy * 0.5);
      if (!s.armed && s.pull >= TRIGGER) {
        s.armed = true;
        haptic(10);
      } else if (s.armed && s.pull < TRIGGER) s.armed = false;
      setPull(s.pull);
    };
    const end = async () => {
      const s = st.current;
      if (!s.active) return;
      s.active = false;
      if (s.pull < TRIGGER) return setPull(0);
      setBusy(true);
      setPull(TRIGGER * 0.75);
      const t0 = Date.now();
      await Promise.all([refreshAll(), checkForUpdate()]);
      await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0))));
      setBusy(false);
      setPull(0);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [target, busy]);

  if (!pull && !busy) return null;
  const p = Math.min(1, pull / TRIGGER);
  return (
    <div className={`ptr ${busy ? "busy" : ""} ${st.current.active ? "" : "settle"}`} style={{ transform: `translate(-50%, ${pull - 44}px)`, opacity: Math.max(0.2, p) }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={22} height={22} style={{ transform: busy ? undefined : `rotate(${p * 270}deg)` }}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="url(#ptr-g)" strokeWidth="2.6" strokeLinecap="round" strokeDasharray={`${Math.max(4, p * 44)} 60`} />
        <defs>
          <linearGradient id="ptr-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FF7A1A" />
            <stop offset=".5" stopColor="#FF4458" />
            <stop offset="1" stopColor="#8B2BE2" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}
