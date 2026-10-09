/*
 * CountUp, do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Adaptado: sem motion. Conta com requestAnimationFrame e uma curva de mola amortecida quando aparece na tela;
 * `format` decide o texto (BRL, grãos...) e o último quadro é sempre o valor exato. Movimento reduzido: já mostra o final.
 */
import { useLayoutEffect, useRef } from "react";

interface CountUpProps {
  to: number;
  from?: number;
  /** segundos */
  duration?: number;
  delay?: number;
  /** recomeça a contagem quando muda (ex.: a cena da conversa trocou) */
  replay?: unknown;
  format?: (n: number) => string;
  className?: string;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** mola criticamente amortecida: chega rápido e assenta sem passar do ponto */
const spring = (t: number) => 1 - (1 + 7 * t) * Math.exp(-7 * t);

export function CountUp({ to, from = 0, duration = 1.4, delay = 0, replay, format = (n) => Math.round(n).toLocaleString("pt-BR"), className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const fmt = useRef(format);
  fmt.current = format;

  // layout effect: o número já aparece no primeiro quadro, sem a caixa vazia
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced() || typeof IntersectionObserver === "undefined") {
      el.textContent = fmt.current(to);
      return;
    }
    el.textContent = fmt.current(from);
    let raf = 0;
    let wait: ReturnType<typeof setTimeout>;
    const run = () => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / (duration * 1000));
        el.textContent = fmt.current(t >= 1 ? to : from + (to - from) * Math.min(1, spring(t) / spring(1)));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      wait = setTimeout(run, delay * 1000);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(wait);
      cancelAnimationFrame(raf);
    };
  }, [to, from, duration, delay, replay]);

  return <span className={className} ref={ref} style={{ fontVariantNumeric: "tabular-nums" }} />;
}
