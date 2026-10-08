/** Onda que nasce do ponto do toque nos botões (o resto do movimento está em motion.css). */
const RIPPLE = ".btn, .icon-btn, .fab, .more-tile, .cal-fab";

export function installRipple() {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  document.addEventListener(
    "pointerdown",
    (e) => {
      // confere a cada toque: a preferência pode mudar com o app aberto
      if (reduce.matches) return;
      const el = (e.target as Element | null)?.closest?.(RIPPLE) as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2;
      const dot = document.createElement("span");
      dot.className = "pj-ripple";
      dot.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
      el.appendChild(dot);
      dot.addEventListener("animationend", () => dot.remove());
      setTimeout(() => dot.remove(), 900);
    },
    { passive: true },
  );
}
