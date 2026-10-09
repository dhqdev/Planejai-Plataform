/*
 * LogoLoop, do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Faixa que corre sem fim: repete a sequência quantas vezes precisar para cobrir a largura e anda com
 * requestAnimationFrame, desacelerando suave ao passar o mouse (ou focar um item). Adaptado: só itens em React (renderItem),
 * só horizontal, para quando sai da tela ou a aba fica escondida, e fica parada com movimento reduzido.
 */
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./reactbits.css";

export interface LogoLoopProps<T> {
  items: T[];
  /** copy > 0 são as repetições (escondidas do leitor de tela; botões nelas devem sair do Tab) */
  renderItem: (item: T, copy: number) => ReactNode;
  itemKey: (item: T) => string;
  /** px por segundo; negativo anda para a direita */
  speed?: number;
  gap?: number;
  pauseOnHover?: boolean;
  /** esmaece as pontas na cor do fundo (--rb-loop-fade) */
  fadeOut?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

const SMOOTH_TAU = 0.25;
const MIN_COPIES = 2;
const COPY_HEADROOM = 2;
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function LogoLoopInner<T>({ items, renderItem, itemKey, speed = 40, gap = 32, pauseOnHover = true, fadeOut = true, ariaLabel, className = "", style }: LogoLoopProps<T>) {
  const box = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const seq = useRef<HTMLUListElement>(null);
  const [seqWidth, setSeqWidth] = useState(0);
  const [copies, setCopies] = useState(MIN_COPIES);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(false);
  const offset = useRef(0);
  const velocity = useRef(0);

  const measure = useCallback(() => {
    const w = seq.current?.getBoundingClientRect().width ?? 0;
    const cw = box.current?.clientWidth ?? 0;
    if (w > 0) {
      setSeqWidth(Math.ceil(w));
      setCopies(Math.max(MIN_COPIES, Math.ceil(cw / w) + COPY_HEADROOM));
    }
  }, []);

  useEffect(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    if (seq.current) ro.observe(seq.current);
    return () => ro.disconnect();
  }, [measure, items, gap]);

  // só anda enquanto aparece (e com a aba visível)
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting && !document.hidden));
    io.observe(el);
    const onVis = () => setVisible(!document.hidden && el.getBoundingClientRect().bottom > 0);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  useEffect(() => {
    const t = track.current;
    if (!t || !visible || seqWidth <= 0 || reduced()) return;
    let raf = 0;
    let last: number | null = null;
    const target = hover && pauseOnHover ? 0 : speed;
    const step = (now: number) => {
      const dt = last === null ? 0 : Math.max(0, now - last) / 1000;
      last = now;
      velocity.current += (target - velocity.current) * (1 - Math.exp(-dt / SMOOTH_TAU));
      offset.current = (((offset.current + velocity.current * dt) % seqWidth) + seqWidth) % seqWidth;
      t.style.transform = `translate3d(${-offset.current}px, 0, 0)`;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [visible, seqWidth, hover, pauseOnHover, speed]);

  return (
    <div
      ref={box}
      className={`rb-loop ${fadeOut ? "rb-loop--fade" : ""} ${className}`}
      style={{ ["--rb-loop-gap" as string]: `${gap}px`, ...style }}
      role="region"
      aria-label={ariaLabel}
    >
      <div
        className="rb-loop-track"
        ref={track}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        {Array.from({ length: copies }, (_, c) => (
          <ul className="rb-loop-list" key={c} aria-hidden={c > 0} ref={c === 0 ? seq : undefined}>
            {items.map((it) => (
              <li className="rb-loop-item" key={itemKey(it)}>
                {renderItem(it, c)}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}

export const LogoLoop = memo(LogoLoopInner) as typeof LogoLoopInner;
