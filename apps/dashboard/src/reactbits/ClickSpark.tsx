/*
 * ClickSpark, do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Faíscas saindo do ponto do toque. Adaptado: o desenho só roda enquanto há faísca (nada de quadro parado
 * gastando bateria), o canvas usa a densidade da tela e nada acontece com movimento reduzido.
 */
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

interface ClickSparkProps {
  sparkColor?: string;
  sparkSize?: number;
  sparkRadius?: number;
  sparkCount?: number;
  /** ms */
  duration?: number;
  extraScale?: number;
  className?: string;
  children?: ReactNode;
}

interface Spark {
  x: number;
  y: number;
  angle: number;
  start: number;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeOut = (t: number) => t * (2 - t);

export function ClickSpark({ sparkColor = "#6510e0", sparkSize = 10, sparkRadius = 18, sparkCount = 8, duration = 420, extraScale = 1, className, children }: ClickSparkProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sparks = useRef<Spark[]>([]);
  const raf = useRef(0);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const draw = (now: number) => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    sparks.current = sparks.current.filter((s) => {
      const p = (now - s.start) / duration;
      if (p >= 1) return false;
      const e = easeOut(p);
      const dist = e * sparkRadius * extraScale;
      const len = sparkSize * (1 - e);
      ctx.strokeStyle = sparkColor;
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(s.x + dist * Math.cos(s.angle), s.y + dist * Math.sin(s.angle));
      ctx.lineTo(s.x + (dist + len) * Math.cos(s.angle), s.y + (dist + len) * Math.sin(s.angle));
      ctx.stroke();
      return true;
    });
    raf.current = sparks.current.length ? requestAnimationFrame(draw) : 0;
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const c = canvas.current;
    if (!c || reduced()) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) {
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
    }
    const now = performance.now();
    const x = (e.clientX || r.left + r.width / 2) - r.left;
    const y = (e.clientY || r.top + r.height / 2) - r.top;
    for (let i = 0; i < sparkCount; i++) sparks.current.push({ x, y, angle: (2 * Math.PI * i) / sparkCount, start: now });
    if (!raf.current) raf.current = requestAnimationFrame(draw);
  };

  return (
    <div className={`rb-spark ${className ?? ""}`} onClickCapture={onClick}>
      <canvas ref={canvas} className="rb-spark-canvas" aria-hidden="true" />
      {children}
    </div>
  );
}
