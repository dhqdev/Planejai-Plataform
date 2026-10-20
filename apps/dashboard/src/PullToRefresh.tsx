import { useEffect, useRef, useState, type RefObject } from "react";
import { refreshAll } from "./hooks";
import { haptic } from "./touch";
import { checkForUpdate } from "./update";
import { Mascote, type Mood } from "./mascote/Mascote";
import { useOutfit } from "./mascote/state";

const TRIGGER = 64;
const MAX = 120;
/** o anel em volta do Bolinho (viewBox 52x52) */
const R = 24;
const LEN = 2 * Math.PI * R;

/** Alguma lista com rolagem própria entre o dedo e a tela já desceu? Então puxar é rolar essa lista para cima, não atualizar. */
function innerScrolled(from: Element | null, root: HTMLElement) {
  for (let n = from; n && n !== root; n = n.parentElement) {
    if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight + 1) return true;
  }
  return false;
}

/** puxar fica mais pesado quanto mais desce, como a borracha do iOS */
const resist = (dy: number) => MAX * (1 - Math.exp(-dy / (MAX * 1.4)));

type Phase = "off" | "pull" | "armed" | "busy" | "done";
const MOOD: Record<Phase, Mood> = { off: "idle", pull: "curious", armed: "happy", busy: "working", done: "finished" };

/**
 * Puxar para atualizar no celular/PWA: com a tela no topo, puxe para baixo e solte.
 * O Bolinho desce junto e um anel vai se fechando em volta dele conforme o puxão; fechou, é só soltar.
 * Enquanto recarrega, o anel corre em volta dele. Recarrega os dados de todas as telas abertas
 * (sem recarregar a página) e confere se há versão nova.
 */
export function PullToRefresh({ target }: { target: RefObject<HTMLElement | null> }) {
  const [phase, setPhase] = useState<Phase>("off");
  const [outfit] = useOutfit();
  const box = useRef<HTMLDivElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const st = useRef({ x: 0, y: 0, active: false, locked: false, armed: false, busy: false, pull: 0, from: null as Element | null });

  // posição e anel mexidos direto no DOM: nada de re-render a cada quadro do dedo
  const paint = (pull: number, animate: boolean) => {
    const b = box.current;
    if (b) {
      const p = Math.min(1, pull / TRIGGER);
      b.classList.toggle("settle", animate);
      b.style.transform = `translate(-50%, ${pull - 56}px) scale(${0.7 + 0.3 * p})`;
      b.style.opacity = String(Math.min(1, p * 1.6));
    }
    if (ring.current && !st.current.busy) ring.current.style.strokeDashoffset = String(LEN * (1 - Math.min(1, pull / TRIGGER)));
  };

  useEffect(() => {
    const el = target.current;
    if (!el || !matchMedia("(pointer: coarse)").matches) return;
    const start = (e: TouchEvent) => {
      if (st.current.busy || el.scrollTop > 0 || e.touches.length !== 1) return;
      const t = e.target as Element;
      if (t.closest(".modal, .sheet, .more-sheet, .cal-week-body, input, textarea, select, [contenteditable], [data-no-ptr]")) return;
      if (innerScrolled(t, el)) return;
      Object.assign(st.current, { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, active: true, locked: false, armed: false, pull: 0, from: t });
    };
    const move = (e: TouchEvent) => {
      const s = st.current;
      if (!s.active) return;
      const dy = e.touches[0]!.clientY - s.y;
      // só vale puxar na vertical: um arraste de lado (carrossel de cartões, faixas) que desce um tico não é segurado
      if (!s.locked) {
        const dx = e.touches[0]!.clientX - s.x;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) >= Math.abs(dy) || dy < 0) return void (s.active = false);
        s.locked = true;
      }
      if (dy <= 0 || el.scrollTop > 0 || innerScrolled(s.from, el)) {
        if (s.pull) {
          s.pull = 0;
          paint(0, false);
          setPhase("off");
        }
        return;
      }
      e.preventDefault();
      if (!s.pull) setPhase("pull");
      s.pull = resist(dy);
      if (!s.armed && s.pull >= TRIGGER) {
        s.armed = true;
        haptic(10);
        setPhase("armed");
      } else if (s.armed && s.pull < TRIGGER) {
        s.armed = false;
        setPhase("pull");
      }
      paint(s.pull, false);
    };
    const end = async () => {
      const s = st.current;
      if (!s.active) return;
      s.active = false;
      if (!s.armed) {
        if (s.pull) {
          paint(0, true);
          setTimeout(() => !st.current.active && !st.current.busy && setPhase("off"), 260);
        }
        s.pull = 0;
        return;
      }
      s.busy = true;
      s.armed = false;
      setPhase("busy");
      paint(TRIGGER * 0.8, true);
      const t0 = Date.now();
      await Promise.all([refreshAll(), checkForUpdate()]).catch(() => undefined);
      await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - t0))));
      // terminou: o anel fecha inteiro, o Bolinho sorri e sobe
      setPhase("done");
      await new Promise((r) => setTimeout(r, 380));
      s.busy = false;
      s.pull = 0;
      paint(0, true);
      await new Promise((r) => setTimeout(r, 260));
      if (!st.current.active) setPhase("off");
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
  }, [target]);

  useEffect(() => {
    if (phase === "done" && ring.current) ring.current.style.strokeDashoffset = "0";
  }, [phase]);

  if (phase === "off") return null;
  return (
    <div ref={box} className={`ptr ptr-${phase}`} aria-hidden="true" style={{ opacity: 0, transform: "translate(-50%, -56px) scale(.7)" }}>
      <svg className="ptr-ring" viewBox="0 0 52 52" width={52} height={52}>
        <circle className="ptr-track" cx="26" cy="26" r={R} />
        <circle ref={ring} className="ptr-arc" cx="26" cy="26" r={R} strokeDasharray={LEN} strokeDashoffset={LEN} />
      </svg>
      <Mascote mood={MOOD[phase]} outfit={outfit} size={30} crop />
    </div>
  );
}
