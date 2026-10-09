/*
 * Spotlight, no estilo do Spotlight Card / Dot Grid do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Fundo de pontinhos com uma luz que segue o mouse (variáveis CSS, sem re-render). Só em telas com mouse.
 */
import { useEffect, useRef, type ReactNode } from "react";
import "./reactbits.css";

export function Spotlight({ children, className = "" }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let raf = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        el.style.setProperty("--rb-sx", `${e.clientX - r.left}px`);
        el.style.setProperty("--rb-sy", `${e.clientY - r.top}px`);
        el.style.setProperty("--rb-so", "1");
      });
    };
    const leave = () => el.style.setProperty("--rb-so", "0");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);
  return (
    <div ref={box} className={`rb-spot ${className}`}>
      <span className="rb-spot-dots" aria-hidden="true" />
      <span className="rb-spot-light" aria-hidden="true" />
      {children}
    </div>
  );
}
